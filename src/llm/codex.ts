import type { ChatMessage, ToolDef } from '../types.js'
import type { Config } from '../config.js'
import type { LlmClient } from './client.js'
import { buildResponsesRequest, parseResponsesResponse } from './client.js'
import { log } from '../log.js'
import { sleep } from '../http.js'
import {
  CodexAuthPermanentError,
  CODEX_LOGIN_COMMAND,
  loadCodexAuth,
  needsRefresh,
  refreshCodexTokens,
} from './codexAuth.js'

/**
 * Codex brain client (§12.6) — ChatGPT web-login OAuth credentials + the
 * Responses wire. Reuses the desk's existing Responses request builder and
 * response parser (client.ts) against the ChatGPT backend the CLI itself
 * uses (chatgpt.com/backend-api/codex/responses). Auth is the keyfile's
 * access token as Bearer + the account id header — NO LLM_API_KEY involved.
 *
 * Failure shape: an auth problem fails LOUD with the fix in the message
 * (`npm run desk login`); the desk's safety rails and GLM flip are untouched.
 */
export function createCodexLlmClient(cfg: Config, fetchImpl: typeof fetch = fetch): LlmClient {
  let auth = loadCodexAuth()

  const ensureFresh = async (): Promise<NonNullable<typeof auth>> => {
    auth ??= loadCodexAuth()
    if (auth === undefined) {
      throw new CodexAuthPermanentError(`Codex brain has no keyfile — run: ${CODEX_LOGIN_COMMAND}`)
    }
    if (needsRefresh(auth)) {
      try {
        auth = await refreshCodexTokens(undefined, fetchImpl)
        log.info('codex brain: access token refreshed silently')
      } catch (e) {
        if (e instanceof CodexAuthPermanentError) throw e // loud, fix in message
        throw new Error(`codex brain refresh failed (transient): ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return auth
  }

  return {
    model: cfg.llm.model,
    async complete({ messages, tools: toolDefs, signal: reqSignal }) {
      const tools = toolDefs ?? []
      const { url, body } = buildResponsesRequest(cfg, messages, tools)
      // The ChatGPT Codex backend only serves the Responses protocol as SSE.
      // It also rejects the public API's max_output_tokens parameter. Keep the
      // shared API-key request builder unchanged and adapt only this OAuth lane.
      body['stream'] = true
      delete body['max_output_tokens']
      let refreshedFor401 = false

      for (let attempt = 0; attempt <= 2; attempt++) {
        const current = await ensureFresh()
        let res: Response
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${current.accessToken}`,
              'chatgpt-account-id': current.accountId,
              ...(current.fedramp ? { 'x-openai-fedramp': 'true' } : {}),
            },
            body: JSON.stringify(body),
            signal: reqSignal ?? AbortSignal.timeout(120_000),
          })
        } catch (err) {
          if (err instanceof Error && err.name === 'TimeoutError') throw err
          if (attempt < 2) {
            await sleep(1500 * 2 ** attempt)
            continue
          }
          throw new Error(`codex brain request failed after 3 attempts: ${err instanceof Error ? err.message : String(err)}`)
        }

        if (res.status === 401) {
          // Access token died server-side: one silent refresh + one retry.
          if (refreshedFor401) throw new Error(`codex brain rejected the refreshed token (HTTP 401) — run: ${CODEX_LOGIN_COMMAND}`)
          refreshedFor401 = true
          try {
            auth = await refreshCodexTokens(undefined, fetchImpl)
          } catch (e) {
            if (e instanceof CodexAuthPermanentError) throw e
            throw new Error(`codex brain refresh after 401 failed: ${e instanceof Error ? e.message : String(e)}`)
          }
          continue
        }

        if (res.status === 429 || res.status >= 500) {
          const text = await res.text()
          if (attempt < 2) {
            const retryAfter = res.headers.get('retry-after')
            const waitMs = retryAfter ? Number(retryAfter) * 1000 : 2000 * 2 ** attempt
            log.warn(`codex brain retry ${attempt + 1}: HTTP ${res.status} (waiting ${waitMs}ms)`)
            await sleep(waitMs)
            continue
          }
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`)
        }

        if (!res.ok) {
          const text = await res.text()
          throw new Error(`codex brain HTTP ${res.status}: ${text.slice(0, 500)}`)
        }

        return parseCodexStream(await res.text())
      }
      throw new Error('codex brain request failed after 3 attempts') // unreachable
    },
  }
}

/** Collapse a completed Responses SSE stream into the desk's normal LLM result. */
function parseCodexStream(payload: string): ReturnType<typeof parseResponsesResponse> {
  type ResponsesRaw = Parameters<typeof parseResponsesResponse>[0]
  type OutputItem = NonNullable<ResponsesRaw['output']>[number]
  let completed: ResponsesRaw | undefined
  let text = ''
  const outputItems = new Map<number, OutputItem>()

  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice('data:'.length).trim()
    if (!data || data === '[DONE]') continue

    let event: {
      type?: string
      response?: ResponsesRaw
      error?: { message?: string }
      message?: string
      delta?: string
      arguments?: string
      output_index?: number
      item?: OutputItem
    }
    try {
      event = JSON.parse(data) as typeof event
    } catch {
      throw new Error('codex brain returned malformed SSE data')
    }

    if (event.type === 'error') {
      throw new Error(`LLM error: ${event.error?.message ?? event.message ?? 'unknown'}`)
    }
    if (event.type === 'response.output_text.delta') {
      text += event.delta ?? ''
    }
    if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item) {
      outputItems.set(event.output_index ?? outputItems.size, event.item)
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const index = event.output_index ?? 0
      const item = outputItems.get(index)
      if (item) item.arguments = `${item.arguments ?? ''}${event.delta ?? ''}`
    }
    if (event.type === 'response.function_call_arguments.done') {
      const item = outputItems.get(event.output_index ?? 0)
      if (item && event.arguments !== undefined) item.arguments = event.arguments
    }
    if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      completed = event.response
    }
  }

  if (completed === undefined) {
    throw new Error('codex brain stream ended without a completed response')
  }
  if (!completed.output || completed.output.length === 0) {
    completed.output = [...outputItems.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item)
    if (text && !completed.output.some((item) => item.type === 'message')) {
      completed.output.push({ type: 'message', content: [{ type: 'output_text', text }] })
    }
  }
  return parseResponsesResponse(completed)
}

import type { ChatMessage, ToolDef } from '../types.js'
import type { Config } from '../config.js'
import { log } from '../log.js'
import { sleep } from '../http.js'

export type CompleteResult = {
  message: ChatMessage & { role: 'assistant' }
  usage?: { in: number; out: number }
}

export interface LlmClient {
  readonly model: string
  complete(req: {
    messages: ChatMessage[]
    tools: ToolDef[]
    signal?: AbortSignal
  }): Promise<CompleteResult>
}

type RawResponse = {
  choices?: Array<{
    message?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
      reasoning_content?: string | null
    }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

/**
 * Provider-agnostic OpenAI-compatible client (raw fetch — swappable brain).
 * Two wire formats, chosen by provider:
 *  - 'chat'      → POST /chat/completions  (zai, openai chat models, ollama, …)
 *  - 'responses' → POST /responses          (OpenAI Codex models — chat/completions
 *                                             404s on every codex-* model)
 * Normalizes provider quirks in ONE place:
 *  - `reasoning_content` (GLM/others) is carried but never sent back as content
 *  - tool calls whose `arguments` are not valid JSON are kept as-is; the loop
 *    handles the parse error as a tool result so the model can retry
 *  - some models put a JSON tool-call payload in `content`; we try to promote it
 */
export function createLlmClient(cfg: Config): LlmClient {
  if (!cfg.llm.apiKey && cfg.llm.provider !== 'ollama' && !isLocal(cfg.llm.baseUrl)) {
    throw new Error('LLM_API_KEY required for remote providers')
  }
  const wire: 'chat' | 'responses' = cfg.llm.provider === 'codex' ? 'responses' : 'chat'

  return {
    model: cfg.llm.model,
    async complete({ messages, tools: toolDefs, signal: reqSignal }) {
      const tools = toolDefs ?? []
      const { url, body } =
        wire === 'responses'
          ? buildResponsesRequest(cfg, messages, tools)
          : buildChatRequest(cfg, messages, tools)
      let lastErr = 'unknown'

      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cfg.llm.apiKey ? { authorization: `Bearer ${cfg.llm.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: reqSignal ?? AbortSignal.timeout(120_000),
          })

          if (!res.ok) {
            const text = await res.text()
            if (res.status === 429 || res.status >= 500) {
              const retryAfter = res.headers.get('retry-after')
              lastErr = `HTTP ${res.status}: ${text.slice(0, 300)}`
              if (attempt < 2) {
                const waitMs = retryAfter ? Number(retryAfter) * 1000 : 2000 * 2 ** attempt
                log.warn(`llm retry ${attempt + 1}: ${lastErr} (waiting ${waitMs}ms)`)
                await sleep(waitMs)
                continue
              }
            }
            throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`)
          }

          const raw = (await res.json()) as RawResponse
          if (raw.error) throw new Error(`LLM error: ${raw.error.message ?? 'unknown'}`)

          if (wire === 'responses') return parseResponsesResponse(raw as unknown as ResponsesRaw)
          const choice = raw.choices?.[0]?.message
          if (!choice) throw new Error('LLM response had no choices[0].message')
          return {
            message: normalizeAssistant(choice),
            usage: raw.usage
              ? {
                  in: raw.usage.prompt_tokens ?? 0,
                  out: raw.usage.completion_tokens ?? 0,
                }
              : undefined,
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('LLM ')) throw err
          if (err instanceof Error && err.name === 'TimeoutError') throw err
          lastErr = err instanceof Error ? err.message : String(err)
          if (attempt < 2) {
            await sleep(1500 * 2 ** attempt)
            continue
          }
          throw new Error(`LLM request failed after 3 attempts: ${lastErr}`)
        }
      }
      throw new Error(lastErr) // unreachable
    },
  }
}

// ── Wire format: chat completions (default) ─────────────────────────────────

export function buildChatRequest(
  cfg: Config,
  messages: ChatMessage[],
  tools: ToolDef[],
): { url: string; body: Record<string, unknown> } {
  return {
    url: `${cfg.llm.baseUrl}/chat/completions`,
    body: {
      model: cfg.llm.model,
      messages: messages.map(sanitizeForProvider),
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? ('auto' as const) : undefined,
      temperature: cfg.llm.temperature,
      max_tokens: cfg.llm.maxTokens,
      stream: false,
    },
  }
}

function isLocal(baseUrl: string): boolean {
  return baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost')
}

/** Never echo provider-only fields back; strip unknown props so strict endpoints accept it. */
function sanitizeForProvider(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant') {
    const out: Record<string, unknown> = { role: 'assistant', content: m.content }
    if (m.tool_calls) out['tool_calls'] = m.tool_calls
    return out
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
  }
  // User images (vision brains): data URIs ride on the message and explode to
  // OpenAI-style content parts ONLY at the wire — everywhere else in the desk
  // (threads, journals, transcripts) the message stays plain text.
  if (m.role === 'user' && m.images !== undefined && m.images.length > 0) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: m.content },
        ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    }
  }
  return { role: m.role, content: m.content }
}

type ChoiceMessage = {
  role?: string
  content?: string | null
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
  reasoning_content?: string | null
}

function normalizeAssistant(
  choice: ChoiceMessage,
): ChatMessage & { role: 'assistant' } {
  const toolCalls =
    choice.tool_calls?.flatMap((tc) => {
      const name = tc.function?.name
      if (!name) return []
      return [
        {
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function' as const,
          function: { name, arguments: tc.function?.arguments ?? '{}' },
        },
      ]
    }) ?? undefined

  let content: string | null = choice.content ?? null

  // GLM quirk: tool call delivered as JSON inside content — promote it.
  if (!toolCalls && content && content.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as {
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
      }
      if (parsed.tool_calls && parsed.tool_calls.length > 0) {
        const promoted = parsed.tool_calls
          .filter((tc) => tc.function?.name)
          .map((tc) => ({
            id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function' as const,
            function: {
              name: tc.function!.name!,
              arguments: tc.function?.arguments ?? '{}',
            },
          }))
        if (promoted.length > 0) {
          return {
            role: 'assistant',
            content: null,
            tool_calls: promoted,
          }
        }
      }
    } catch {
      /* plain text that happens to start with { — leave as content */
    }
  }

  const out: ChatMessage & { role: 'assistant' } = {
    role: 'assistant',
    content,
  }
  if (toolCalls && toolCalls.length > 0) out.tool_calls = toolCalls
  const reasoning = choice.reasoning_content
  if (reasoning) out.reasoning_content = reasoning
  return out
}

// ── Wire format: OpenAI Responses API (Codex models only) ───────────────────

type ResponsesRaw = {
  status?: string
  output?: Array<{
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    content?: Array<{ type?: string; text?: string }>
    text?: string
  }>
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string } | null
  incomplete_details?: { reason?: string }
}

/**
 * Chat messages + tools → Responses API request. Differences that matter:
 *  - system messages become the top-level `instructions` string
 *  - tool defs are flat ({name, parameters}) not nested under `function`
 *  - assistant tool_calls replay as {type:'function_call', call_id} items and
 *    tool results as {type:'function_call_output', call_id} items
 */
export function buildResponsesRequest(
  cfg: Config,
  messages: ChatMessage[],
  tools: ToolDef[],
): { url: string; body: Record<string, unknown> } {
  const instructions: string[] = []
  const input: Array<Record<string, unknown>> = []

  for (const m of messages) {
    if (m.role === 'system') {
      instructions.push(m.content)
      continue
    }
    if (m.role === 'user') {
      if (m.images !== undefined && m.images.length > 0) {
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: m.content },
            ...m.images.map((url) => ({ type: 'input_image', image_url: url })),
          ],
        })
      } else {
        input.push({ role: 'user', content: m.content })
      }
      continue
    }
    if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })
      }
      continue
    }
    // tool result — Responses keys it by call_id, not tool_call_id
    input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content })
  }

  return {
    url: `${cfg.llm.baseUrl}/responses`,
    body: {
      model: cfg.llm.model,
      instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined,
      input,
      tools:
        tools.length > 0
          ? tools.map((t) => ({
              type: 'function',
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            }))
          : undefined,
      tool_choice: tools.length > 0 ? ('auto' as const) : undefined,
      max_output_tokens: cfg.llm.maxTokens,
      stream: false,
      store: false,
    },
  }
}

export function parseResponsesResponse(raw: ResponsesRaw): CompleteResult {
  if (raw.error) throw new Error(`LLM error: ${raw.error.message ?? 'unknown'}`)
  if (raw.status === 'incomplete' && !raw.output) {
    throw new Error(`LLM response incomplete: ${raw.incomplete_details?.reason ?? 'unknown'}`)
  }

  const contentParts: string[] = []
  const toolCalls: NonNullable<ChatMessage & { role: 'assistant' }>['tool_calls'] = []
  for (const item of raw.output ?? []) {
    if (item.type === 'function_call' && item.name) {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      })
      continue
    }
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if ((part.type === 'output_text' || part.type === 'text') && part.text) {
          contentParts.push(part.text)
        }
      }
      continue
    }
    // reasoning / web_search / etc. — ignored
  }

  if (contentParts.length === 0 && toolCalls.length === 0) {
    throw new Error('LLM response had no output items')
  }

  return {
    message: {
      role: 'assistant',
      content: contentParts.length > 0 ? contentParts.join('') : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    usage: raw.usage
      ? { in: raw.usage.input_tokens ?? 0, out: raw.usage.output_tokens ?? 0 }
      : undefined,
  }
}
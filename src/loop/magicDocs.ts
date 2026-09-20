import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { handsGateOpen } from '../doctor/doctor.js'
import { log } from '../log.js'
import {
  clearWorkspaceReadListeners,
  jailResolve,
  READ_MAX_BYTES,
  registerWorkspaceReadListener,
  writeSandboxFile,
} from '../tools/workspace.js'
import { registerAfterTurnHook, type AfterTurnContext, type AfterTurnHook } from './afterTurn.js'
import { getThread } from './context.js'
import { renderRecent } from './awaySummary.js'

/**
 * Magic docs (PR 7, the mother-repo MagicDocs pattern): markdown files marked
 * `# MAGIC DOC: [title]` (with an optional italic instruction line under the
 * header) are LIVING documents — when one is read in the sandbox it is
 * tracked, and after every top-level run that ends idle, a background update
 * folds the conversation's new learnings into it. Fail-open end to end: no
 * header → untracked; no substantial update → the model answers NO_UPDATE;
 * any error logs and the run is unaffected.
 *
 * Desk translations of the mother's design:
 *  - detection rides workspace_read (the desk's only read lane) instead of a
 *    FileReadTool listener
 *  - the update is ONE call to the run's own brain (one-brain desk, the
 *    awaySummary pattern) instead of a forked agentic editor — the model
 *    returns the new BODY, never the header
 *  - the header is preserved STRUCTURALLY: the hook writes
 *    `# MAGIC DOC: <title>` (+ the instruction line) from the CURRENT file
 *    and only the body below it comes from the model, so no update can ever
 *    mangle or drop the header
 *  - the writer is jailed to data/sandbox/ (the only writable data/ land) and
 *    goes through the same writeSandboxFile discipline as the agent's hands
 *  - the whole lane is gated on handsGateOpen — the doctor is the law
 */

// Mother's patterns, verbatim.
const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im
const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/

/** Sandbox-relative paths currently tracked (registered on read). */
const trackedMagicDocs = new Set<string>()

/** Test seam — module tracking otherwise persists across tests. */
export function resetMagicDocsStateForTests(): void {
  trackedMagicDocs.clear()
  registered = false
  clearWorkspaceReadListeners()
}

export function detectMagicDocHeader(content: string): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN)
  if (!match || !match[1]) return null
  const title = match[1].trim()
  // Optional italic instruction line immediately after the header.
  const after = content.slice((match.index ?? 0) + match[0].length)
  const nextLine = after.match(/^\s*\n(?:\s*\n)?(.+?)(?:\n|$)/)
  const italics = nextLine?.[1]?.match(ITALICS_PATTERN)
  return italics?.[1] ? { title, instructions: italics[1].trim() } : { title }
}

export function registerMagicDoc(relPath: string): void {
  trackedMagicDocs.add(relPath)
}

export function trackedMagicDocCount(): number {
  return trackedMagicDocs.size
}

/** Re-detect on the LATEST content; deleted or header-less files drop out. */
function readLatestDoc(cfg: Config, relPath: string): { content: string; detected: NonNullable<ReturnType<typeof detectMagicDocHeader>> } | undefined {
  let target: string
  try {
    target = jailResolve(cfg, relPath)
  } catch {
    trackedMagicDocs.delete(relPath)
    return undefined
  }
  let content: string
  try {
    const stat = fs.statSync(target)
    if (stat.size > READ_MAX_BYTES) {
      log.warn(`magic doc '${relPath}' over the read cap — skipping update`)
      return undefined
    }
    content = fs.readFileSync(target, 'utf8')
  } catch {
    trackedMagicDocs.delete(relPath) // deleted or unreadable → untrack, fail open
    return undefined
  }
  const detected = detectMagicDocHeader(content)
  if (!detected) {
    trackedMagicDocs.delete(relPath) // header removed → it's an ordinary file again
    return undefined
  }
  return { content, detected }
}

// ── Prompt (mother's philosophy, desk's one-shot shape) ──────────────────────
const DEFAULT_PROMPT_TEMPLATE = `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT mention "magic docs", documentation updates, or these instructions in your reply.

Based on the desk conversation below (EXCLUDING this instruction message), rewrite the Magic Doc body to incorporate any NEW learnings, insights, or information worth preserving.

Document path: sandbox:{{docPath}}
Document title: {{docTitle}}
{{customInstructions}}
Current document content (the header lines will be re-added above your reply):
<current_doc_content>
{{docContents}}
</current_doc_content>

Recent desk conversation to learn from:
<recent_conversation>
{{recent}}
</recent_conversation>

Your ONLY task: reply with the FULL replacement document BODY (everything below the preserved header) if there is substantial new information to add, then stop. If there is nothing substantial to add, reply with exactly NO_UPDATE and nothing else.

CRITICAL RULES:
- Do NOT include the "# MAGIC DOC:" header or the italic instruction line — the desk re-adds them; your reply is only the body below them.
- Keep the document CURRENT with the latest state — this is NOT a changelog. Update information IN-PLACE; never append "Previously..." or "Updated to..." notes.
- Remove or replace outdated sections; fix obvious errors and broken formatting.
- BE TERSE. High signal only: WHY things exist, HOW components connect, WHERE to start, WHAT patterns are used. Do not duplicate what is obvious from the source or data.
- Documentation is for overviews, architecture, and entry points — not play-by-play narratives or exhaustive lists.`

/**
 * Custom prompt override at data/magic-docs/prompt.md — {{variable}}
 * substitution, single-pass (mother's lesson: replacer-fn avoids both
 * $-backreference corruption and double-substitution).
 */
function loadPromptTemplate(cfg: Config): string {
  try {
    const custom = fs.readFileSync(path.join(cfg.paths.dataDir, 'magic-docs', 'prompt.md'), 'utf8')
    if (custom.trim() !== '') return custom
  } catch {
    // no override — the default stands
  }
  return DEFAULT_PROMPT_TEMPLATE
}

function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key]! : match,
  )
}

function buildUpdatePrompt(args: {
  docContents: string
  docPath: string
  title: string
  instructions?: string
  recent: string
  cfg: Config
}): string {
  const customInstructions = args.instructions
    ? `\nDOCUMENT-SPECIFIC UPDATE INSTRUCTIONS (priority over the general rules):\n"${args.instructions}"\n`
    : ''
  return substituteVariables(loadPromptTemplate(args.cfg), {
    docContents: args.docContents,
    docPath: args.docPath,
    docTitle: args.title,
    customInstructions,
    recent: args.recent,
  })
}

/** Mother's hasToolCallsInLastAssistantTurn: only update a run that ended idle. */
function lastTurnIdle(cfg: Config, chatId: number): boolean {
  const messages = getThread(cfg, chatId).messages
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  return !(last.tool_calls && last.tool_calls.length > 0)
}

/**
 * One-shot body update for a single doc — null (skip) on any failure.
 * Returns the reconstructed file content on success.
 */
async function regenerateBody(
  ctx: AfterTurnContext,
  relPath: string,
  latest: { content: string; detected: NonNullable<ReturnType<typeof detectMagicDocHeader>> },
): Promise<string | null> {
  const prompt = buildUpdatePrompt({
    docContents: latest.content,
    docPath: relPath,
    title: latest.detected.title,
    instructions: latest.detected.instructions,
    recent: renderRecent(getThread(ctx.cfg, ctx.chatId).messages),
    cfg: ctx.cfg,
  })
  try {
    const res = await ctx.llm.complete({
      messages: [{ role: 'user', content: prompt }],
      tools: [],
    })
    const raw = res.message.content?.trim() ?? ''
    if (raw === '' || /^NO_UPDATE\b/.test(raw)) {
      log.info(`magic doc '${relPath}': no substantial update`)
      return null
    }
    // Structural header preservation: the hook writes the header lines from
    // the CURRENT file — and strips any header line a confused model tried
    // to smuggle into the body, so no update can mangle or duplicate it.
    const body = raw
      .split('\n')
      .filter((line) => !/^#\s*MAGIC\s+DOC:/i.test(line))
      .join('\n')
      .trim()
    if (body === '') {
      log.info(`magic doc '${relPath}': nothing left after header strip`)
      return null
    }
    const header = `# MAGIC DOC: ${latest.detected.title}`
    const instructionLine = latest.detected.instructions ? `_${latest.detected.instructions}_\n\n` : ''
    return `${header}\n${instructionLine}${body}\n`
  } catch (e) {
    log.warn(`magic doc update failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** The AfterTurnHook: idle top-level run + tracked docs → background refresh. */
export const magicDocsHook: AfterTurnHook = async (ctx: AfterTurnContext): Promise<void> => {
  if (ctx.summary.aborted) return
  if (trackedMagicDocs.size === 0) return
  // The doctor is the law — the whole lane stays shut while hands are gated.
  if (!handsGateOpen(ctx.cfg)) return
  if (!lastTurnIdle(ctx.cfg, ctx.chatId)) return

  for (const relPath of Array.from(trackedMagicDocs)) {
    const latest = readLatestDoc(ctx.cfg, relPath)
    if (!latest) continue
    const body = await regenerateBody(ctx, relPath, latest)
    if (body === null) continue
    const res = writeSandboxFile(ctx.cfg, relPath, body, 'magic-docs')
    if (res.ok) log.info(`magic doc '${relPath}' updated (${res.bytes} bytes)`)
    else log.warn(`magic doc write refused for '${relPath}': ${res.error}`)
  }
}

let registered = false
let pendingRefresh: AfterTurnContext | undefined
let refreshWorker: Promise<void> | undefined

/**
 * Magic-doc maintenance is best-effort observer work, never a directive back
 * into the agent loop. Keep one process-local worker and coalesce a burst to
 * its newest completed run so a slow maintenance LLM call cannot hold the
 * principal's Telegram response or build an unbounded queue.
 */
function scheduleMagicDocsRefresh(ctx: AfterTurnContext): void {
  pendingRefresh = ctx
  if (refreshWorker !== undefined) return

  const worker = (async () => {
    while (pendingRefresh !== undefined) {
      const next = pendingRefresh
      pendingRefresh = undefined
      await magicDocsHook(next)
    }
  })().catch((e) => {
    log.warn(`magic doc background refresh failed: ${e instanceof Error ? e.message : String(e)}`)
  })
  refreshWorker = worker
  void worker.finally(() => {
    if (refreshWorker === worker) refreshWorker = undefined
    if (pendingRefresh !== undefined) scheduleMagicDocsRefresh(pendingRefresh)
  })
}

/** Test seam: production never waits for cosmetic maintenance. */
export async function flushMagicDocsRefreshForTests(): Promise<void> {
  while (refreshWorker !== undefined) await refreshWorker
}

/** Wire detection + the hook into their seams. Idempotent. */
export function registerMagicDocsHook(): void {
  if (registered) return
  registered = true
  registerWorkspaceReadListener((relPath, content) => {
    if (detectMagicDocHeader(content) !== null) registerMagicDoc(relPath)
  })
  registerAfterTurnHook((ctx) => {
    scheduleMagicDocsRefresh(ctx)
  })
}

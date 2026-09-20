import type { RunEvent, RunTermination } from '../types.js'
import { escapeHtml, markdownToTelegramHtml, splitForTelegram } from './render.js'

/**
 * Progress draft (stolen from OpenClaw's draft-stream, desk-sized): ONE message
 * sent when a run starts, then edited in place as the agent works — tool
 * activity, turn count, approvals waiting — until it becomes the final answer.
 *
 * The discipline that makes it survive Telegram:
 * - throttle: at most one edit per second, edits only when text actually changes
 * - "message is not modified" counts as SUCCESS (tryEdit reports it)
 * - circuit: 3 consecutive failed edits → stop editing; the final goes fresh
 * - caps: maxLines × maxLineChars, word/middle-ellipsis style clipping
 * - secrets: the draft is a public side channel — tool NAMES + statuses only,
 *   never tool output, never model content (same religion as redaction)
 */

/** Edit throttle (ms) — Telegram edits are cheap but not free; 1/s is polite. */
const DEFAULT_THROTTLE_MS = 1_000
/** Circuit breaker: consecutive failed edits before we go final-only. */
const MAX_CONSECUTIVE_FAILURES = 3
/** Poll cadence for quiet changes (approvals pending while the agent waits). */
const POLL_MS = 1_000

export type DraftStreamOpts = {
  chatId: number
  sender: DraftSender
  throttleMs?: number
  maxLines?: number
  maxLineChars?: number
  /** Returns how many approvals are waiting (draft shows the line when > 0). */
  pendingApprovals?: () => number
}

/** The send surface the draft needs (subset of TelegramSender + tryEdit). */
export type DraftSender = {
  send(chatId: number, text: string, opts?: { replyToMessageId?: number }): Promise<number | undefined>
  tryEdit(chatId: number, messageId: number, text: string): Promise<boolean>
}

export type DraftFinalOpts = { replyToMessageId?: number; termination: RunTermination }

export const TURN_BUDGET_NOTICE =
  '⏳ Run reached its bounded turn budget. Workspace/transcript state is preserved; no work was discarded.'

export function formatRunFinal(finalMarkdown: string, termination: RunTermination): string {
  const final = finalMarkdown.trim()
  switch (termination) {
    case 'ABORTED':
      return '⏹ Stopped.'
    case 'BRAIN_EMPTY':
      return '🤔 (my brain came back empty — ask me again)'
    case 'TURN_BUDGET':
    case 'TURN_BUDGET_BUDGET_CAP':
      return final === '' || final === TURN_BUDGET_NOTICE ? TURN_BUDGET_NOTICE : `${TURN_BUDGET_NOTICE}\n\n${final}`
    case 'FINAL':
    case 'FINAL_FOLLOWUP_CAP': // finished, with the cap-refusal recorded in the audit record — same card
    case 'ERROR':
      return final
  }
}

export type DraftStream = {
  /** Feed a run event; the first event sends the draft bubble. */
  onEvent: (e: RunEvent) => void
  /** Settle: edit the draft into the final answer (or send fresh on failure). */
  finalize: (finalMarkdown: string, opts: DraftFinalOpts) => Promise<void>
  /** Stop timers without settling (error paths that finalize elsewhere). */
  dispose: () => void
}

export function createDraftStream(opts: DraftStreamOpts): DraftStream {
  const chatId = opts.chatId
  const sender = opts.sender
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS
  const maxLines = opts.maxLines ?? 8
  const maxLineChars = opts.maxLineChars ?? 120
  const pendingApprovals = opts.pendingApprovals

  let agent = 'desk'
  let turn = 0
  /** Tool activity lines, already formatted (plain text, unescaped). */
  const lines: string[] = []

  let draftId: number | undefined
  let sendInFlight: Promise<void> | undefined = undefined
  let lastText = ''
  let lastEditAt = 0
  let editTimer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let dead = false
  let settled = false

  const poll = setInterval(() => void maybeFlush(), POLL_MS)
  // Never keep the process alive for a cosmetic bubble.
  poll.unref?.()

  function header(): string {
    return `⏳ ${agent}${turn > 0 ? ` · t${turn}` : ''}…`
  }

  function compose(): string {
    const out = [header(), ...lines]
    const n = pendingApprovals?.() ?? 0
    if (n > 0) out.push(`🔒 ${n} approval${n > 1 ? 's' : ''} pending…`)
    return out.slice(0, maxLines).map(clipLine).join('\n')
  }

  function clipLine(line: string): string {
    return line.length > maxLineChars ? `${line.slice(0, maxLineChars - 1)}…` : line
  }

  function summarizeInput(input: unknown): string {
    if (input === undefined || input === null) return ''
    if (typeof input !== 'object') return escapeHtml(String(input))
    const parts = Object.entries(input as Record<string, unknown>)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    return parts.join(' ')
  }

  function onEvent(e: RunEvent): void {
    switch (e.kind) {
      case 'run_started':
        agent = e.agent
        break
      case 'turn':
        turn = e.turn
        break
      case 'tool_call': {
        const detail = summarizeInput(e.input)
        lines.push(`⚙️ ${e.tool}${detail ? ` ${detail}` : ''}…`)
        break
      }
      case 'tool_result': {
        // Mark the most recent unfinished ⚙️ line for this tool.
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!
          if (line.startsWith(`⚙️ ${e.tool}`)) {
            lines[i] = `${e.ok ? '✅' : '❌'} ${e.tool}`
            break
          }
        }
        break
      }
      case 'followup':
        lines.push(`↻ follow-up r${e.round}`)
        break
      case 'task_notification':
        lines.push(`✉ task-notification r${e.round}`)
        break
      case 'mailbox':
        lines.push(`✉ mailbox r${e.round}`)
        break
      case 'budget_continue':
        lines.push(`🎯 budget continue r${e.round}`)
        break
      case 'recovering':
        break // withheld-then-recover (#13): a recovery stage is running — audit-visible only, never a user-facing error card
      case 'error':
        lines.push(`❌ ${e.message}`)
        break
      case 'aborted':
        lines.push('⏹ aborted')
        break
      case 'final':
        break // finalize() owns this
    }
    void maybeFlush()
  }

  function maybeFlush(): void {
    if (dead || settled) return
    const text = compose()
    if (text === lastText) return
    if (draftId === undefined) {
      sendDraft(text)
      return
    }
    const wait = lastEditAt + throttleMs - Date.now()
    if (wait > 0) {
      clearTimeout(editTimer)
      editTimer = setTimeout(() => void maybeFlush(), wait)
      editTimer.unref?.()
      return
    }
    lastText = text
    lastEditAt = Date.now()
    void performEdit(text)
  }

  // Compose is plain text (dedupe-friendly); HTML-escape exactly once at the
  // transport boundary — summaries can echo user text with < > & in them.
  function sendDraft(text: string): void {
    if (sendInFlight !== undefined) return // already sending the first bubble
    const first = text
    lastText = first
    sendInFlight = (async () => {
      const id = await sender.send(chatId, escapeHtml(first))
      // A failed send leaves draftId undefined → finalize falls back to fresh send.
      if (id !== undefined) draftId = id
      sendInFlight = undefined
    })()
  }

  async function performEdit(text: string): Promise<void> {
    const id = draftId
    if (id === undefined) return
    const ok = await sender.tryEdit(chatId, id, escapeHtml(text))
    if (ok) {
      failures = 0
      return
    }
    failures += 1
    // Roll the text back so the retry is a real change, not a dedupe no-op.
    lastText = ''
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      dead = true
      clearInterval(poll)
      clearTimeout(editTimer)
    }
  }

  async function finalize(finalMarkdown: string, finalOpts: DraftFinalOpts): Promise<void> {
    if (settled) return
    settled = true
    clearInterval(poll)
    clearTimeout(editTimer)
    await sendInFlight

    const text = markdownToTelegramHtml(formatRunFinal(finalMarkdown, finalOpts.termination))
    if (text === '') {
      // Defensive fallback for malformed callers; real runs carry an explicit
      // BRAIN_EMPTY termination and are formatted above.
      if (draftId !== undefined) await sender.tryEdit(chatId, draftId, '🤔 (my brain came back empty — ask me again)')
      return
    }
    if (draftId === undefined || dead) {
      await sender.send(chatId, text, { replyToMessageId: finalOpts.replyToMessageId })
      return
    }
    const chunks = splitForTelegram(text)
    if (chunks.length > 1) {
      // Long answers can't live in the draft — point at them, then send fresh.
      await sender.tryEdit(chatId, draftId, '⏬ answer below…')
      for (const chunk of chunks) await sender.send(chatId, chunk, { replyToMessageId: finalOpts.replyToMessageId })
      return
    }
    const ok = await sender.tryEdit(chatId, draftId, chunks[0]!)
    if (!ok) await sender.send(chatId, chunks[0]!, { replyToMessageId: finalOpts.replyToMessageId })
  }

  function dispose(): void {
    settled = true
    clearInterval(poll)
    clearTimeout(editTimer)
  }

  return { onEvent, finalize, dispose }
}

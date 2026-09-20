import type { Config } from '../config.js'
import type { ChatMessage } from '../types.js'
import type { LlmClient } from '../llm/client.js'
import { markdownToTelegramHtml } from '../telegram/render.js'
import { getThread } from './context.js'
import { registerAfterTurnHook, type AfterTurnContext, type AfterTurnHook } from './afterTurn.js'
import { log } from '../log.js'

/**
 * Away summary (PR 4, the mother-repo awaySummary.ts pattern): when a
 * SCHEDULED run finishes while the principal has been idle for a while, send
 * a 1–3 sentence "while you were away" card — the high-level task plus the
 * concrete next step, never a full status report.
 *
 * Desk translation of "terminal blurred for 5 minutes": the principal's last
 * real message (Telegram or TUI prompt) is older than AWAY_SUMMARY_MIN_MS.
 * Cron-fired runs (`[scheduled] ` prefix) are exactly the work the principal
 * didn't ask for and may have missed — those are the runs that earn a card.
 * The desk thinks with one brain, so the digest reuses the run's LlmClient
 * (the mother's small-fast-model split is an optimization we don't have).
 * Every failure fails open: no card, log line, run unaffected.
 */

/** Mother's BLUR_DELAY_MS. Env-tunable; read at fire time, not boot. */
function awayMinMs(): number {
  const raw = Number(process.env['AWAY_SUMMARY_MIN_MS'])
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60_000
}

/** Mother's RECENT_MESSAGE_WINDOW — a recap only needs recent context. */
const RECENT_MESSAGE_WINDOW = 30
const RENDER_MSG_CHARS = 600
const RENDER_BUDGET = 48_000

/** Last real principal activity (Telegram message / TUI prompt — NOT cron). */
let lastAdminActivityAt = Date.now()

export function noteAdminActivity(): void {
  lastAdminActivityAt = Date.now()
}

/** Test seam — module clocks otherwise persist across tests. */
export function resetAwaySummaryStateForTests(): void {
  lastAdminActivityAt = Date.now()
  lastAwayCardAt = 0
  registered = false
}

/** Mother's hasSummarySinceLastUserTurn, desk-shaped: one card per away gap. */
let lastAwayCardAt = 0

function isAway(): boolean {
  return Date.now() - lastAdminActivityAt >= awayMinMs()
}

/** Render the thread's recent tail for the summarizer (autocompact style). */
export function renderRecent(messages: ChatMessage[]): string {
  const recent = messages.slice(-RECENT_MESSAGE_WINDOW)
  const lines: string[] = []
  let budget = RENDER_BUDGET
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!
    const body =
      'tool_call_id' in m
        ? m.content
        : [
            m.content ?? '',
            ...(m.role === 'assistant'
              ? (m.tool_calls ?? []).map((tc) => `[tool call] ${tc.function.name}(${tc.function.arguments})`)
              : []),
          ]
              .filter(Boolean)
              .join(' ')
    const line = `${m.role}: ${body.slice(0, RENDER_MSG_CHARS)}`
    if (line.length > budget) {
      lines.unshift('…older messages omitted (render budget)')
      break
    }
    budget -= line.length
    lines.unshift(line)
  }
  return lines.join('\n')
}

const AWAY_PROMPT =
  'You are writing a "while you were away" card for a Frog-to-Toad principal. The agent ran on its own ' +
  '(scheduled tasks) and this is what happened. Write exactly 1-3 short sentences of plain text: start with ' +
  'the high-level task or finding — what the desk did or learned, not implementation details — then the ' +
  'concrete next step if there is one. Skip pleasantries. Never invent anything not in the messages.'

/** Small-model digest call — null on any failure (mother's fail-to-null). */
async function summarize(llm: LlmClient, rendered: string): Promise<string | null> {
  try {
    const res = await llm.complete({
      messages: [
        { role: 'system', content: AWAY_PROMPT },
        { role: 'user', content: rendered },
      ],
      tools: [],
    })
    return res.message.content
  } catch (e) {
    log.warn(`away summary generation failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** The AfterTurnHook: scheduled run + idle principal → one digest card. */
export const awaySummaryHook: AfterTurnHook = async (ctx: AfterTurnContext): Promise<void> => {
  if (ctx.summary.aborted) return
  if (!ctx.userText.startsWith('[scheduled] ')) return
  if (!isAway()) return
  if (lastAwayCardAt > lastAdminActivityAt) return // one card per away gap

  const thread = getThread(ctx.cfg, ctx.chatId)
  if (thread.messages.length === 0) return
  const digest = await summarize(ctx.llm, renderRecent(thread.messages))
  if (digest === null || digest.trim() === '') {
    log.info('away summary skipped: empty digest')
    return
  }
  lastAwayCardAt = Date.now()
  await ctx.send.send(ctx.chatId, markdownToTelegramHtml(`🛌 ${digest.trim()}`))
}

let registered = false

/** Wire the hook into the seam. Idempotent — bot factories may be rebuilt. */
export function registerAwaySummaryHook(): void {
  if (registered) return
  registered = true
  registerAfterTurnHook(awaySummaryHook)
}

import type { Config } from '../config.js'
import type { RunEvent, RunSummary, TelegramSender } from '../types.js'
import type { LlmClient } from '../llm/client.js'
import { log } from '../log.js'
import {
  invalidTaskNotificationReason,
  injectTaskNotification,
  type TaskNotification,
} from './taskNotification.js'

/**
 * After-turn seam (PR 4, the mother-repo postSamplingHooks pattern; v2 in the
 * north-star PR, the mother-repo stopHooks pattern): a small programmatic
 * registry fired after EVERY top-level agent run pass completes — never for
 * subagent runs. A failing hook is logged and skipped, never allowed to break
 * the loop.
 *
 * v2 capability (the generator-shape upgrade): a hook may DIRECT the loop, not
 * only observe it. The one directive available is a follow-up — a user-role
 * message injected into the same conversation, after which the loop re-enters
 * the model for ONE more bounded pass. Bounded by law:
 *  - FOLLOW-UP CAP — a run performs at most AFTER_TURN_FOLLOWUP_MAX follow-ups
 *    (default 2). A hook that asks every turn hits the cap, not an infinite
 *    loop.
 *  - FINAL ONLY — follow-ups are granted only after a clean FINAL pass. An
 *    aborted, errored, brain-empty, or budget-exhausted run is never extended:
 *    a follow-up never re-arms a budget the run already spent.
 *  - PROVENANCE — the injected message enters the thread marked
 *    `[after-turn hook] …` so the brain always knows the principal did not
 *    write it.
 *  - ONE PER FIRING — when several hooks ask in the same firing, the first
 *    follow-up wins and the rest are logged, not queued. Hooks don't storm.
 */
export type AfterTurnContext = {
  cfg: Config
  chatId: number
  agent: string
  /** The prompt that started this run (cron-fired prompts carry `[scheduled] `). */
  userText: string
  summary: RunSummary
  /** The run's own brain — hooks that need a digest call reuse it (mockable). */
  llm: LlmClient
  /** Reply in the same channel the run used (Telegram). */
  send: TelegramSender
  /** Optional audit/event observer used by background lifecycle hooks. */
  onEvent?: (event: RunEvent) => void
}

/**
 * What a hook tells the loop after observing a turn:
 *  - `observe` (or nothing at all — the legacy shape) — nothing happens.
 *  - `followUp` — inject `text` as a user-role message and force one more
 *    bounded model pass. Granted only per the follow-up laws above.
 *  - `taskNotification` — inject a worker report as a `<task-notification>`
 *    envelope (the mother-repo coordinatorMode §2 shape) and force one more
 *    bounded pass. SAME grant laws as followUp: FINAL-only, counted against
 *    the same cap, durable thread history with the desk's provenance mark.
 *    Notification is not voice — the brain synthesizes, never relays.
 *  - `mailbox` — inject the agent's inbox messages as one provenance-tagged
 *    durable block (Tier 2 #7). SAME grant laws as followUp: FINAL-only,
 *    counted against the same cap. Delivery never relaxes gates — the mark
 *    says a desk peer's words, never the principal's; it can never change
 *    tools, modes, or authority. The messages are consumed (marked read)
 *    AT injection, after the grant — a refused extension never eats mail.
 */
export type AfterTurnDirective =
  | { kind: 'observe' }
  | { kind: 'followUp'; text: string }
  | { kind: 'taskNotification'; notification: TaskNotification }
  | { kind: 'mailbox'; messages: import('../store/mailbox.js').UnreadMessage[] }

export type AfterTurnHook = (
  ctx: AfterTurnContext,
) => Promise<AfterTurnDirective | void> | AfterTurnDirective | void

const hooks: AfterTurnHook[] = []

/** Register an after-turn hook. Internal API — not settings-exposed. */
export function registerAfterTurnHook(hook: AfterTurnHook): void {
  hooks.push(hook)
}

/** Clear all registered hooks (for testing). */
export function clearAfterTurnHooks(): void {
  hooks.length = 0
}

/** Marker prepended to every hook-injected message — the provenance law. */
export const AFTER_TURN_FOLLOWUP_PREFIX = '[after-turn hook]'

/**
 * Execute all registered after-turn hooks. Hook errors log, never throw.
 * EVERY hook runs (cards they send are unchanged behavior — the seam never
 * silences a later hook because an earlier one directed); the first VALID
 * directive of any kind wins, everything else observes. Void-returning hooks —
 * every seam v1 consumer — are observes by definition.
 */
export async function fireAfterTurnHooks(ctx: AfterTurnContext): Promise<AfterTurnDirective> {
  let winner: AfterTurnDirective | undefined
  for (let i = 0; i < hooks.length; i++) {
    try {
      const directive = await hooks[i]?.(ctx)
      if (directive === undefined || directive === null) continue
      if (directive.kind === 'followUp') {
        if (typeof directive.text === 'string' && directive.text.trim() !== '') {
          if (winner === undefined) winner = directive
          continue
        }
        log.warn(`after-turn hook ${i} returned an empty followUp — ignored`)
        continue
      }
      if (directive.kind === 'taskNotification') {
        const reason = invalidTaskNotificationReason(directive.notification)
        if (reason === undefined) {
          if (winner === undefined) winner = directive
          continue
        }
        log.warn(`after-turn hook ${i} returned a malformed taskNotification (${reason}) — ignored`)
        continue
      }
      if (directive.kind === 'mailbox') {
        if (directive.messages.length > 0) {
          if (winner === undefined) winner = directive
          continue
        }
        log.warn(`after-turn hook ${i} returned an empty mailbox directive — ignored`)
        continue
      }
    } catch (e) {
      log.warn(`after-turn hook failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return winner ?? { kind: 'observe' }
}

/** Follow-up cap per run (env AFTER_TURN_FOLLOWUP_MAX, default 2). */
export const DEFAULT_FOLLOWUP_MAX = 2

/** Hard clamp — no env value can buy an unbounded continuation loop. */
const FOLLOWUP_MAX_CEILING = 10

export function followupMax(): number {
  const raw = process.env.AFTER_TURN_FOLLOWUP_MAX
  // Blank means unset (the desk's env convention). Unset/garbage/NaN → default.
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_FOLLOWUP_MAX
  if (n <= 0) return 0 // 0 disables; a negative value is invalid → disabled, not default
  return Math.min(Math.floor(n), FOLLOWUP_MAX_CEILING)
}

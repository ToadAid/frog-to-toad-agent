/**
 * Token budget (mother-repo port: src/utils/tokenBudget.ts + src/query/tokenBudget.ts).
 *
 * The principal can declare a WORK target in the prompt — `+500k` (shorthand,
 * anchored to start or end to avoid false positives in natural language) or
 * "use 2M tokens" (verbose) — and a run that reaches the turn cap
 * self-continues, one working turn per grant, until it has spent ~90% of that
 * target or returns diminish.
 *
 * Laws:
 *  - THE DECLARED BUDGET IS THE BOUND — a continuation spends the principal's
 *    own declaration, never a system default. No declaration → no continuation.
 *  - SUBAGENTS NEVER BUDGET-CONTINUE (mother agentId law → desk depth law:
 *    only depth-0 runs parse a budget at all).
 *  - A CONTINUATION IS A WORK GRANT, NOT VOICE — the nudge is a provenance-
 *    tagged durable user message the principal did not write.
 *  - BOUNDED — continuations are hard-capped (TOKEN_BUDGET_MAX_CONTINUATIONS,
 *    default 20, clamped 0..100): the declared budget bounds spend, the cap
 *    bounds round-trips.
 */

// Shorthand (+500k) anchored to start/end to avoid false positives in natural
// language. Verbose (use/spend 2M tokens) matches anywhere.
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
// Lookbehind (?<=\s) is avoided — it defeats YARR JIT in JSC, and the
// interpreter scans O(n) even with the $ anchor. Capture the whitespace
// instead; callers offset match.index by 1 where position matters.
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

function parseBudgetMatch(value: string, suffix: string): number {
  return parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]!
}

export function parseTokenBudget(text: string): number | null {
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) return parseBudgetMatch(startMatch[1]!, startMatch[2]!)
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) return parseBudgetMatch(endMatch[1]!, endMatch[2]!)
  const verboseMatch = text.match(VERBOSE_RE)
  if (verboseMatch) return parseBudgetMatch(verboseMatch[1]!, verboseMatch[2]!)
  return null
}

/** Provenance mark above every injected budget nudge — durable thread history
 * always shows the principal did not write it. */
export const TOKEN_BUDGET_PREFIX = '[token budget]'

/** Share of the declared target at which the budget counts as met (~90%).
 * Exported for the loop's terminal-reason ledger (Tier 2 #12): synthesis at
 * the turn cap with the target still below this threshold is a guard
 * outcome (TURN_BUDGET_BUDGET_CAP), not a plain budget stop. */
export const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

/** Hard cap on budget continuations (desk boundedness law; the mother relies
 * on the budget itself + diminishing returns — the desk adds a round-trip
 * bound). Env TOKEN_BUDGET_MAX_CONTINUATIONS, clamped 0..100. */
export const DEFAULT_BUDGET_CONTINUATION_MAX = 20

export function budgetContinuationMax(): number {
  const raw = process.env['TOKEN_BUDGET_MAX_CONTINUATIONS']
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUDGET_CONTINUATION_MAX
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0 // negative or garbage → disable (never re-arm the default)
  return Math.min(100, Math.floor(n))
}

export function getBudgetContinuationMessage(pct: number, turnTokens: number, budget: number): string {
  const fmt = (n: number): string => new Intl.NumberFormat('en-US').format(n)
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working — do not summarize.`
}

export type BudgetTracker = {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

type ContinueDecision = {
  action: 'continue'
  nudgeMessage: string
  continuationCount: number
  pct: number
  turnTokens: number
  budget: number
}

type StopDecision = {
  action: 'stop'
  completionEvent: {
    continuationCount: number
    pct: number
    turnTokens: number
    budget: number
    diminishingReturns: boolean
    durationMs: number
  } | null
}

export type TokenBudgetDecision = ContinueDecision | StopDecision

export function checkTokenBudget(
  tracker: BudgetTracker,
  isSubagent: boolean,
  budget: number | null,
  tokensOut: number,
): TokenBudgetDecision {
  if (isSubagent || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }

  const pct = Math.round((tokensOut / budget) * 100)
  const deltaSinceLastCheck = tokensOut - tracker.lastGlobalTurnTokens

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  if (
    !isDiminishing &&
    tracker.continuationCount < budgetContinuationMax() &&
    tokensOut < budget * COMPLETION_THRESHOLD
  ) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = tokensOut
    return {
      action: 'continue',
      nudgeMessage: getBudgetContinuationMessage(pct, tokensOut, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens: tokensOut,
      budget,
    }
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens: tokensOut,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    }
  }

  return { action: 'stop', completionEvent: null }
}
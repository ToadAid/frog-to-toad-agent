import path from 'node:path'
import type { Config } from '../config.js'
import { appendJsonl, readJsonl } from '../store/jsonl.js'

/**
 * Signal lifecycle (NautilusTrader steal): a signal is a LIVING thing with
 * legal transitions, not a journal line that silently becomes a grade.
 *
 *   (new) → PROPOSED → ACTIVE → CLOSED
 *                \_______________↗   (withdrawn / expired without acting)
 *
 * CLOSED is terminal: re-grading a closed signal is an ILLEGAL transition and
 * is refused — grading becomes idempotent BY STATE, not by string-matching
 * journal prints. Transitions append to data/signals/lifecycle.jsonl (the
 * ledger discipline: events append, current state is derived by folding).
 */

export type SignalState = 'PROPOSED' | 'ACTIVE' | 'CLOSED'

export const LEGAL_TRANSITIONS: Record<SignalState, SignalState[]> = {
  PROPOSED: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['CLOSED'],
  CLOSED: [],
}

export type LifecycleEvent = {
  key: string
  from: 'new' | SignalState
  to: SignalState
  ts: number
  /** Why the transition happened (grade, entry, withdrawal…). */
  reason?: string
}

export function signalLifecyclePath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'signals', 'lifecycle.jsonl')
}

function events(cfg: Config): LifecycleEvent[] {
  return readJsonl<LifecycleEvent>(signalLifecyclePath(cfg))
}

/** Current state of a signal; undefined = the desk has never seen this key. */
export function signalState(cfg: Config, key: string): SignalState | undefined {
  let state: SignalState | undefined
  for (const e of events(cfg)) {
    if (e.key !== key) continue
    state = e.to
  }
  return state
}

/** Every lifecycle event for one signal, oldest first — the audit trail. */
export function signalHistory(cfg: Config, key: string): LifecycleEvent[] {
  return events(cfg).filter((e) => e.key === key)
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly key: string,
    public readonly from: SignalState | 'new',
    public readonly to: SignalState,
  ) {
    super(`illegal signal transition for ${key}: ${from} → ${to} (CLOSED is terminal)`)
  }
}

/**
 * Advance a signal's lifecycle. `from: 'new'` is only legal into PROPOSED
 * (creation). Throws IllegalTransitionError on anything illegal — callers
 * decide whether to log-and-skip (re-grade) or fail loud.
 */
export function advanceSignal(
  cfg: Config,
  key: string,
  to: SignalState,
  opts: { reason?: string; now?: number } = {},
): LifecycleEvent {
  const from = signalState(cfg, key) ?? 'new'
  if (from === 'new' && to !== 'PROPOSED') {
    throw new IllegalTransitionError(key, 'new', to)
  }
  if (from !== 'new' && !LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError(key, from, to)
  }
  const event: LifecycleEvent = { key, from, to, ts: opts.now ?? Date.now(), ...(opts.reason ? { reason: opts.reason } : {}) }
  appendJsonl(signalLifecyclePath(cfg), event)
  return event
}
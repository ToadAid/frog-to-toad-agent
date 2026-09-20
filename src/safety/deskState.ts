import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'

/**
 * Desk-wide trading state machine (stolen from NautilusTrader's RiskEngine —
 * `set_trading_state()` / `TradingStateChanged`).
 *
 *   ACTIVE   — the desk trades normally (every trade still behind its guard)
 *   REDUCING — new entries refused; only exits that REDUCE an open position
 *              (selling a held token into a stable) pass the guard
 *   HALTED   — every trade refused; the principal intervenes (Nautilus's
 *              HALTED likewise denies all submits — "cancels pass" is their
 *              venue-order analog; ours is: the human can still exit manually)
 *
 * Deny-default rules of the road:
 *  - only the PRINCIPAL changes state (/halt /reduce /resume, kill switch);
 *    the agent has NO tool that touches this file
 *  - state PERSISTS across restarts (data/state/desk_state.json, atomic write)
 *  - a missing file reads as ACTIVE (fresh desk); a CORRUPT file reads as
 *    HALTED — fail closed, loudly, until the principal fixes or resumes
 */

export type DeskTradingState = 'ACTIVE' | 'REDUCING' | 'HALTED'

export type DeskStateRecord = {
  state: DeskTradingState
  /** Epoch ms of the transition into the current state. */
  since: number
  reason?: string
}

const STATES: readonly DeskTradingState[] = ['ACTIVE', 'REDUCING', 'HALTED']

/** Tokens an exit is allowed to land in while REDUCING (cash, not rotation). */
export const STABLE_SYMBOLS = ['USDC', 'USDT', 'DAI', 'FDUSD', 'PYUSD', 'USDS'] as const

function stateFile(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'desk_state.json')
}

export function loadDeskState(cfg: Config): DeskStateRecord {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(cfg), 'utf8')) as DeskStateRecord
    if (STATES.includes(raw.state)) return raw
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt, not missing: fail CLOSED and say so — the principal must see it.
      console.warn(`[deskState] state file unreadable — failing CLOSED to HALTED until fixed: ${String(err)}`)
      return { state: 'HALTED', since: Date.now(), reason: 'state file corrupt (fail-closed)' }
    }
  }
  return { state: 'ACTIVE', since: Date.now() }
}

export function setDeskState(cfg: Config, state: DeskTradingState, reason?: string): DeskStateRecord {
  if (!STATES.includes(state)) throw new Error(`invalid desk trading state: ${String(state)}`)
  const record: DeskStateRecord = { state, since: Date.now(), ...(reason !== undefined ? { reason } : {}) }
  const file = stateFile(cfg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return record
}

/** Stable? (exit landing zone while REDUCING) */
export function isStable(symbol: string): boolean {
  return STABLE_SYMBOLS.some((s) => s === symbol.toUpperCase())
}
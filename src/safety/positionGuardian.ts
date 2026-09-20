import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { readPositions } from '../store/positions.js'
import { getUsdPrice } from '../market/feeds.js'
import { log } from '../log.js'

/**
 * Position guardian — a quiet watchman. On a schedule it re-prices every open
 * position and alerts when one crosses a drawdown threshold from entry:
 *   −10% → WATCH · −25% → CRITICAL
 * Alert state persists so each level fires ONCE per crossing (no spam), and
 * the watch clears on recovery so a future breach re-alerts. Thresholds are
 * code, not prompt.
 */

export type GuardianAlert =
  | { kind: 'breach'; symbol: string; level: 'watch' | 'critical'; entryUsd: number; markUsd: number; drawdownPct: number }
  | { kind: 'recovered'; symbol: string; entryUsd: number; markUsd: number; drawdownPct: number }

type GuardianState = Record<string, 'watch' | 'critical'>

type GuardianLevel = 'watch' | 'critical'

const THRESHOLDS: Array<{ level: GuardianLevel; dropPct: number }> = [
  { level: 'watch', dropPct: 10 },
  { level: 'critical', dropPct: 25 },
]

export function guardianStatePath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'guardian_state.json')
}

function readState(cfg: Config): GuardianState {
  try {
    return JSON.parse(fs.readFileSync(guardianStatePath(cfg), 'utf8')) as GuardianState
  } catch {
    return {}
  }
}

function writeState(cfg: Config, state: GuardianState): void {
  fs.mkdirSync(path.dirname(guardianStatePath(cfg)), { recursive: true })
  fs.writeFileSync(guardianStatePath(cfg), JSON.stringify(state, null, 2))
}

export type GuardianCheck = {
  checked: number
  unpriced: string[]
  alerts: GuardianAlert[]
}

/**
 * One guardian pass. `priceOf` injectable for tests; production uses the feed
 * chain. Alerts fire on threshold CROSSINGS only — a level already reported
 * stays quiet until the position recovers above it.
 */
export async function checkPositions(
  cfg: Config,
  priceOf: (symbol: string) => Promise<number | undefined> = async (s) => (await getUsdPrice(s))?.usd,
): Promise<GuardianCheck> {
  const book = readPositions(cfg)
  const state = readState(cfg)
  const alerts: GuardianAlert[] = []
  const unpriced: string[] = []

  for (const p of book.positions) {
    const mark = await priceOf(p.symbol)
    if (mark === undefined || !Number.isFinite(mark) || p.avgEntryUsd <= 0) {
      unpriced.push(p.symbol)
      continue
    }
    const drawdownPct = ((p.avgEntryUsd - mark) / p.avgEntryUsd) * 100
    // deepest threshold crossed — a −30% position is CRITICAL, not WATCH
    const worst = [...THRESHOLDS].reverse().find((t) => drawdownPct >= t.dropPct)
    const prev = state[p.symbol]

    if (worst && prev !== worst.level) {
      // New (or deepened) breach — report it.
      state[p.symbol] = worst.level
      alerts.push({
        kind: 'breach',
        symbol: p.symbol,
        level: worst.level,
        entryUsd: p.avgEntryUsd,
        markUsd: mark,
        drawdownPct: Math.round(drawdownPct * 100) / 100,
      })
    } else if (!worst && prev) {
      // Recovered above every threshold — clear so a future breach re-alerts.
      delete state[p.symbol]
      alerts.push({
        kind: 'recovered',
        symbol: p.symbol,
        entryUsd: p.avgEntryUsd,
        markUsd: mark,
        drawdownPct: Math.round(drawdownPct * 100) / 100,
      })
    }
  }

  writeState(cfg, state)
  if (alerts.length > 0) log.info(`position guardian: ${alerts.length} event(s)`)
  return { checked: book.positions.length, unpriced, alerts }
}

/** Telegram text for a guardian check (empty string = nothing worth sending). */
export function formatGuardianReport(check: GuardianCheck): string {
  if (check.alerts.length === 0) return ''
  const lines = check.alerts.map((a) =>
    a.kind === 'breach'
      ? `${a.level === 'critical' ? '🔴 CRITICAL' : '🟡 WATCH'} ${a.symbol}: $${fmt(a.markUsd)} vs entry $${fmt(a.entryUsd)} (−${a.drawdownPct}% from entry)`
      : `🟢 RECOVERED ${a.symbol}: back to $${fmt(a.markUsd)} (−${a.drawdownPct}% from entry) — watch cleared`,
  )
  return `👀 Position guardian:\n${lines.join('\n')}`
}

function fmt(n: number): string {
  return n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toPrecision(4)
}
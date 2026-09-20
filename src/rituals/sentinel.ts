import fs from 'node:fs'
import type { Config } from '../config.js'
import { fetchFearGreed } from '../market/sentiment.js'
import { getUsdPrice, priceAt, COINGECKO_IDS } from '../market/feeds.js'
import { fetchStablecoins } from '../market/onchain.js'
import { log } from '../log.js'

/**
 * Proactive sentinel (Phase 10.4) — the standing directive: the desk informs
 * the principal when it SEES opportunity or risk; it is not an answer machine.
 * Every SENTINEL_CRON it scans three lenses and speaks ONLY when there is
 * something worth tapping the shoulder for:
 *   1. Sentiment extremes  — F&G crossing into ≤25 (opportunity) or ≥75 (caution)
 *   2. Outsized 24h moves  — majors moving ≥ SENTINEL_MOVE_PCT in a day
 *   3. Stablecoin shifts   — weekly dollar flow ≥ ±1% (liquidity in/out)
 * Anti-spam is the point: extremes alert on ZONE CROSSING only, moves carry a
 * per-symbol cooldown, stablecoins a daily cooldown — state persists across
 * restarts in data/state/sentinel.json.
 */

const MOVE_WATCH = ['BTC', 'ETH', 'SOL'] // majors — the desk's benchmark tier
const MOVE_COOLDOWN_MS = 12 * 3_600_000 // same symbol at most twice a day
const FNG_EXTREMES = { low: 25, high: 75 } // mirrors brief.ts / sentiment notes
const STABLE_SHIFT_PCT = 1.0 // weekly aggregate flow worth waking the principal
const STABLE_COOLDOWN_MS = 24 * 3_600_000

export type SentinelState = {
  fngZone?: 'extreme' | 'mid'
  fngAt?: number
  moves?: Record<string, number> // symbol → last alert ts
  stableAt?: number
  stablePct?: number | null
}

export type SentinelDeps = {
  fearGreed?: typeof fetchFearGreed
  priceNow?: typeof getUsdPrice
  pricePast?: typeof priceAt
  stablecoins?: typeof fetchStablecoins
  now?: () => number
  statePath?: string
}

function statePath(cfg: Config, override?: string): string {
  return override ?? `${cfg.paths.dataDir}/state/sentinel.json`
}

export function readSentinelState(cfg: Config, deps: SentinelDeps = {}): SentinelState {
  try {
    const raw = fs.readFileSync(statePath(cfg, deps.statePath), 'utf8')
    return JSON.parse(raw) as SentinelState
  } catch {
    return {}
  }
}

export function writeSentinelState(cfg: Config, state: SentinelState, deps: SentinelDeps = {}): void {
  try {
    fs.mkdirSync(`${cfg.paths.dataDir}/state`, { recursive: true })
    fs.writeFileSync(statePath(cfg, deps.statePath), JSON.stringify(state, null, 2))
  } catch (err) {
    log.warn(`sentinel: could not persist state: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

async function fngAlert(
  state: SentinelState,
  deps: SentinelDeps,
): Promise<{ alert?: string; zone?: 'extreme' | 'mid' }> {
  const fng = await (deps.fearGreed ?? fetchFearGreed)()
  if (!fng) return {}
  const zone: 'extreme' | 'mid' = fng.value <= FNG_EXTREMES.low || fng.value >= FNG_EXTREMES.high ? 'extreme' : 'mid'
  const wasZone = state.fngZone
  // Speak only on the crossing INTO an extreme — not every scan while parked there.
  if (zone === 'extreme' && wasZone !== 'extreme') {
    const fear = fng.value <= FNG_EXTREMES.low
    const alert = fear
      ? `🟢 OPPORTUNITY WATCH — Fear & Greed dropped to ${fng.value}/100 (${fng.classification}). ` +
        `Extreme fear is historically where the best entries live, not where they are guaranteed. ` +
        `Worth reviewing the watchlist — calmly, not with a market order.`
      : `🔴 RISK WATCH — Fear & Greed hit ${fng.value}/100 (${fng.classification}). ` +
        `Extreme greed is where discipline pays: this is when new positions deserve smaller size, ` +
        `not bigger conviction.`
    return { alert, zone }
  }
  return { zone }
}

async function moveAlerts(
  cfg: Config,
  state: SentinelState,
  deps: SentinelDeps,
  now: number,
): Promise<{ alerts: string[]; nextMoves: Record<string, number> }> {
  const alerts: string[] = []
  const moves = state.moves ?? {}
  const nextMoves: Record<string, number> = { ...moves }
  const threshold = cfg.sentinelMovePct
  for (const symbol of MOVE_WATCH) {
    if (!COINGECKO_IDS[symbol]) continue
    if (moves[symbol] !== undefined && now - moves[symbol]! < MOVE_COOLDOWN_MS) continue
    try {
      const quote = await (deps.priceNow ?? getUsdPrice)(symbol)
      if (!quote) continue
      const past = await (deps.pricePast ?? priceAt)(symbol, now - 86_400_000)
      if (past === undefined || past <= 0) continue
      const move = ((quote.usd - past) / past) * 100
      if (Math.abs(move) < threshold) continue
      nextMoves[symbol] = now
      const direction = move >= 0 ? 'pumped' : 'dumped'
      alerts.push(
        move >= 0
          ? `📈 ${symbol} ${direction} ${pct(move)} in 24h ($${fmt(past)} → $${fmt(quote.usd)}). ` +
            `Momentum is real until it isn't — if you chase, size for the pullback that follows every run.`
          : `📉 ${symbol} ${direction} ${pct(move)} in 24h ($${fmt(past)} → $${fmt(quote.usd)}). ` +
            `Two ways to read it: risk if you're holding, opportunity if it was already on the watchlist. ` +
            `Check WHY before touching it.`,
      )
    } catch {
      /* feed hiccup on one symbol shouldn't kill the scan */
    }
  }
  return { alerts, nextMoves }
}

async function stableAlert(
  state: SentinelState,
  deps: SentinelDeps,
  now: number,
): Promise<{ alert?: string; pct?: number | null; at?: number }> {
  if (state.stableAt !== undefined && now - state.stableAt < STABLE_COOLDOWN_MS) return {}
  const snap = await (deps.stablecoins ?? fetchStablecoins)()
  if (!snap || snap.changePct7d === null) return {}
  if (Math.abs(snap.changePct7d) < STABLE_SHIFT_PCT) return { pct: snap.changePct7d }
  const inflow = snap.changePct7d > 0
  return {
    at: now,
    pct: snap.changePct7d,
    alert:
      (inflow ? '🟢 LIQUIDITY INFLOW' : '🔴 LIQUIDITY OUTFLOW') +
      ` — total stablecoin supply ${pct(snap.changePct7d)} over 7d (${fmtUsd(snap.totalSupplyUsd)} parked now). ` +
      (inflow
        ? `New dollars are minting into crypto — dry powder building. Bullish backdrop, not a buy button.`
        : `Stablecoin supply is burning down — dollars leaving or deploying. Watch what the deployed side does.`),
  }
}

const fmt = (n: number): string => (n >= 100 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `$${n.toPrecision(4)}`)

function fmtUsd(n: number): string {
  return n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${Math.round(n)}`
}

/** Run one sentinel scan → alerts worth sending (possibly none — that's success too). */
export async function runSentinel(cfg: Config, deps: SentinelDeps = {}): Promise<string[]> {
  const now = (deps.now ?? Date.now)()
  const state = readSentinelState(cfg, deps)
  const next: SentinelState = { ...state }
  const alerts: string[] = []

  try {
    const f = await fngAlert(state, deps)
    if (f.alert) alerts.push(f.alert)
    if (f.zone) {
      next.fngZone = f.zone
      next.fngAt = now
    }
  } catch (err) {
    log.debug(`sentinel: f&g lens failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const m = await moveAlerts(cfg, state, deps, now)
    alerts.push(...m.alerts)
    next.moves = m.nextMoves
  } catch (err) {
    log.debug(`sentinel: move lens failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const s = await stableAlert(state, deps, now)
    if (s.alert) alerts.push(s.alert)
    if (s.at !== undefined) {
      next.stableAt = s.at
      next.stablePct = s.pct
    }
  } catch (err) {
    log.debug(`sentinel: stablecoin lens failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (alerts.length > 0 || JSON.stringify(state) !== JSON.stringify(next)) {
    writeSentinelState(cfg, next, deps)
  }
  return alerts
}
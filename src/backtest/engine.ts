import type { Candle } from '../market/ta.js'
import { sma, rsiSeries } from '../market/ta.js'

/**
 * Strategy backtester — pure, deterministic, LLM-free. The agent picks a
 * BUILT-IN strategy + parameters; nothing executes agent-written code (the
 * desk has no bash and it stays that way).
 *
 * Anti-lookahead rules, both tested:
 *   1. Signals are computed from candle i's CLOSE (indicator windows end at i).
 *   2. Fills happen at candle i+1's OPEN (+slippage, −fee) — you can't act on
 *      the close you just watched, only on the next market.
 *
 * Position mode: long/flat only (spot desk; shorts are out of scope until a
 * margin lane exists). Built-in strategies: sma_cross, rsi_reversion,
 * breakout, momentum.
 */

export type StrategySpec =
  | { kind: 'sma_cross'; fast?: number; slow?: number }
  | { kind: 'rsi_reversion'; period?: number; oversold?: number; exitLevel?: number }
  | { kind: 'breakout'; lookback?: number; exitLookback?: number }
  | { kind: 'momentum'; lookback?: number; thresholdPct?: number }

export type BacktestTrade = {
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  /** Net return over the holding period, after fees + slippage on both sides. */
  returnPct: number
  holdCandles: number
  /** Still open at window end — exit price is the last close (marked to market). */
  open?: boolean
}

export type BacktestMetrics = {
  totalReturnPct: number
  buyHoldReturnPct: number
  alphaPct: number
  winRatePct: number
  profitFactor: number
  expectancyPct: number
  maxDrawdownPct: number
  exposurePct: number
}

export type BacktestResult = {
  symbol: string
  interval: string
  strategyLabel: string
  candles: number
  fromTime: number
  toTime: number
  trades: BacktestTrade[]
  metrics: BacktestMetrics
  warnings: string[]
}

export type BacktestConfig = {
  symbol: string
  interval: string
  candles: Candle[]
  strategy: StrategySpec
  /** Fee charged on EVERY side, in basis points (default 10 = 0.1%). */
  feeBps?: number
  /** Slippage per side, in basis points (default 10 = 0.1%). */
  slippageBps?: number
}

/** Sentinel: "hold whatever position we're in" (indeterminate zone). */
const KEEP = 2

// ── Strategy resolution ──────────────────────────────────────────────────────

export function strategyLabel(s: StrategySpec): string {
  switch (s.kind) {
    case 'sma_cross':
      return `sma_cross(${s.fast ?? 20}/${s.slow ?? 50})`
    case 'rsi_reversion':
      return `rsi_reversion(${s.period ?? 14}, enter<${s.oversold ?? 30}, exit>${s.exitLevel ?? 55})`
    case 'breakout':
      return `breakout(${s.lookback ?? 20} enter, ${s.exitLookback ?? 10} exit)`
    case 'momentum':
      return `momentum(${s.lookback ?? 30}, enter>${s.thresholdPct ?? 5}%)`
  }
}

/** Parameter sanity — fail loud before simulating nonsense. */
export function validateStrategy(s: StrategySpec): string | undefined {
  switch (s.kind) {
    case 'sma_cross': {
      const fast = s.fast ?? 20
      const slow = s.slow ?? 50
      if (!Number.isFinite(fast) || fast < 2) return 'sma_cross fast period must be ≥ 2'
      if (!Number.isFinite(slow) || slow <= fast) return 'sma_cross slow period must be > fast'
      return undefined
    }
    case 'rsi_reversion': {
      const period = s.period ?? 14
      const oversold = s.oversold ?? 30
      const exit = s.exitLevel ?? 55
      if (!Number.isFinite(period) || period < 2) return 'rsi_reversion period must be ≥ 2'
      if (!Number.isFinite(oversold) || oversold < 1 || oversold > 50) return 'rsi_reversion oversold must be 1–50'
      if (!Number.isFinite(exit) || exit <= oversold || exit > 99) return 'rsi_reversion exitLevel must be > oversold and ≤ 99'
      return undefined
    }
    case 'breakout': {
      const lookback = s.lookback ?? 20
      const exitLookback = s.exitLookback ?? 10
      if (!Number.isFinite(lookback) || lookback < 2) return 'breakout lookback must be ≥ 2'
      if (!Number.isFinite(exitLookback) || exitLookback < 1) return 'breakout exitLookback must be ≥ 1'
      if (exitLookback > lookback) return 'breakout exitLookback must be ≤ lookback'
      return undefined
    }
    case 'momentum': {
      const lookback = s.lookback ?? 30
      const threshold = s.thresholdPct ?? 5
      if (!Number.isFinite(lookback) || lookback < 2) return 'momentum lookback must be ≥ 2'
      if (!Number.isFinite(threshold) || threshold <= 0) return 'momentum thresholdPct must be > 0'
      return undefined
    }
  }
}

function warmup(s: StrategySpec): number {
  switch (s.kind) {
    case 'sma_cross':
      return (s.slow ?? 50) + 1
    case 'rsi_reversion':
      return (s.period ?? 14) + 1
    case 'breakout':
      return Math.max(s.lookback ?? 20, s.exitLookback ?? 10) + 1
    case 'momentum':
      return (s.lookback ?? 30) + 1
  }
}

/**
 * Target position at candle i (1 = long, 0 = flat), decided from data ≤ close[i].
 * Every indicator window ENDS at i — looking forward is the classic backtest bug.
 * KEEP means "hold whatever we're in" (indeterminate zone, e.g. RSI mid-range).
 */
function targetPosition(s: StrategySpec, i: number, candles: Candle[], rsi: number[]): number {
  const close = candles[i]!.close
  switch (s.kind) {
    case 'sma_cross': {
      const f = sma(candles.slice(0, i + 1).map((c) => c.close), s.fast ?? 20)
      const sl = sma(candles.slice(0, i + 1).map((c) => c.close), s.slow ?? 50)
      if (f === undefined || sl === undefined) return 0
      return f > sl ? 1 : 0
    }
    case 'rsi_reversion': {
      const value = rsi[i]
      if (value === undefined || Number.isNaN(value)) return 0
      if (value < (s.oversold ?? 30)) return 1
      if (value > (s.exitLevel ?? 55)) return 0
      return KEEP
    }
    case 'breakout': {
      const priorHigh = Math.max(...candles.slice(i - (s.lookback ?? 20), i).map((c) => c.high))
      const priorLow = Math.min(...candles.slice(i - (s.exitLookback ?? 10), i).map((c) => c.low))
      if (close > priorHigh) return 1
      if (close < priorLow) return 0
      return KEEP
    }
    case 'momentum': {
      const prev = candles[i - (s.lookback ?? 30)]?.close
      if (prev === undefined) return 0
      const roc = ((close - prev) / prev) * 100
      if (roc > (s.thresholdPct ?? 5)) return 1
      if (roc < 0) return 0
      return KEEP
    }
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

export function backtest(cfg: BacktestConfig): BacktestResult {
  const { candles } = cfg
  if (candles.length < warmup(cfg.strategy) + 5) {
    throw new Error(`need ≥ ${warmup(cfg.strategy) + 5} candles for ${strategyLabel(cfg.strategy)}, got ${candles.length}`)
  }
  const invalid = validateStrategy(cfg.strategy)
  if (invalid) throw new Error(invalid)
  const fee = 1 - (cfg.feeBps ?? 10) / 10_000
  const slip = (cfg.slippageBps ?? 10) / 10_000

  const closes = candles.map((c) => c.close)
  const rsi = rsiSeries(closes, cfg.strategy.kind === 'rsi_reversion' ? (cfg.strategy.period ?? 14) : 14) ?? []

  const trades: BacktestTrade[] = []
  const equity: number[] = []
  let equityNow = 1
  let inPosition = false
  let pending: 'enter' | 'exit' | undefined = undefined
  let entryPrice = 0
  let entryTime = 0
  let entryIndex = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!

    // 1. Fill a signal decided at close[i-1]: execute at THIS candle's open.
    if (pending === 'exit' && inPosition) {
      const exitPrice = c.open * (1 - slip) * fee
      trades.push({
        entryTime,
        exitTime: c.time,
        entryPrice,
        exitPrice,
        returnPct: (exitPrice / entryPrice - 1) * 100,
        holdCandles: i - entryIndex,
      })
      inPosition = false
      pending = undefined
    } else if (pending === 'enter' && !inPosition) {
      entryPrice = c.open * (1 + slip) * fee
      entryTime = c.time
      entryIndex = i
      inPosition = true
      pending = undefined
    }

    // 2. Mark equity at this close. Entered today: open→close belongs to us;
    // held over: close→close.
    if (inPosition) equityNow *= c.close / (i === entryIndex ? c.open : candles[i - 1]!.close)
    equity.push(equityNow)

    // 3. Decide from THIS close; the fill lands at the NEXT candle's open.
    if (i < warmup(cfg.strategy) - 1 || i === candles.length - 1) continue
    const want = targetPosition(cfg.strategy, i, candles, rsi)
    if (want === KEEP) continue
    if (want === 1 && !inPosition) pending = 'enter'
    if (want === 0 && inPosition) pending = 'exit'
  }

  // ── Metrics ──
  // An open position at window end is still real P&L: record it marked to
  // market (exit = last close) so the trade list and exposure tell the truth.
  const lastCandle = candles[candles.length - 1]!
  if (inPosition) {
    trades.push({
      entryTime,
      exitTime: lastCandle.time,
      entryPrice,
      exitPrice: lastCandle.close,
      returnPct: (lastCandle.close / entryPrice - 1) * 100,
      holdCandles: candles.length - 1 - entryIndex,
      open: true,
    })
  }
  const totalReturnPct = (equityNow - 1) * 100
  const first = candles[0]!.close
  const last = candles[candles.length - 1]!.close
  const buyHoldReturnPct = (last / first - 1) * 100
  const wins = trades.filter((t) => t.returnPct > 0)
  const losses = trades.filter((t) => t.returnPct <= 0)
  const grossWin = wins.reduce((a, t) => a + t.returnPct, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.returnPct, 0))
  const maxDd = (() => {
    let peak = equity[0] ?? 1
    let dd = 0
    for (const e of equity) {
      peak = Math.max(peak, e)
      dd = Math.max(dd, (peak - e) / peak)
    }
    return dd
  })()
  const inMarket = trades.reduce((a, t) => a + t.holdCandles, 0)
  const warnings: string[] = []
  if (trades.length < 5) {
    warnings.push(`only ${trades.length} trade(s) — sample too small to trust; widen the window or loosen the entry`)
  }
  if (inPosition) warnings.push('position still open at window end — its P&L is marked to market, not realized')
  if (totalReturnPct <= 0) warnings.push('strategy returned ≤ 0 after costs — no edge on this window')

  return {
    symbol: cfg.symbol.toUpperCase(),
    interval: cfg.interval,
    strategyLabel: strategyLabel(cfg.strategy),
    candles: candles.length,
    fromTime: candles[0]!.time,
    toTime: candles[candles.length - 1]!.time,
    trades,
    metrics: {
      totalReturnPct: round2(totalReturnPct),
      buyHoldReturnPct: round2(buyHoldReturnPct),
      alphaPct: round2(totalReturnPct - buyHoldReturnPct),
      winRatePct: round2(trades.length ? (wins.length / trades.length) * 100 : 0),
      profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : round2(grossWin / grossLoss),
      expectancyPct: round2(trades.length ? (grossWin - grossLoss) / trades.length : 0),
      maxDrawdownPct: round2(maxDd * 100),
      exposurePct: round2((inMarket / candles.length) * 100),
    },
    warnings,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Report formatting ────────────────────────────────────────────────────────

function when(ts: number, interval: string): string {
  const d = new Date(ts * 1000)
  return interval === 'daily' ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16).replace('T', ' ')
}

export function formatBacktestReport(r: BacktestResult): string {
  const lines: string[] = []
  lines.push(
    `📊 BACKTEST ${r.symbol} ${r.interval} — ${r.strategyLabel}`,
    `window: ${when(r.fromTime, r.interval)} → ${when(r.toTime, r.interval)} (${r.candles} candles, long/flat, fees+slippage 10bps/side)`,
    '',
    `• total return ${r.metrics.totalReturnPct > 0 ? '+' : ''}${r.metrics.totalReturnPct}%` +
      ` (buy&hold ${r.metrics.buyHoldReturnPct > 0 ? '+' : ''}${r.metrics.buyHoldReturnPct}% → alpha ${r.metrics.alphaPct > 0 ? '+' : ''}${r.metrics.alphaPct}%)`,
    `• trades ${r.trades.length} · win rate ${r.metrics.winRatePct}% · profit factor ${Number.isFinite(r.metrics.profitFactor) ? r.metrics.profitFactor : '∞'}`,
    `• expectancy/trade ${r.metrics.expectancyPct}% · max drawdown ${r.metrics.maxDrawdownPct}% · time in market ${r.metrics.exposurePct}%`,
  )
  if (r.trades.length > 0) {
    lines.push('', 'last trades:')
    for (const t of r.trades.slice(-5)) {
      lines.push(
        `  ${when(t.entryTime, r.interval)} → ${when(t.exitTime, r.interval)}  ${t.returnPct > 0 ? '+' : ''}${round2(t.returnPct)}% (${t.holdCandles} candles${t.open ? ', still open — marked to market' : ''})`,
      )
    }
  }
  if (r.warnings.length > 0) lines.push('', ...r.warnings.map((w) => `⚠️ ${w}`))
  lines.push(
    '',
    `One backtest is a LOOK, not a gate: a rule that worked on one window may be overfit.` +
      ` Before it shapes real sizing it still has to survive the standing gates ` +
      `(graded live signals, positive expectancy vs BTC, principal sign-off).`,
  )
  return lines.join('\n')
}
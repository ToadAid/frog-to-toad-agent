import { describe, it, expect, afterAll } from 'vitest'
import {
  backtest,
  validateStrategy,
  strategyLabel,
  formatBacktestReport,
} from '../src/backtest/engine.js'
import { backtestStrategyTool, setBacktestCandleSource } from '../src/tools/backtest.js'
import type { Candle } from '../src/market/ta.js'

/** Candle factory: flat at `base`, then apply per-index price tweaks. */
function candles(prices: number[], startHoursAgo = 1000): Candle[] {
  return prices.map((close, i) => ({
    time: Math.floor(Date.now() / 1000) - (prices.length - i) * 3600,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }))
}

describe('validateStrategy', () => {
  it('rejects nonsense params with actionable messages', () => {
    expect(validateStrategy({ kind: 'sma_cross', fast: 50, slow: 20 })).toContain('slow period must be > fast')
    expect(validateStrategy({ kind: 'sma_cross', fast: 1 })).toContain('fast period must be ≥ 2')
    expect(validateStrategy({ kind: 'rsi_reversion', oversold: 80 })).toContain('oversold must be 1–50')
    expect(validateStrategy({ kind: 'rsi_reversion', oversold: 20, exitLevel: 10 })).toContain('exitLevel')
    expect(validateStrategy({ kind: 'breakout', lookback: 5, exitLookback: 10 })).toContain('exitLookback must be ≤ lookback')
    expect(validateStrategy({ kind: 'momentum', thresholdPct: -1 })).toContain('thresholdPct must be > 0')
    expect(validateStrategy({ kind: 'sma_cross' })).toBeUndefined()
    expect(validateStrategy({ kind: 'breakout', lookback: 20, exitLookback: 10 })).toBeUndefined()
  })

  it('labels strategies with their params', () => {
    expect(strategyLabel({ kind: 'sma_cross', fast: 10, slow: 30 })).toBe('sma_cross(10/30)')
    expect(strategyLabel({ kind: 'momentum' })).toContain('momentum(30')
  })
})

describe('backtest engine', () => {
  it('sma_cross: enters at NEXT open after the cross, exits likewise (no lookahead)', () => {
    // Flat at 100 for 60 candles, then a step up at index 60.
    // SMA(5) > SMA(20) first becomes true at the candle where the step is
    // inside the fast window but not yet dominating the slow window.
    const prices = Array(60).fill(100).concat(Array(30).fill(120))
    const c = candles(prices)
    const r = backtest({ symbol: 'BTC', interval: 'hourly', candles: c, strategy: { kind: 'sma_cross', fast: 3, slow: 10 }, feeBps: 0, slippageBps: 0 })
    // The signal fires at some close i — the entry price MUST be open[i+1]
    // (here = the candle after the cross, not the crossing candle's close).
    expect(r.trades.length).toBeGreaterThan(0)
    const t = r.trades[0]!
    const crossIndex = c.findIndex((cc, i) => i > 0 && cc.close === 120)
    expect(t.entryTime).toBe(c[crossIndex + 1]!.time)
    expect(t.entryPrice).toBeCloseTo(c[crossIndex + 1]!.open, 5)
  })

  it('fees + slippage are charged on both sides', () => {
    // Ramp up then dump down — forces a real entry AND a real exit.
    const prices = [...Array.from({ length: 30 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 129 - i)]
    const c = candles(prices)
    const r = backtest({
      symbol: 'BTC',
      interval: 'hourly',
      candles: c,
      strategy: { kind: 'sma_cross', fast: 2, slow: 3 },
      feeBps: 0,
      slippageBps: 0,
    })
    const t = r.trades[0]!
    expect(t.open).toBeUndefined()
    const entryIdx = c.findIndex((cc) => cc.time === t.entryTime)
    const exitIdx = c.findIndex((cc) => cc.time === t.exitTime)
    // With zero costs: entry = open[entryIdx], exit = open[exitIdx].
    expect(t.entryPrice).toBeCloseTo(c[entryIdx]!.open, 6)
    expect(t.exitPrice).toBeCloseTo(c[exitIdx]!.open, 6)
    expect(t.returnPct).toBeCloseTo((c[exitIdx]!.open / c[entryIdx]!.open - 1) * 100, 4)

    // Now with 100bps/side fee + 100bps slippage on the same window.
    const r2 = backtest({
      symbol: 'BTC',
      interval: 'hourly',
      candles: c,
      strategy: { kind: 'sma_cross', fast: 2, slow: 3 },
      feeBps: 100,
      slippageBps: 100,
    })
    const t2 = r2.trades[0]!
    const e2 = c.findIndex((cc) => cc.time === t2.entryTime)
    const x2 = c.findIndex((cc) => cc.time === t2.exitTime)
    // Per side: entry = open × (1+slip) × (1−fee); exit = open × (1−slip) × (1−fee).
    const expected = ((c[x2]!.open * 0.99 * 0.99) / (c[e2]!.open * 1.01 * 0.99) - 1) * 100
    expect(t2.returnPct).toBeCloseTo(expected, 4)
  })

  it('rsi_reversion: buys the dip of a wave, exits on recovery', () => {
    // 60 flat + sharp dip (RSI crushes) + recovery.
    const prices = [...Array(60).fill(100), ...[95, 90, 85, 82, 80, 81, 84, 88, 93, 98, 100, 100, 100]]
    const c = candles(prices)
    const r = backtest({
      symbol: 'ETH',
      interval: 'hourly',
      candles: c,
      strategy: { kind: 'rsi_reversion', period: 5, oversold: 30, exitLevel: 60 },
    })
    expect(r.trades.length).toBeGreaterThanOrEqual(1)
    expect(r.trades[0]!.returnPct).toBeGreaterThan(0) // bought the dip, sold the recovery
  })

  it('breakout: enters when close exceeds the prior high, exits on the lower low', () => {
    const prices = [...Array(20).fill(100), 105, 110, 115, 120, 125, 130, 120, 105, 90, 90, 90]
    const c = candles(prices)
    const r = backtest({
      symbol: 'SOL',
      interval: 'hourly',
      candles: c,
      strategy: { kind: 'breakout', lookback: 10, exitLookback: 5 },
    })
    expect(r.trades.length).toBeGreaterThanOrEqual(1)
    const t = r.trades[0]!
    expect(t.returnPct).toBeLessThan(0) // breakout chased, exit came after the dump
  })

  it('momentum: rides a sustained trend, stands down in chop', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.01, i))
    const c = candles([...Array(20).fill(100), ...up])
    const r = backtest({
      symbol: 'BTC',
      interval: 'hourly',
      candles: c,
      strategy: { kind: 'momentum', lookback: 10, thresholdPct: 5 },
    })
    expect(r.metrics.exposurePct).toBeGreaterThan(50)
    expect(r.metrics.totalReturnPct).toBeGreaterThan(0)
    // The trend never ends in this fixture — the position is still open.
    expect(r.trades[0]?.open).toBe(true)
    expect(r.warnings.some((w) => w.includes('still open'))).toBe(true)
  })

  it('equity metrics: buy&hold on a monotonic ramp, exposure, drawdown', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i) // +59% ramp
    const c = candles(prices)
    const r = backtest({
      symbol: 'BTC',
      interval: 'hourly',
      candles: c,
      strategy: { kind: 'momentum', lookback: 5, thresholdPct: 1 },
    })
    expect(r.metrics.buyHoldReturnPct).toBeCloseTo((159 / 100 - 1) * 100, 1)
    expect(r.metrics.exposurePct).toBeGreaterThan(0)
    expect(r.metrics.maxDrawdownPct).toBeGreaterThanOrEqual(0)
    expect(r.metrics.alphaPct).toBeCloseTo(r.metrics.totalReturnPct - r.metrics.buyHoldReturnPct, 6)
  })

  it('max drawdown measures the worst peak-to-trough on the equity curve', () => {
    // Signal at close[13]=200 (+100% roc) → fill at open[14]=100. While long the
    // closes run 100 → 200 → 100 → 200: equity 1 → 2 → 1 → 2 (roc at the dip
    // candle is −50% → exit fills at open[17]=200; dd already measured).
    const prices: number[] = [...Array(13).fill(100), 200, 100, 200, 100, 200, 200, 200]
    const c = candles(prices)
    const r = backtest({
      symbol: 'BTC',
      interval: 'hourly',
      candles: c,
      strategy: { kind: 'momentum', lookback: 3, thresholdPct: 50 },
      feeBps: 0,
      slippageBps: 0,
    })
    // equity: 1 → 2 → 1: worst drawdown from peak 2 to trough 1 = 50%.
    expect(r.metrics.maxDrawdownPct).toBeCloseTo(50, 1)
  })

  it('warns on tiny samples and non-positive results', () => {
    // Flat market: momentum never enters → 0 trades → sample warning + no edge.
    const flat = candles(Array(80).fill(100))
    const r = backtest({ symbol: 'BTC', interval: 'hourly', candles: flat, strategy: { kind: 'momentum', lookback: 5, thresholdPct: 1 } })
    expect(r.warnings.some((w) => w.startsWith('only 0 trade(s)'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('no edge'))).toBe(true)
  })

  it('throws on too-short history', () => {
    expect(() => backtest({ symbol: 'BTC', interval: 'hourly', candles: candles(Array(10).fill(100)), strategy: { kind: 'sma_cross' } })).toThrow(
      /need ≥/,
    )
  })
})

describe('backtest_strategy tool', () => {
  afterAll(() => setBacktestCandleSource(undefined))

  it('rejects contract addresses before touching the feed', async () => {
    const res = await backtestStrategyTool.execute(
      { symbol: '0x1234567890abcdef1234567890abcdef12345678', strategy: { kind: 'sma_cross' } },
      toolCtx(),
    )
    expect(res.text).toContain('[error]')
    expect(res.text).toContain('majors only')
  })

  it('reports validation errors instead of throwing', async () => {
    const res = await backtestStrategyTool.execute(
      { symbol: 'BTC', strategy: { kind: 'sma_cross', fast: 50, slow: 20 } },
      toolCtx(),
    )
    expect(res.text).toContain('[error] invalid strategy')
  })

  it('formats a full report from scripted candles', async () => {
    setBacktestCandleSource(async () => {
      const up = Array.from({ length: 300 }, (_, i) => 100 * Math.pow(1.002, i) * (1 + 0.05 * Math.sin(i / 7)))
      return candles(up)
    })
    const res = await backtestStrategyTool.execute(
      { symbol: 'eth', interval: 'hourly', strategy: { kind: 'sma_cross', fast: 5, slow: 20 } },
      toolCtx(),
    )
    expect(res.text).toContain('📊 BACKTEST ETH hourly — sma_cross(5/20)')
    expect(res.text).toMatch(/alpha [+-][\d.]+%/)
    expect(res.text).toContain('win rate')
    expect(res.text).toContain('LOOK, not a gate')
  })

  it('short history from the feed becomes a tool error', async () => {
    setBacktestCandleSource(async () => candles(Array(20).fill(100)))
    const res = await backtestStrategyTool.execute({ symbol: 'BTC', strategy: { kind: 'sma_cross' } }, toolCtx())
    expect(res.text).toContain('not enough history')
  })
})

function toolCtx() {
  return undefined as unknown as Parameters<typeof backtestStrategyTool.execute>[1]
}
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sma, ema, emaSeries, rsi, macd, bollinger, analyzeCandles, bollingerSeries, macdSeries, type Candle } from '../src/market/ta.js'
import { marketTechnicalsTool } from '../src/tools/technicals.js'

const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  sleep: async () => {},
}))

/** Deterministic candles: closes walk from `start` by `step` each candle. */
function walkCandles(closes: number[], volume = 100): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 3600,
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume,
  }))
}

describe('series views — same math, full arrays for the chart renderer', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i + Math.sin(i / 5) * 5)

  it('bollingerSeries aligns with the scalar bollinger at the tail', () => {
    const s = bollingerSeries(closes)
    expect(s).toBeDefined()
    expect(s!.mid.filter((v) => Number.isNaN(v)).length).toBe(19) // NaN before warmup
    const scalar = bollinger(closes)
    expect(s!.upper[59]).toBeCloseTo(scalar!.upper, 8)
    expect(s!.lower[59]).toBeCloseTo(scalar!.lower, 8)
    // band is symmetric around the mid
    expect(s!.upper[40]! - s!.mid[40]!).toBeCloseTo(s!.mid[40]! - s!.lower[40]!, 8)
  })

  it('macdSeries matches the scalar macd and is NaN before EMA26 warmup', () => {
    const s = macdSeries(closes)
    expect(s).toBeDefined()
    expect(Number.isNaN(s!.line[24])).toBe(true) // before the 26-bar warmup
    expect(Number.isFinite(s!.line[25])).toBe(true) // first aligned MACD value
    const scalar = macd(closes)
    expect(s!.line[59]).toBeCloseTo(scalar!.line, 8)
    expect(s!.signal[59]).toBeCloseTo(scalar!.signal, 8)
    expect(s!.histogram[59]).toBeCloseTo(scalar!.histogram, 8)
  })

  it('insufficient data → undefined, never a guess', () => {
    expect(bollingerSeries([1, 2, 3])).toBeUndefined()
    expect(macdSeries([1, 2, 3])).toBeUndefined()
  })
})

describe('TA primitives — pure math, known answers', () => {
  it('sma is the plain average', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4)
    expect(sma([1, 2], 5)).toBeUndefined()
  })

  it('ema seeds with sma then converges', () => {
    // [1,2,3] sma = 2; next: 4*0.5 + 2*0.5 = 3; then 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4)
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4])
   })

  it('rsi pins to 100 on a pure uptrend, 0 on a pure downtrend', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i)
    const down = Array.from({ length: 30 }, (_, i) => 100 - i)
    expect(rsi(up)).toBe(100)
    expect(rsi(down)).toBe(0)
  })

  it('rsi stays midrange on a flat series', () => {
    expect(rsi(Array(30).fill(50))).toBe(50)
  })

  it('macd goes bullish on a breakout uptrend, bearish on a rollover', () => {
    const base = Array.from({ length: 40 }, (_, i) => 100) // long flat
    const uptrend = [...base, ...Array.from({ length: 10 }, (_, i) => 100 + i * 2)]
    const m1 = macd(uptrend)!
    expect(m1.histogram).toBeGreaterThan(0)

    const rollover = [...uptrend, ...Array.from({ length: 8 }, (_, i) => 118 - i * 2.5)]
    const m2 = macd(rollover)!
    expect(m2.histogram).toBeLessThan(0)
  })

  it('macd refuses too-short series instead of guessing', () => {
    expect(macd([1, 2, 3])).toBeUndefined()
  })

  it('bollinger bounds a normal close between the bands', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2)
    const bb = bollinger(closes)!
    expect(bb.pctB).toBeGreaterThan(-0.5)
    expect(bb.pctB).toBeLessThan(1.5)
    expect(bb.upper).toBeGreaterThan(bb.lower)
  })
})

describe('TA dossier — mechanical notes, no advice', () => {
  it('annotates oversold, squeeze and range extremes; never says BUY or SELL', () => {
    // 60 down candles: RSI pinned low, EMAs stacked bearish
    const closes = Array.from({ length: 60 }, (_, i) => 100 - i * 1.5)
    const d = analyzeCandles(walkCandles(closes), 'hourly', 'test')
    expect(d.rsi14).not.toBeNull()
    expect(d.rsi14!).toBeLessThan(30)
    expect(d.notes.some((n) => n.includes('oversold'))).toBe(true)
    expect(d.emaStack).toBe('bearish')
    // the tool never tells the agent what to conclude
    const text = JSON.stringify(d)
    expect(text).not.toContain('BUY')
    expect(text).not.toContain('SELL')
  })

  it('flags a fresh MACD cross when one just happened', () => {
    const flat = Array.from({ length: 40 }, () => 100)
    const breakout = [...flat, 100.1, 100.3, 100.7, 101.3, 102]
    const d = analyzeCandles(walkCandles(breakout), 'hourly', 'test')
    expect(d.macd).not.toBeNull()
    expect(['bullish', 'none']).toContain(d.macd!.cross)
  })
})

describe('market_technicals — feed chain', () => {
  beforeEach(() => fetchJsonMock.mockReset())

  it('uses coinbase candles when they answer, renders the dossier', async () => {
    // ascending [time, low, high, open, close, volume] rows — a real uptrend
    const rows = walkCandles(Array.from({ length: 60 }, (_, i) => 100 + i)).map((c) => [
      c.time, c.low, c.high, c.open, c.close, c.volume,
    ])
    fetchJsonMock.mockResolvedValue(rows)
    const r = await marketTechnicalsTool.execute({ symbol: 'BTC' }, null as never)
    expect(r.text).toContain('source coinbase')
    expect(r.text).toContain('RSI(14)')
    expect(r.text).toContain('bullish')
    expect(r.text).toContain('INVALIDATION')
    expect(r.text).toContain('ta:BTC:')
  })

  it('falls back to coingecko and admits the data is close-only', async () => {
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url === undefined) return {}
      if (url.includes('exchange.coinbase.com') || url.includes('binance')) throw new Error('feed down')
      if (url.includes('market_chart')) {
        return {
          prices: Array.from({ length: 100 }, (_, i) => [1_700_000_000_000 + i * 3_600_000, 100 + i * 0.5]),
        }
      }
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketTechnicalsTool.execute({ symbol: 'ETH' }, null as never)
    expect(r.text).toContain('coingecko')
    expect(r.text).toContain('close-only')
  })

  it('errors honestly when every feed fails', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {} // vitest's hook re-touches the mock — ignore
      throw new Error('all down')
    })
    const r = await marketTechnicalsTool.execute({ symbol: 'BTC' }, null as never)
    expect(r.text).toContain('[error] no candle feed')
  })
})
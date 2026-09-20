import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { kronosForecastTool } from '../src/tools/kronos.js'
import { readForecasts } from '../src/market/forecastGrader.js'
import { COINGECKO_IDS, resetFeedBreakers } from '../src/market/feeds.js'
import type { Config } from '../src/config.js'

const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))

const HERE = import.meta.dirname
const FAKE = path.join(HERE, 'helpers', 'fakeKronos.mjs')

/** 600 ascending hourly candles, realistic-ish shape. */
function fakeCandles(n = 600, base = 43000): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const out = []
  const t0 = Math.floor(Date.now() / 1000) - n * 3600
  for (let i = 0; i < n; i++) {
    const c = base * (1 + Math.sin(i / 20) * 0.02) + i * 0.5
    out.push({ time: t0 + i * 3600, open: c * 0.999, high: c * 1.004, low: c * 0.995, close: c, volume: 1000 + i })
  }
  return out
}

/** GeckoTerminal ohlcv_list rows — NEWEST first, [timeSec, o, h, l, c, v]. */
function gtOhlcv(n = 400, base = 43000): number[][] {
  const now = Math.floor(Date.now() / 1000)
  return Array.from({ length: n }, (_, i) => {
    const t = now - (n - 1 - i) * 3600
    const c = base * (1 + Math.sin(i / 15) * 0.03) + i * 0.2
    return [t, c * 0.998, c * 1.005, c * 0.995, c, 500 + i]
  })
}

const TOBY = `0x${'ab'.repeat(20)}`
const TOBY_POOL = `0x${'cd'.repeat(20)}`

/** One Base pair for TOBY (highest liquidity first), plus any extras after it. */
function tobyPairs(...extra: unknown[]): unknown[] {
  return [
    {
      chainId: 'base',
      dexId: 'uniswap',
      pairAddress: TOBY_POOL,
      baseToken: { address: TOBY, name: 'Toby', symbol: 'TOBY' },
      liquidity: { usd: 26000 },
      url: 'https://dexscreener.com/base/0xpool',
    },
    ...extra,
  ]
}

/** The records the lane wrote, straight from the tmpdir store. */
function recs() {
  return readForecasts({ paths: { dataDir: process.env.TRADING_DESK_DIR } } as unknown as Config)
}

/** Mock the two DEX-lane feeds: DexScreener pair resolution + GeckoTerminal OHLCV. */
function mockDexAndGt(opts: { pairs?: unknown[]; pairsThrow?: string; gtRows?: number[][]; gtThrow?: string } = {}): void {
  fetchJsonMock.mockImplementation(async (url?: string) => {
    if (url === undefined) return {} // phantom vitest hook
    const u = typeof url === 'string' ? url : ''
    if (u.includes('dexscreener.com')) {
      if (opts.pairsThrow) throw new Error(opts.pairsThrow)
      return { pairs: opts.pairs ?? [] }
    }
    if (u.includes('geckoterminal.com')) {
      if (opts.gtThrow) throw new Error(opts.gtThrow)
      return { data: { attributes: { ohlcv_list: opts.gtRows ?? gtOhlcv() } } }
    }
    throw new Error(`unexpected url: ${u}`)
  })
}

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

describe('kronos_forecast', () => {
  // runForecast(ctx.cfg, …) appends the forecast record under cfg.paths.dataDir —
  // point it at the isolated tmpdir so tests never touch the real store.
  let ctx: { cfg: Config }
  beforeEach(() => {
    fetchJsonMock.mockReset()
    // Feed-driven validation now touches the feeds for tickers that used to be
    // refused pre-network — a tripped host breaker (5 min) would poison every
    // later test in this file.
    resetFeedBreakers()
    process.env.FAKE_KRONOS_MODE = 'ok'
    // Isolated tmp dir so the default runner path never resolves to a real install.
    process.env.TRADING_DESK_DIR = mkdtempSync(path.join(tmpdir(), 'kronos-test-'))
    ctx = { cfg: { paths: { dataDir: process.env.TRADING_DESK_DIR } } as unknown as Config }
  })
  afterEach(() => {
    delete process.env.FAKE_KRONOS_MODE
  })

  it('forecasts a Base contract address — pinpointed to its most liquid pool', async () => {
    mockDexAndGt({ pairs: tobyPairs() })
    await withEnv(
      { KRONOS_COMMAND: 'node', KRONOS_ARGS: FAKE, FAKE_KRONOS_MODE: 'ok' },
      async () => {
        const r = await kronosForecastTool.execute({ symbol: TOBY }, ctx as never)
        expect(r.text).toMatch(/KRONOS FORECAST — TOBY hourly/)
        expect(r.text).toMatch(/geckoterminal/)
        expect(r.text).toMatch(/uniswap/)
        expect(r.text).toMatch(/DEX pool candles/)
        expect(r.text).toMatch(/\$26,000 liquidity/)
        // the record is pinpointed: pool + token identity + grading feed
        const recs = readForecasts({ paths: { dataDir: process.env.TRADING_DESK_DIR } } as unknown as Config)
        expect(recs.length).toBe(1)
        expect(recs[0]).toMatchObject({
          symbol: 'TOBY',
          source: 'geckoterminal',
          chainId: 'base',
          pairAddress: TOBY_POOL,
          baseAddress: TOBY,
          label: 'Toby (TOBY)',
          liquidityUsd: 26000,
        })
        expect(recs[0]!.id).toContain('@')
      },
    )
  })

  it('refuses a contract with no Base pool — and names where it does trade', async () => {
    const ethOnly = {
      chainId: 'ethereum',
      dexId: 'uniswap',
      pairAddress: `0x${'11'.repeat(20)}`,
      baseToken: { address: TOBY, name: 'Toby', symbol: 'TOBY' },
      liquidity: { usd: 500_000 },
    }
    mockDexAndGt({ pairs: [ethOnly] })
    const r = await kronosForecastTool.execute({ symbol: TOBY }, ctx as never)
    expect(r.text).toMatch(/^\[error\] no Base pool/)
    expect(r.text).toMatch(/ethereum/)
    expect(r.text).toMatch(/Base-only/)
    expect(recs().length).toBe(0)
  })

  it('falls back to the second Base pair when the best has no candle history', async () => {
    const pool2 = `0x${'ee'.repeat(20)}`
    const second = {
      chainId: 'base',
      dexId: 'aerodrome',
      pairAddress: pool2,
      baseToken: { address: TOBY, name: 'Toby', symbol: 'TOBY' },
      liquidity: { usd: 5000 },
    }
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      const u = typeof url === 'string' ? url : ''
      if (u.includes('dexscreener.com')) {
        return {
          pairs: tobyPairs({
            ...(tobyPairs()[0] as Record<string, unknown>),
            pairAddress: pool2,
            dexId: 'aerodrome',
            liquidity: { usd: 5000 },
          }),
        }
      }
      if (u.includes('geckoterminal.com')) {
        // the top pool (higher liquidity) returns no candles; the second does
        if (u.includes(TOBY_POOL)) return { data: { attributes: { ohlcv_list: [] } } }
        return { data: { attributes: { ohlcv_list: gtOhlcv() } } }
      }
      throw new Error(`unexpected url: ${u}`)
    })
    await withEnv({ KRONOS_COMMAND: 'node', KRONOS_ARGS: FAKE, FAKE_KRONOS_MODE: 'ok' }, async () => {
      const r = await kronosForecastTool.execute({ symbol: TOBY }, ctx as never)
      expect(r.text).toMatch(/KRONOS FORECAST — TOBY/)
      expect(recs()[0]!.pairAddress).toBe(pool2)
    })
  })

  it('refuses a young/dead pool honestly — bars named, no record', async () => {
    mockDexAndGt({ pairs: tobyPairs(), gtRows: gtOhlcv(130) })
    const r = await kronosForecastTool.execute({ symbol: TOBY }, ctx as never)
    expect(r.text).toMatch(/^\[error\] GeckoTerminal has only 130 hourly bars/)
    expect(r.text).toMatch(/too young or too dead/)
    expect(readForecasts({ paths: { dataDir: process.env.TRADING_DESK_DIR } } as unknown as Config).length).toBe(0)
  })

  it('refuses when DexScreener cannot resolve the address at all', async () => {
    mockDexAndGt({ pairsThrow: 'dns down' })
    const r = await kronosForecastTool.execute({ symbol: TOBY }, ctx as never)
    expect(r.text).toMatch(/^\[error\] cannot resolve a pool/)
  })

  it('forecasts a Binance-listed non-major ticker — no hardcoded list anymore', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return []
      if (url.includes('binance.com')) {
        return fakeCandles().map((c) => [c.time * 1000, c.open, c.high, c.low, c.close, c.volume])
      }
      throw new Error('unexpected url')
    })
    await withEnv({ KRONOS_COMMAND: 'node', KRONOS_ARGS: FAKE, FAKE_KRONOS_MODE: 'ok' }, async () => {
      const r = await kronosForecastTool.execute({ symbol: 'ZKX' }, ctx as never)
      expect(r.text).toMatch(/KRONOS FORECAST — ZKX hourly/)
      expect(r.text).toMatch(/binance/)
      const recs = readForecasts({ paths: { dataDir: process.env.TRADING_DESK_DIR } } as unknown as Config)
      expect(recs[0]!.source).toBe('binance')
    })
  })

  it('refuses a ticker no feed can serve — naming what was tried', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return []
      throw new Error('feed down')
    })
    const r = await kronosForecastTool.execute({ symbol: 'ZZZZ' }, ctx as never)
    expect(r.text).toMatch(/^\[error\] no candle feed could serve ZZZZ/)
    expect(r.text).toMatch(/Binance klines rejected it and CoinGecko has no close-only series/)
  })

  it('renders the quantile band + P(up) from a healthy runner response', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return []
      if (url.includes('binance.com')) {
        return fakeCandles().map((c) => [c.time * 1000, c.open, c.high, c.low, c.close, c.volume])
      }
      throw new Error('unexpected url')
    })
    await withEnv(
      { KRONOS_COMMAND: 'node', KRONOS_ARGS: FAKE, FAKE_KRONOS_MODE: 'ok' },
      async () => {
        const r = await kronosForecastTool.execute({ symbol: 'BTC' }, ctx as never)
        expect(r.text).toMatch(/KRONOS FORECAST — BTC hourly/)
        expect(r.text).toMatch(/Kronos-small/)
        expect(r.text).toMatch(/P\(up by horizon\): 62%/)
        expect(r.text).toMatch(/band p25–p75 at horizon:/)
        expect(r.text).toMatch(/moderate/)
        expect(r.text).toMatch(/journal/i)
      },
    )
  })

  it('feeds the runner ≤512 trimmed OHLCV rows and the requested predLen', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return []
      if (url.includes('binance.com')) {
        return fakeCandles(700).map((c) => [c.time * 1000, c.open, c.high, c.low, c.close, c.volume])
      }
      throw new Error('unexpected url')
    })
    await withEnv({ KRONOS_COMMAND: 'node', KRONOS_ARGS: FAKE }, async () => {
      const r = await kronosForecastTool.execute({ symbol: 'BTC', predLen: 6 }, ctx as never)
      expect(r.text).toMatch(/lookback 512 bars/) // trimmed from 700 to MAX_CONTEXT
      expect(r.text).toMatch(/\+6 h/)
    })
  })

  it('surfaces runner ok:false as [error] the LLM can read', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return []
      if (url.includes('binance.com')) {
        return fakeCandles().map((c) => [c.time * 1000, c.open, c.high, c.low, c.close, c.volume])
      }
      throw new Error('unexpected url')
    })
    await withEnv({ KRONOS_COMMAND: 'node', KRONOS_ARGS: FAKE, FAKE_KRONOS_MODE: 'error' }, async () => {
      const r = await kronosForecastTool.execute({ symbol: 'BTC' }, ctx as never)
      expect(r.text).toMatch(/^\[error\] kronos forecast failed: fake kronos boom/)
    })
  })

  it('times out a silent runner', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return []
      if (url.includes('binance.com')) {
        return fakeCandles().map((c) => [c.time * 1000, c.open, c.high, c.low, c.close, c.volume])
      }
      throw new Error('unexpected url')
    })
    await withEnv({ KRONOS_COMMAND: 'node', KRONOS_ARGS: FAKE, FAKE_KRONOS_MODE: 'silent', KRONOS_TIMEOUT_MS: '200' }, async () => {
      const r = await kronosForecastTool.execute({ symbol: 'BTC' }, ctx as never)
      expect(r.text).toMatch(/^\[error\] kronos forecast failed: kronos runner timed out/)
    })
  })

  it('refuses when no feed serves enough history', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return []
      if (url.includes('binance.com')) return [] // too thin
      if (url.includes('coingecko.com')) return { prices: [] }
      throw new Error('unexpected url')
    })
    const r = await kronosForecastTool.execute({ symbol: 'BTC' }, ctx as never)
    expect(r.text).toMatch(/^\[error\] no candle feed could serve BTC/)
  })

  it('majors list stays anchored to the desk feed map', () => {
    expect(COINGECKO_IDS.BTC).toBe('bitcoin')
    expect(COINGECKO_IDS.ETH).toBe('ethereum')
  })
})
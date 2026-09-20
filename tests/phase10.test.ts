import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { formatBrief, gatherBriefData } from '../src/rituals/brief.js'
import {
  fetchChainTvl,
  fetchTopChains,
  fetchStablecoins,
  setLlamaFetcher,
} from '../src/market/onchain.js'
import { marketOnchainTool } from '../src/tools/onchain.js'
import {
  appendForecastRecord,
  readForecasts,
  gradeDueForecasts,
  forecastAccuracy,
  forecastsPath,
} from '../src/market/forecastGrader.js'
import { runSentinel, readSentinelState, type SentinelDeps } from '../src/rituals/sentinel.js'

let dir = ''
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-phase10-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  setLlamaFetcher(undefined)
})

beforeEach(() => {
  setLlamaFetcher(undefined)
})

// ── Phase 10.1 — morning brief ───────────────────────────────────────────────

describe('formatBrief', () => {
  const base = {
    day: 'Wednesday 2 September',
    portfolio: undefined,
    dailyMaxUsd: 200,
    fng: undefined,
    news: [] as never[],
    forecasts: undefined,
  }

  it('composes deterministically — same data, same text', () => {
    const d = {
      ...base,
      portfolio: {
        positions: [
          { symbol: 'BTC', qty: 0.01, avgEntryUsd: 60000, costBasisUsd: 600, markUsd: 61200, valueUsd: 612, unrealizedPnlUsd: 12.5 },
        ],
        realizedPnlUsd: -3.2,
        realizedTodayUsd: 4.1,
        dailySpendUsd: 25,
        unrealizedPnlUsd: 12.5,
        pnlDaily: [],
        exec: { opens: 1, closes: 0, liveOpens: 1, avgOpenUsd: 600, largestOpenUsd: 600 },
        integrity: { ok: true, corruptLines: 0, orphanCloses: 0, clampedCloses: 0 },
      },
      fng: { value: 22, classification: 'Extreme Fear', weekAvg: 31, monthAvg: 40, yesterday: 25 },
      news: [{ title: 'ETF inflows hit record', link: 'https://x', source: 'Cointelegraph', publishedAt: Date.now(), summary: '' }],
      forecasts: { issued: 4, graded: 3, inBand: 2, hits: 1, directionGraded: 2, hitRatePct: 50, inBandPct: 66.7 },
    }
    const first = formatBrief(d)
    expect(formatBrief(d)).toBe(first)
    expect(first).toContain('☀️ MORNING BRIEF — Wednesday 2 September')
    expect(first).toContain('+$12.50 unrealized @ $61200')
    expect(first).toContain('day cap $25.00 / $200')
    expect(first).toContain('22/100 (Extreme Fear)')
    expect(first).toContain('extreme fear zone, historically where opportunity knocks')
    expect(first).toContain('ETF inflows hit record (Cointelegraph)')
    expect(first).toContain('2/3 landed inside its published band')
  })

  it('greed zone flips the framing to discipline', () => {
    const out = formatBrief({ ...base, fng: { value: 78, classification: 'Extreme Greed', weekAvg: 70, monthAvg: 60, yesterday: 72 } })
    expect(out).toContain('extreme greed zone, historically where discipline pays')
    expect(out).not.toContain('opportunity knocks')
  })

  it('degrades gracefully — empty data still renders a brief', () => {
    const out = formatBrief(base)
    expect(out).toContain('portfolio snapshot unavailable')
    expect(out).toContain('no forecasts graded yet')
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('NaN')
  })

  it('gather degrades section by section instead of failing the brief', async () => {
    const d = await gatherBriefData(cfg, {
      portfolio: () => Promise.reject(new Error('ledger gone')),
      fearGreed: () => Promise.resolve({ value: 50, classification: 'Neutral', weekAvg: null, monthAvg: null, yesterday: 49 }),
      news: () => Promise.reject(new Error('rss dead')),
      forecasts: () => { throw new Error('no store') },
    })
    expect(d.portfolio).toBeUndefined()
    expect(d.fng?.value).toBe(50)
    expect(d.news).toEqual([])
    expect(d.forecasts).toBeUndefined()
    expect(formatBrief(d)).toContain('MORNING BRIEF')
  })
})

// ── Phase 10.2 — onchain lane ────────────────────────────────────────────────

const chainsPayload = [
  { name: 'Ethereum', tvl: 60_000_000_000 },
  { name: 'Base', tvl: 5_400_000_000, gecko_id: 'base', tokenSymbol: 'ETH' },
  { name: 'Solana', tvl: 9_000_000_000 },
]

describe('onchain fetchers (seamed)', () => {
  it('computes 7d/30d TVL deltas from history', async () => {
    const DAY = 86_400
    const now = Math.floor(Date.now() / 1000)
    const hist = [
      { date: now - 31 * DAY, tvl: 4_000_000 },
      { date: now - 7.5 * DAY, tvl: 5_000_000 },
      { date: now - 6 * DAY, tvl: 5_200_000 },
      { date: now, tvl: 5_500_000 },
    ]
    setLlamaFetcher(async () => hist)
    const r = await fetchChainTvl('Base')
    expect(r?.tvl).toBe(5_500_000)
    // 7d anchor: newest point at/before now-7d → the 7.5d point
    expect(r?.changePct7d).toBe(10)
    // 30d anchor: the 31d-old point
    expect(r?.changePct30d).toBe(37.5)
  })

  it('ranks top chains by TVL', async () => {
    setLlamaFetcher(async () => chainsPayload)
    const top = await fetchTopChains(2)
    expect(top.map((c) => c.name)).toEqual(['Ethereum', 'Solana'])
  })

  it('aggregates stablecoin supply and 7d flow', async () => {
    setLlamaFetcher(async () => ({
      peggedAssets: [
        { name: 'Tether', symbol: 'USDT', circulating: { peggedUSD: 110_000_000 }, circulatingPrevWeek: { peggedUSD: 100_000_000 } },
        { name: 'USDC', symbol: 'USDC', circulating: { peggedUSD: 55_000_000 }, circulatingPrevWeek: { peggedUSD: 50_000_000 } },
        { name: 'dust', symbol: 'X', circulating: { peggedUSD: 100 } },
      ],
    }))
    const s = await fetchStablecoins()
    expect(s?.totalSupplyUsd).toBe(165_000_000)
    expect(s?.changePct7d).toBe(10)
    expect(s?.top[0]?.symbol).toBe('USDT')
  })
})

describe('market_onchain tool', () => {
  const ctx = null as never

  it('renders tvl view with Base spotlight', async () => {
    const DAY = 86_400
    const now = Math.floor(Date.now() / 1000)
    setLlamaFetcher(async (url: string) => {
      if (url.includes('/v2/chains')) return chainsPayload
      return [
        { date: now - 8 * DAY, tvl: 5_000_000 },
        { date: now, tvl: 5_500_000 },
      ]
    })
    const r = await marketOnchainTool.execute({ topic: 'tvl', chain: 'Base' }, ctx)
    expect(r.text).toContain('CHAIN TVL')
    expect(r.text).toContain('Ethereum')
    expect(r.text).toContain('🔍 Base spotlight')
    expect(r.text).toContain('+10.0%')
  })

  it('renders stablecoin flows with directional read', async () => {
    setLlamaFetcher(async () => ({
      peggedAssets: [
        { name: 'Tether', symbol: 'USDT', circulating: { peggedUSD: 1.1e11 }, circulatingPrevWeek: { peggedUSD: 1.05e11 } },
      ],
    }))
    const r = await marketOnchainTool.execute({ topic: 'stablecoins' }, ctx)
    expect(r.text).toContain('net liquidity INFLOW')
    expect(r.text).toContain('USDT')
  })

  it('refuses an unknown chain name instead of pretending', async () => {
    setLlamaFetcher(async (url: string) => {
      if (url.includes('/v2/chains')) return chainsPayload
      return [] // unknown chain → empty history
    })
    const r = await marketOnchainTool.execute({ topic: 'tvl', chain: 'Basey' }, ctx)
    expect(r.text).toContain('[error]')
  })
})

// ── Phase 10.3 — forecast grading ────────────────────────────────────────────

const HOUR = 3_600_000

function rec(over: Partial<Parameters<typeof appendForecastRecord>[1]> = {}): Parameters<typeof appendForecastRecord>[1] {
  const issuedAt = Date.now() - 13 * HOUR
  return {
    id: over.id ?? 'BTC-hourly-1',
    symbol: 'BTC',
    interval: 'hourly',
    issuedAt,
    issuedPrice: 60_000,
    horizonCandles: 12,
    candleMs: HOUR,
    bandLow: 58_000,
    bandHigh: 63_000,
    p50: 61_500,
    pUp: 0.7,
    movePct: 2.5,
    ...over,
  }
}

describe('forecast grading', () => {
  beforeEach(() => {
    fs.rmSync(forecastsPath(cfg), { force: true })
  })

  it('grades due records: in-band, direction, and skips not-yet-due', async () => {
    appendForecastRecord(cfg, rec({ id: 'due-in-band' }))
    appendForecastRecord(cfg, rec({ id: 'due-breach', bandLow: 70_000, bandHigh: 72_000, p50: 71_000, movePct: 18 }))
    appendForecastRecord(cfg, rec({ id: 'not-due', issuedAt: Date.now() - 1 * HOUR }))
    const r = await gradeDueForecasts(cfg, async () => 61_000)
    expect(r.graded).toHaveLength(2)
    expect(r.graded.find((g) => g.id === 'due-in-band')?.inBand).toBe(true)
    expect(r.graded.find((g) => g.id === 'due-in-band')?.directionHit).toBe(true) // forecast +2.5, actual +1.67
    expect(r.graded.find((g) => g.id === 'due-breach')?.inBand).toBe(false)
    expect(r.awaitingPrice).toBe(0)
    const stored = readForecasts(cfg)
    expect(stored.find((x) => x.id === 'not-due')?.graded).toBeUndefined()
    expect(stored.find((x) => x.id === 'due-in-band')?.graded?.actualPrice).toBe(61_000)
  })

  it('counts awaiting price and retries next run without double-grading', async () => {
    appendForecastRecord(cfg, rec({ id: 'awaiting' }))
    const r1 = await gradeDueForecasts(cfg, async () => undefined)
    expect(r1.awaitingPrice).toBe(1)
    expect(r1.graded).toHaveLength(0)
    const r2 = await gradeDueForecasts(cfg, async () => 59_000)
    expect(r2.graded).toHaveLength(1)
    const r3 = await gradeDueForecasts(cfg, async () => 59_000)
    expect(r3.graded).toHaveLength(0) // already graded — no re-grade
  })

  it('direction is null when neither model nor market committed', async () => {
    appendForecastRecord(cfg, rec({ id: 'flat', movePct: 0.05, p50: 60_030 }))
    const r = await gradeDueForecasts(cfg, async () => 60_020)
    expect(r.graded[0]?.directionHit).toBeNull()
  })

  it('accuracy folds graded records', async () => {
    appendForecastRecord(cfg, rec({ id: 'acc-1' }))
    appendForecastRecord(cfg, rec({ id: 'acc-2', movePct: -1.2, p50: 58_000 }))
    await gradeDueForecasts(cfg, async () => 60_500) // both in-band, first direction hit, second miss
    const acc = forecastAccuracy(cfg)
    expect(acc.issued).toBe(2)
    expect(acc.graded).toBe(2)
    expect(acc.inBand).toBe(2)
    expect(acc.directionGraded).toBe(2)
    expect(acc.hits).toBe(1)
  })

  it('grades a mixed book — a pool record and a ticker record in one pass', async () => {
    const POOL = `0x${'cd'.repeat(20)}`
    appendForecastRecord(
      cfg,
      rec({
        id: 'mix-pool',
        symbol: 'TOBY',
        bandLow: 9,
        bandHigh: 12,
        p50: 11,
        movePct: 5,
        source: 'geckoterminal',
        chainId: 'base',
        pairAddress: POOL,
        baseAddress: `0x${'ab'.repeat(20)}`,
        label: 'Toby (TOBY)',
      }),
    )
    appendForecastRecord(cfg, rec({ id: 'mix-ticker', symbol: 'SOL' }))
    // priceForRecord dispatches on the record: pool records price from the
    // pool, tickers from the feed — the nightly loop grades both in one pass.
    const r = await gradeDueForecasts(cfg, async (gr) => (gr.pairAddress ? 11 : 61_000))
    expect(r.graded).toHaveLength(2)
    expect(r.awaitingPrice).toBe(0)
    expect(r.graded.find((g) => g.id === 'mix-pool')).toMatchObject({ symbol: 'TOBY', inBand: true })
    expect(r.graded.find((g) => g.id === 'mix-ticker')).toMatchObject({ symbol: 'SOL', inBand: true })
    // the stored grades carry the actual prices (pool: 11, ticker: 61k)
    const stored = readForecasts(cfg)
    expect(stored.find((x) => x.id === 'mix-pool')?.graded?.actualPrice).toBe(11)
    expect(stored.find((x) => x.id === 'mix-ticker')?.graded?.actualPrice).toBe(61_000)
  })
})

// ── Phase 10.4 — proactive sentinel ──────────────────────────────────────────

function sentinelDeps(over: { nowTs: number }): SentinelDeps {
  return {
    fearGreed: () => Promise.resolve({ value: 50, classification: 'Neutral', weekAvg: null, monthAvg: null, yesterday: 50 }),
    priceNow: () => Promise.resolve({ symbol: 'BTC', usd: 60_000, source: 'coinbase' as const }),
    pricePast: () => Promise.resolve(60_000),
    stablecoins: () => Promise.resolve({ totalSupplyUsd: 1e11, changePct7d: 0.1, top: [] }),
    now: () => over.nowTs,
    statePath: path.join(dir, 'sentinel-state.json'),
  }
}

describe('sentinel', () => {
  beforeEach(() => {
    fs.rmSync(path.join(dir, 'sentinel-state.json'), { force: true })
  })

  it('stays silent when nothing is worth saying', async () => {
    const alerts = await runSentinel(cfg, sentinelDeps({ nowTs: 1_000 }))
    expect(alerts).toEqual([])
    // Zone tracked even in the mid band — crossings are judged against it.
    expect(readSentinelState(cfg, sentinelDeps({ nowTs: 1_000 })).fngZone).toBe('mid')
  })

  it('speaks on crossing INTO extreme fear — once, not every scan', async () => {
    const deps = { ...sentinelDeps({ nowTs: 1_000 }), fearGreed: () => Promise.resolve({ value: 18, classification: 'Extreme Fear', weekAvg: null, monthAvg: null, yesterday: 30 }) }
    const first = await runSentinel(cfg, deps)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('OPPORTUNITY WATCH')
    expect(first[0]).toContain('18/100')
    const second = await runSentinel(cfg, deps)
    expect(second).toEqual([]) // parked in the zone — no repeat nagging
  })

  it('flags extreme greed as RISK', async () => {
    const deps = { ...sentinelDeps({ nowTs: 1_000 }), fearGreed: () => Promise.resolve({ value: 82, classification: 'Extreme Greed', weekAvg: null, monthAvg: null, yesterday: 70 }) }
    const [alert] = await runSentinel(cfg, deps)
    expect(alert).toContain('RISK WATCH')
    expect(alert).toContain('82/100')
  })

  it('alerts on a 24h move past the threshold, then cools down that symbol', async () => {
    const deps = {
      ...sentinelDeps({ nowTs: 1_000 }),
      priceNow: (s: string) => Promise.resolve({ symbol: s, usd: s === 'BTC' ? 63_600 : 60_000, source: 'coinbase' as const }), // BTC +6% vs 60k
      pricePast: () => Promise.resolve(60_000),
    }
    const first = await runSentinel(cfg, deps)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('BTC pumped +6.0% in 24h')
    const second = await runSentinel(cfg, { ...deps, now: () => 1_000 + 3600_000 })
    expect(second).toEqual([]) // within 12h cooldown
    expect(readSentinelState(cfg, sentinelDeps({ nowTs: 1_000 })).moves?.BTC).toBe(1_000)
  })

  it('respects per-symbol threshold from config and ignores quiet majors', async () => {
    const tight = { ...cfg, sentinelMovePct: 10 } as Config
    const deps = { ...sentinelDeps({ nowTs: 1_000 }), priceNow: (s: string) => Promise.resolve({ symbol: s, usd: s === 'BTC' ? 63_600 : 60_000, source: 'coinbase' as const }), pricePast: () => Promise.resolve(60_000) }
    expect(await runSentinel(tight, deps)).toEqual([]) // +6% < 10% threshold
  })

  it('flags a stablecoin liquidity shift once per day', async () => {
    const deps = { ...sentinelDeps({ nowTs: 1_000 }), stablecoins: () => Promise.resolve({ totalSupplyUsd: 1.2e11, changePct7d: -1.8, top: [] }) }
    const first = await runSentinel(cfg, deps)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('LIQUIDITY OUTFLOW')
    expect(first[0]).toContain('-1.8%')
    const second = await runSentinel(cfg, { ...deps, now: () => 1_000 + 3600_000 })
    expect(second).toEqual([]) // 24h cooldown
  })
})
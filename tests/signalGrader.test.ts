import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { appendJsonl } from '../src/store/jsonl.js'
import { journalPath } from '../src/tools/journal.js'
import { parseSignal, gradeDueSignals, signalAccuracy, taGradesPath } from '../src/market/signalGrader.js'

const priceMock = vi.hoisted(() => vi.fn())
const benchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/market/feeds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/market/feeds.js')>()),
  getUsdPrice: (...args: unknown[]) => priceMock(...args),
  priceAt: (...args: unknown[]) => benchMock(...args),
}))

let dir = ''
let cfg: Config

const DAY = 24 * 3600_000

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-grader-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true })
  priceMock.mockReset()
  benchMock.mockReset()
})

function journalTa(symbol: string, signal: 'BUY' | 'SELL' | 'HOLD', price: number, ts: number): void {
  appendJsonl(journalPath(cfg), {
    ts,
    symbol,
    decision: `daily read: ta:${symbol}:${signal}@${price} — stack bearish, RSI neutral`,
  })
}

describe('parseSignal', () => {
  it('extracts symbol, signal and price from a journal decision', () => {
    const s = parseSignal('daily read: ta:SOL:HOLD@98.86 — stack bearish')
    expect(s).toEqual({ symbol: 'SOL', signal: 'HOLD', entryPrice: 98.86 })
    expect(parseSignal('ta:pepe:buy@0.0000034')).toEqual({ symbol: 'PEPE', signal: 'BUY', entryPrice: 0.0000034 })
  })

  it('tolerates thousands separators and rejects garbage', () => {
    expect(parseSignal('ta:BTC:BUY@77,059.72')?.entryPrice).toBe(77059.72)
    expect(parseSignal('nothing to see here')).toBeUndefined()
    expect(parseSignal('ta:BTC:BUY@0')).toBeUndefined()
  })
})

describe('gradeDueSignals — the desk audits itself', () => {
  it('skips fresh signals, grades mature ones, never grades twice', async () => {
    journalTa('BTC', 'BUY', 100, Date.now() - 2 * DAY)
    journalTa('ETH', 'SELL', 2000, Date.now() - 2 * DAY + 1000)
    journalTa('SOL', 'HOLD', 98, Date.now() - 25 * 3600_000)
    journalTa('AVAX', 'BUY', 50, Date.now() - 3600_000) // too fresh — skipped
    priceMock.mockImplementation((symbol: string) =>
      Promise.resolve(symbol === 'BTC' ? { symbol, usd: 105 } : symbol === 'ETH' ? { symbol, usd: 1900 } : { symbol, usd: 98 }),
    )
    benchMock.mockResolvedValue(undefined) // no bench history → raw-direction fallback

    const r1 = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r1.skipped).toBe(1) // fresh AVAX
    expect(r1.graded.length).toBe(3)
    const buy = r1.graded.find((g) => g.signal === 'BUY')!
    const sell = r1.graded.find((g) => g.signal === 'SELL')!
    const hold = r1.graded.find((g) => g.signal === 'HOLD')!
    expect(buy.hit).toBe(true) // 100 → 105
    expect(sell.hit).toBe(true) // 2000 → 1900 (short was right)
    expect(hold.hit).toBeNull() // HOLD has nothing to be right about
    expect(signalAccuracy(cfg).graded).toBe(2) // HOLD excluded from accuracy

    // second run: nothing re-graded
    const r2 = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r2.graded.length).toBe(0)
  })

  it('counts a BUY as a miss when price fell', async () => {
    journalTa('DOGE', 'BUY', 0.2, Date.now() - 2 * DAY)
    priceMock.mockResolvedValue({ symbol: 'DOGE', usd: 0.18 })
    const r = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r.graded[0]!.hit).toBe(false)
    expect(r.graded[0]!.movePct).toBeCloseTo(-10, 5)
    const acc = signalAccuracy(cfg)
    expect(acc.graded).toBe(1)
    expect(acc.hits).toBe(0)
    expect(acc.hitRatePct).toBe(0)
    expect(acc.avgMovePct).toBeCloseTo(-10, 5)
    expect(acc.avgAlphaPct).toBeNull() // no benchmark history → alpha unknown
  })

  it('a BUY that rose but UNDERPERFORMED the benchmark is a miss — no alpha, no credit', async () => {
    journalTa('SOL', 'BUY', 100, Date.now() - 2 * DAY)
    priceMock.mockImplementation((symbol: string) =>
      Promise.resolve(symbol === 'SOL' ? { symbol, usd: 101 } : { symbol, usd: 110 }), // SOL +1%, BTC +10%
    )
    benchMock.mockResolvedValue(100) // BTC was 100 at entry — the same window BTC did +10%
    const r = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r.graded[0]!.hit).toBe(false) // it went UP and it's still a loss vs just holding BTC
    expect(r.graded[0]!.benchSymbol).toBe('BTC')
    expect(r.graded[0]!.benchMovePct).toBeCloseTo(10, 5)
    expect(r.graded[0]!.alphaPct).toBeCloseTo(-9, 5)
  })

  it('a SELL hits when the token UNDERPERFORMS the benchmark, even if it fell less in raw terms', async () => {
    journalTa('ETH', 'SELL', 2000, Date.now() - 2 * DAY)
    priceMock.mockImplementation((symbol: string) =>
      Promise.resolve(symbol === 'ETH' ? { symbol, usd: 1950 } : { symbol, usd: 120 }), // ETH −2.5%, BTC +20%
    )
    benchMock.mockResolvedValue(100) // BTC at entry
    const r = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r.graded[0]!.hit).toBe(true) // exiting beat holding BTC by a mile
    expect(r.graded[0]!.alphaPct).toBeCloseTo(-22.5, 5)
  })

  it('holds signals that got no price and retries them next run', async () => {
    journalTa('MOG', 'SELL', 0.5, Date.now() - 2 * DAY)
    priceMock.mockResolvedValue(undefined) // feed down
    const r1 = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r1.awaitingPrice).toBe(1)
    expect(r1.graded).toEqual([])

    priceMock.mockResolvedValue({ symbol: 'MOG', usd: 0.4 })
    const r2 = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r2.graded.length).toBe(1)
    expect(r2.graded[0]!.hit).toBe(true)
  })

  it('never grades a CLOSURE entry as a fresh signal (the daily reviewer restates the pattern)', async () => {
    journalTa('SOL', 'BUY', 100, Date.now() - 4 * DAY)
    priceMock.mockResolvedValue({ symbol: 'SOL', usd: 110 })
    priceMock.mockImplementation((symbol: string) =>
      Promise.resolve(symbol === 'BTC' ? { symbol, usd: 100 } : { symbol, usd: 110 }),
    )
    benchMock.mockResolvedValue(undefined)
    const r1 = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r1.graded.length).toBe(1)

    // the reviewer journals the outcome, restating the ta: pattern — must not re-grade
    journalTa('SOL', 'BUY', 100, Date.now() - 1000) // fresh ts → fresh key, same print
    appendJsonl(journalPath(cfg), {
      ts: Date.now(),
      symbol: 'SOL',
      decision: `outcome: graded SOL BUY @100 — closed with α +10%, thesis held`,
    })
    const r2 = await gradeDueSignals(cfg, { nowMs: Date.now() })
    expect(r2.graded.length).toBe(0)
  })

  it('writes the rolling accuracy lesson once n reaches the gate, updating in place', async () => {
    for (let i = 0; i < cfg.lessonsSampleMin; i++) {
      journalTa('BTC', 'BUY', 100 + i, Date.now() - 2 * DAY - i * 1000)
    }
    priceMock.mockResolvedValue({ symbol: 'BTC', usd: 110 })
    await gradeDueSignals(cfg, { nowMs: Date.now() })
    const lessonsFile = path.join(dir, 'data', 'lessons', 'lessons.md')
    const first = fs.readFileSync(lessonsFile, 'utf8')
    expect(first).toContain('TA-signal track record')
    expect(first).toContain(`${cfg.lessonsSampleMin}/${cfg.lessonsSampleMin} directional calls beat their benchmark`)

    // more samples → the lesson line is REPLACED, not duplicated
    journalTa('ETH', 'BUY', 2000, Date.now() - 2 * DAY)
    priceMock.mockImplementation(async (symbol: string) =>
      Promise.resolve(symbol === 'ETH' ? { symbol, usd: 1900 } : { symbol, usd: 110 }),
    )
    await gradeDueSignals(cfg, { nowMs: Date.now() })
    const second = fs.readFileSync(lessonsFile, 'utf8')
    expect((second.match(/TA-signal track record/g) ?? []).length).toBe(1)
    expect(second).toContain(`n=${cfg.lessonsSampleMin + 1}, conf=high`)
    expect(second).toContain('5/') // 5 hits of 6 — the ETH BUY lost
  })
})
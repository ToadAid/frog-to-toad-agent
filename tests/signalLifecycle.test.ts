import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { appendJsonl } from '../src/store/jsonl.js'
import { journalPath } from '../src/tools/journal.js'
import {
  advanceSignal,
  signalState,
  signalHistory,
  IllegalTransitionError,
  signalLifecyclePath,
  LEGAL_TRANSITIONS,
} from '../src/market/signalLifecycle.js'
import { taGradesPath } from '../src/market/signalGrader.js'

// Prices are deterministic — never let a live feed decide a grading test.
const priceMock = vi.hoisted(() => vi.fn())
const benchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/market/feeds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/market/feeds.js')>()),
  getUsdPrice: (...args: unknown[]) => priceMock(...args),
  priceAt: (...args: unknown[]) => benchMock(...args),
}))

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-lifecycle-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true })
  priceMock.mockReset()
  benchMock.mockReset()
})

describe('signal lifecycle state machine (Nautilus steal)', () => {
  it('legal transitions: new→PROPOSED→ACTIVE→CLOSED', () => {
    const key = '1:WETH:BUY'
    advanceSignal(cfg, key, 'PROPOSED', { now: 1 })
    expect(signalState(cfg, key)).toBe('PROPOSED')
    advanceSignal(cfg, key, 'ACTIVE', { now: 2, reason: 'position opened' })
    expect(signalState(cfg, key)).toBe('ACTIVE')
    advanceSignal(cfg, key, 'CLOSED', { now: 3, reason: 'graded' })
    expect(signalState(cfg, key)).toBe('CLOSED')
    expect(signalHistory(cfg, key).map((e) => e.to)).toEqual(['PROPOSED', 'ACTIVE', 'CLOSED'])
  })

  it('short path: PROPOSED→CLOSED (withdrawn without acting) is legal', () => {
    const key = '2:SOL:SELL'
    advanceSignal(cfg, key, 'PROPOSED', { now: 1 })
    advanceSignal(cfg, key, 'CLOSED', { now: 2 })
    expect(signalState(cfg, key)).toBe('CLOSED')
  })

  it('CLOSED is TERMINAL — anything after it throws IllegalTransitionError', () => {
    const key = '3:BTC:BUY'
    advanceSignal(cfg, key, 'PROPOSED', { now: 1 })
    advanceSignal(cfg, key, 'CLOSED', { now: 2 })
    expect(() => advanceSignal(cfg, key, 'ACTIVE')).toThrow(IllegalTransitionError)
    expect(() => advanceSignal(cfg, key, 'PROPOSED')).toThrow(IllegalTransitionError)
    expect(signalState(cfg, key)).toBe('CLOSED')
  })

  it('ACTIVE can never go back to PROPOSED — no resurrection', () => {
    const key = '4:WETH:SELL'
    advanceSignal(cfg, key, 'PROPOSED', { now: 1 })
    advanceSignal(cfg, key, 'ACTIVE', { now: 2 })
    expect(() => advanceSignal(cfg, key, 'PROPOSED')).toThrow(IllegalTransitionError)
  })

  it('a brand-new signal cannot skip creation — undefined→ACTIVE is illegal', () => {
    expect(() => advanceSignal(cfg, '5:MOG:BUY', 'ACTIVE')).toThrow(IllegalTransitionError)
    expect(() => advanceSignal(cfg, '5:MOG:BUY', 'CLOSED')).toThrow(IllegalTransitionError)
  })

  it('events persist across reloads (the audit trail is the file)', () => {
    const key = '6:LINK:BUY'
    advanceSignal(cfg, key, 'PROPOSED', { now: 1, reason: 'journaled' })
    advanceSignal(cfg, key, 'CLOSED', { now: 2, reason: 'graded' })
    expect(signalHistory(cfg, key)).toHaveLength(2)
    expect(signalHistory(cfg, key)[0]?.reason).toBe('journaled')
  })

  it('different keys never bleed into each other', () => {
    advanceSignal(cfg, '7:A:BUY', 'PROPOSED', { now: 1 })
    expect(signalState(cfg, '7:B:BUY')).toBeUndefined()
  })

  it('the transition table has no exits from CLOSED', () => {
    expect(LEGAL_TRANSITIONS.CLOSED).toEqual([])
  })
})

describe('grading × lifecycle', () => {
  it('a journaled signal is graded exactly once — second pass refuses by STATE', async () => {
    const { gradeDueSignals } = await import('../src/market/signalGrader.js')
    const ts = Date.now() - 48 * 3600_000
    appendJsonl(journalPath(cfg), {
      ts,
      symbol: 'WETH',
      decision: 'daily read: ta:WETH:BUY@3000 — breakout confirmed',
    })
    priceMock.mockResolvedValue({ usd: 3300 })
    benchMock.mockResolvedValue({ usd: 60000 })
    // Two full grading passes with identical data — only ONE grade may land.
    const r1 = await gradeDueSignals(cfg, { minAgeMs: 0 })
    expect(r1.graded).toHaveLength(1)
    const r2 = await gradeDueSignals(cfg, { minAgeMs: 0 })
    expect(r2.graded).toHaveLength(0)
    expect(signalState(cfg, `${ts}:WETH:BUY`)).toBe('CLOSED')
  })

  it('an already-CLOSED signal (predated lifecycle) is skipped without a PROPOSED resurrect', async () => {
    const { gradeDueSignals } = await import('../src/market/signalGrader.js')
    const ts = Date.now() - 48 * 3600_000
    const key = `${ts}:SOL:SELL`
    advanceSignal(cfg, key, 'PROPOSED', { now: ts })
    advanceSignal(cfg, key, 'CLOSED', { now: ts + 1 })
    appendJsonl(journalPath(cfg), {
      ts,
      symbol: 'SOL',
      decision: 'daily read: ta:SOL:SELL@100 — rejection wick',
    })
    priceMock.mockResolvedValue({ usd: 90 })
    benchMock.mockResolvedValue({ usd: 60000 })
    const r = await gradeDueSignals(cfg, { minAgeMs: 0 })
    expect(r.graded).toHaveLength(0)
    expect(signalHistory(cfg, key)).toHaveLength(2) // no resurrect event appended
  })
})
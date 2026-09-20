import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { isStable, loadDeskState, setDeskState, STABLE_SYMBOLS } from '../src/safety/deskState.js'
import { guard } from '../src/safety/guard.js'
import { appendLedger, ledgerPath } from '../src/store/positions.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-state-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(ledgerPath(cfg), { force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'desk_state.json'), { force: true })
})

describe('desk trading state machine (Nautilus steal #1)', () => {
  it('missing state file reads as ACTIVE (fresh desk)', () => {
    const desk = loadDeskState(cfg)
    expect(desk.state).toBe('ACTIVE')
    expect(typeof desk.since).toBe('number')
  })

  it('corrupt state file fails CLOSED to HALTED, loudly', () => {
    fs.mkdirSync(cfg.paths.dataDir, { recursive: true })
    const file = path.join(cfg.paths.dataDir, 'desk_state.json')
    fs.writeFileSync(file, '{"state": "ACT', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const desk = loadDeskState(cfg)
      expect(desk.state).toBe('HALTED')
      expect(desk.reason).toContain('corrupt')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('setDeskState persists and roundtrips across reloads (restart survival)', () => {
    setDeskState(cfg, 'REDUCING', 'principal')
    const desk = loadDeskState(cfg)
    expect(desk.state).toBe('REDUCING')
    expect(desk.reason).toBe('principal')
  })

  it('setDeskState rejects unknown states', () => {
    expect(() => setDeskState(cfg, 'YOLO' as never)).toThrow(/invalid desk trading state/)
  })

  it('setDeskState writes atomically (no .tmp litter)', () => {
    setDeskState(cfg, 'HALTED', 'kill switch')
    const litter = fs.readdirSync(cfg.paths.dataDir).filter((f) => f.endsWith('.tmp'))
    expect(litter).toEqual([])
  })

  it('isStable matches the exit landing zone', () => {
    expect(isStable('usdc')).toBe(true)
    expect(isStable('USDS')).toBe(true)
    expect(isStable('WETH')).toBe(false)
    expect(STABLE_SYMBOLS).toContain('USDC')
  })
})

describe('guard × desk state', () => {
  it('HALTED refuses every trade with code TRADING_HALTED', () => {
    setDeskState(cfg, 'HALTED', 'test')
    const check = guard(cfg).precheckTrade({ from: 'USDC', to: 'WETH', notionalUsd: 1 })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.code).toBe('TRADING_HALTED')
  })

  it('REDUCING refuses a fresh entry with code REDUCING_ENTRY_BLOCKED', () => {
    setDeskState(cfg, 'REDUCING', 'test')
    const check = guard(cfg).precheckTrade({ from: 'USDC', to: 'WETH', notionalUsd: 1 })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.code).toBe('REDUCING_ENTRY_BLOCKED')
  })

  it('REDUCING still passes an exit of a held position into a stable', () => {
    setDeskState(cfg, 'REDUCING', 'test')
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 0.01,
      entryUsd: 3000,
      dryRun: true,
    })
    const check = guard(cfg).precheckTrade({ from: 'WETH', fromQty: 0.01, to: 'USDC', notionalUsd: 10 })
    expect(check.ok).toBe(true)
  })

  it('REDUCING refuses a rotation (held token → another risk token)', () => {
    setDeskState(cfg, 'REDUCING', 'test')
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 0.01,
      entryUsd: 3000,
      dryRun: true,
    })
    const check = guard(cfg).precheckTrade({ from: 'WETH', to: 'CBBTC', notionalUsd: 10 })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.code).toBe('REDUCING_ENTRY_BLOCKED')
  })

  it('ACTIVE trades pass the state gate and land on the usual rails', () => {
    const ok = guard(cfg).precheckTrade({ from: 'USDC', to: 'WETH', notionalUsd: 1 })
    expect(ok.ok).toBe(true)
    const capped = guard(cfg).precheckTrade({ from: 'USDC', to: 'WETH', notionalUsd: 999_999 })
    expect(capped.ok).toBe(false)
    if (!capped.ok) {
      expect(capped.code).toBe('PER_TRADE_CAP_EXCEEDED')
      expect(capped.reason).toContain('per-trade cap')
    }
  })

  it('existing denials carry stable codes', () => {
    const g = guard(cfg)
    const capped = g.precheckTrade({ from: 'USDC', to: 'ETH', notionalUsd: 10_000 })
    expect(capped.ok).toBe(false)
    if (!capped.ok) expect(capped.code).toBe('PER_TRADE_CAP_EXCEEDED')
    const blocked = guard({ ...cfg, limits: { ...cfg.limits, blockedSymbols: ['FLOKI'] } }).precheckTrade({
      from: 'USDC',
      to: 'FLOKI',
      notionalUsd: 1,
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe('SYMBOL_BLOCKED')
  })
})
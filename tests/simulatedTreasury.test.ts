import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { appendLedger, ledgerPath, readLedger } from '../src/store/positions.js'
import {
  checkApprenticeshipSpend,
  readApprenticeshipTreasury,
} from '../src/safety/simulatedTreasury.js'
import { swapExecuteTool } from '../src/tools/swap.js'

let dir: string
let cfg: Config

const SAVED = {
  TRADING_DESK_DIR: process.env['TRADING_DESK_DIR'],
  SELFTEST: process.env['SELFTEST'],
  DRY_RUN: process.env['DRY_RUN'],
  AUTONOMOUS_DRY_RUN: process.env['AUTONOMOUS_DRY_RUN'],
  APPRENTICESHIP_SEED_USD: process.env['APPRENTICESHIP_SEED_USD'],
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a1-treasury-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  process.env['DRY_RUN'] = 'true'
  process.env['AUTONOMOUS_DRY_RUN'] = 'true'
  process.env['APPRENTICESHIP_SEED_USD'] = '150'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(ledgerPath(cfg), { force: true })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Frog-to-Toad A1 finite simulated treasury', () => {
  it('starts exactly at the principal-granted seed and persists by re-folding the ledger', () => {
    expect(readApprenticeshipTreasury(cfg)).toEqual({
      ok: true,
      seedUsd: 150,
      spentUsd: 0,
      returnedUsd: 0,
      cashUsd: 150,
      cashEvents: 0,
    })

    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 0.001,
      entryUsd: 5000,
      notionalUsd: 5,
      capitalPool: 'apprenticeship',
      dryRun: true,
    })

    const firstRead = readApprenticeshipTreasury(cfg)
    const secondRead = readApprenticeshipTreasury(cfg)
    expect(firstRead).toEqual(secondRead)
    expect(firstRead).toMatchObject({
      ok: true,
      seedUsd: 150,
      spentUsd: 5,
      returnedUsd: 0,
      cashUsd: 145,
      cashEvents: 1,
    })
  })

  it('ignores legacy/unmarked dry-run trades so imported desk history cannot create or consume frog capital', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 100,
      entryUsd: 5000,
      dryRun: true,
    })
    expect(readApprenticeshipTreasury(cfg)).toMatchObject({
      ok: true,
      cashUsd: 150,
      cashEvents: 0,
    })
  })

  it('models future close proceeds as returned cash without implementing autonomous closes in A1', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 1,
      entryUsd: 5,
      notionalUsd: 5,
      capitalPool: 'apprenticeship',
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'close',
      symbol: 'WETH',
      qty: 1,
      exitUsd: 7,
      notionalUsd: 7,
      capitalPool: 'apprenticeship',
      dryRun: true,
    })
    expect(readApprenticeshipTreasury(cfg)).toMatchObject({
      ok: true,
      spentUsd: 5,
      returnedUsd: 7,
      cashUsd: 152,
      cashEvents: 2,
    })
  })

  it('fails closed if the canonical ledger contains any corrupt line', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 0.001,
      entryUsd: 5000,
      notionalUsd: 5,
      capitalPool: 'apprenticeship',
      dryRun: true,
    })
    fs.appendFileSync(ledgerPath(cfg), '{malformed-json\n', 'utf8')

    expect(readApprenticeshipTreasury(cfg)).toMatchObject({
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_LEDGER_INVALID',
      reason: expect.stringContaining('1 corrupt line'),
    })
    expect(
      checkApprenticeshipSpend(cfg, { fromSymbol: 'USDC', notionalUsd: 1 }),
    ).toMatchObject({
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_LEDGER_INVALID',
    })
  })

  it('fails closed if an apprenticeship cash event is missing deterministic notional truth', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 1,
      entryUsd: 5,
      capitalPool: 'apprenticeship',
      dryRun: true,
    })
    expect(readApprenticeshipTreasury(cfg)).toMatchObject({
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_LEDGER_INVALID',
    })
  })

  it('fails closed if the apprenticeship capital namespace ever contains a live entry', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 1,
      entryUsd: 5,
      notionalUsd: 5,
      capitalPool: 'apprenticeship',
      dryRun: false,
    })
    expect(readApprenticeshipTreasury(cfg)).toMatchObject({
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_LEDGER_INVALID',
    })
  })

  it('allows exact-cash stable deployment and refuses one cent beyond the finite bankroll', () => {
    expect(
      checkApprenticeshipSpend(cfg, { fromSymbol: 'USDC', notionalUsd: 150 }),
    ).toMatchObject({ ok: true })

    expect(
      checkApprenticeshipSpend(cfg, { fromSymbol: 'USDC', notionalUsd: 150.01 }),
    ).toMatchObject({
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_INSUFFICIENT',
    })
  })

  it('refuses autonomous non-stable rotations until the position-management cut exists', () => {
    expect(
      checkApprenticeshipSpend(cfg, { fromSymbol: 'WETH', notionalUsd: 5 }),
    ).toMatchObject({
      ok: false,
      code: 'APPRENTICESHIP_ENTRY_REQUIRES_STABLE',
    })
  })

  it('detects an already-overspent ledger and refuses to normalize negative cash to zero', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      qty: 31,
      entryUsd: 5,
      notionalUsd: 155,
      capitalPool: 'apprenticeship',
      dryRun: true,
    })
    expect(readApprenticeshipTreasury(cfg)).toMatchObject({
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_OVERSPENT',
    })
  })

  it('cannot invent simulated assets by lying about expectedToAmount or estEntryPriceUsd', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('coingecko')) {
        return new Response(
          JSON.stringify({
            'usd-coin': { usd: 1 },
            ethereum: { usd: 2000 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (href.includes('binance')) {
        return new Response(JSON.stringify({ price: '1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (href.includes('coinbase')) {
        return new Response(JSON.stringify({ data: { amount: '1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const result = await swapExecuteTool.execute(
        {
          fromSymbol: 'USDC',
          toSymbol: 'ETH',
          fromAmount: 5,
          expectedToAmount: 100,
          estEntryPriceUsd: 0.01,
          estNotionalUsd: 5,
          rationale: 'attempt to invent simulated assets',
        },
        {
          cfg,
          agent: { name: 'executor' },
          runId: 'a1-derived-fill',
          chatId: 1,
          signal: new AbortController().signal,
          notify: async () => {},
          requestApproval: async () => 'deny',
          callSubagent: async () => '',
          send: {} as never,
        } as never,
      )

      expect(result.text).toContain('SIMULATED EXECUTION')
      expect(result.text).not.toContain('100 ETH')

      const entries = readLedger(cfg)
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry.capitalPool).toBe('apprenticeship')
      expect(entry.notionalUsd).toBeCloseTo(5, 12)
      expect(entry.qty).toBeCloseTo(0.0024975, 12)
      expect(entry.entryUsd).toBeCloseTo(5 / 0.0024975, 9)
      expect((entry.qty ?? 0) * (entry.entryUsd ?? 0)).toBeCloseTo(5, 9)

      expect(readApprenticeshipTreasury(cfg)).toMatchObject({
        ok: true,
        spentUsd: 5,
        cashUsd: 145,
        cashEvents: 1,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('cannot understate treasury debit by lying about estNotionalUsd', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('coingecko')) {
        return new Response(
          JSON.stringify({
            'usd-coin': { usd: 1 },
            ethereum: { usd: 2000 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (href.includes('binance')) {
        return new Response(JSON.stringify({ price: '1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (href.includes('coinbase')) {
        return new Response(JSON.stringify({ data: { amount: '1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // Chainlink/RPC or any other network lane: return a deterministic failure
      // shape that keeps the existing oracle sanity helper honest/inconclusive.
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const constrained = {
        ...cfg,
        apprenticeshipSeedUsd: 50,
        // Lift only the inherited generic caps INSIDE this regression test so
        // the malformed $100 call reaches the A1 treasury gate itself.
        limits: {
          ...cfg.limits,
          perTradeUsdMax: 1000,
          dailyUsdMax: 1000,
        },
      }
      const result = await swapExecuteTool.execute(
        {
          fromSymbol: 'USDC',
          toSymbol: 'ETH',
          fromAmount: 100,
          expectedToAmount: 0.05,
          estEntryPriceUsd: 2000,
          estNotionalUsd: 5,
          rationale: 'attempt to understate debit',
        },
        {
          cfg: constrained,
          agent: { name: 'executor' },
          runId: 'a1-authoritative-notional',
          chatId: 1,
          signal: new AbortController().signal,
          notify: async () => {},
          requestApproval: async () => 'deny',
          callSubagent: async () => '',
          send: {} as never,
        } as never,
      )

      expect(result.text).toContain('APPRENTICESHIP_TREASURY_INSUFFICIENT')
      expect(result.text).toContain('$50.00')
      expect(result.text).toContain('$100.00')
      expect(readApprenticeshipTreasury(constrained)).toMatchObject({
        ok: true,
        cashUsd: 50,
        cashEvents: 0,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

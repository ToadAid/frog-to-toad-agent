import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  appendLedger,
  ledgerPath,
  readLedger,
  readPositions,
} from '../src/store/positions.js'
import {
  buildSwapLedgerEntries,
  swapExecuteTool,
} from '../src/tools/swap.js'

let dir = ''
let cfg: Config

const SAVED = {
  TRADING_DESK_DIR: process.env['TRADING_DESK_DIR'],
  SELFTEST: process.env['SELFTEST'],
  DRY_RUN: process.env['DRY_RUN'],
  AUTONOMOUS_DRY_RUN: process.env['AUTONOMOUS_DRY_RUN'],
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-swap-accounting-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  process.env['DRY_RUN'] = 'true'
  process.env['AUTONOMOUS_DRY_RUN'] = 'false'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(ledgerPath(cfg), { force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'desk_state.json'), { force: true })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('D1-P6 atomic swap ledger accounting', () => {
  it('builds source close then destination open with one shared event timestamp', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-04T17:00:00.000Z'))
      const entries = buildSwapLedgerEntries(
        {
          fromSymbol: 'ETH',
          toSymbol: 'SOL',
          fromAmount: 0.01,
          rationale: 'rotate',
        },
        {
          receivedQty: 0.2,
          destinationEntryUsd: 100,
          sourceExitUsd: 2100,
          dryRun: true,
          runId: 'd1-p6-order',
        },
      )

      expect(entries).toHaveLength(2)
      expect(entries[0]).toMatchObject({
        ts: Date.parse('2026-09-04T17:00:00.000Z'),
        type: 'close',
        symbol: 'ETH',
        qty: 0.01,
        exitUsd: 2100,
        dryRun: true,
        runId: 'd1-p6-order',
      })
      expect(entries[1]).toMatchObject({
        ts: Date.parse('2026-09-04T17:00:00.000Z'),
        type: 'open',
        symbol: 'SOL',
        qty: 0.2,
        entryUsd: 100,
        dryRun: true,
        runId: 'd1-p6-order',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps A1 stable-treasury execution open-only and namespaced', () => {
    const entries = buildSwapLedgerEntries(
      {
        fromSymbol: 'USDC',
        toSymbol: 'ETH',
        fromAmount: 5,
        rationale: 'A1 entry',
      },
      {
        receivedQty: 0.0025,
        destinationEntryUsd: 2000,
        dryRun: true,
        runId: 'd1-p6-a1',
        apprenticeshipNotionalUsd: 5,
      },
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'open',
      symbol: 'ETH',
      qty: 0.0025,
      entryUsd: 2000,
      dryRun: true,
      runId: 'd1-p6-a1',
      capitalPool: 'apprenticeship',
      notionalUsd: 5,
    })
  })

  it('never smears destination fill evidence onto the source close', () => {
    const entries = buildSwapLedgerEntries(
      {
        fromSymbol: 'ETH',
        toSymbol: 'SOL',
        fromAmount: 0.01,
        rationale: 'live rotate',
      },
      {
        receivedQty: 0.19,
        destinationEntryUsd: 105,
        sourceExitUsd: 2000,
        dryRun: false,
        receipt: {
          qtySource: 'balance_delta',
          minQty: 0.18,
          txHash: '0xtx',
          approvalTxHash: '0xapproval',
        },
      },
    )

    expect(entries[0]).toMatchObject({
      type: 'close',
      txHash: '0xtx',
      approvalTxHash: '0xapproval',
    })
    expect(entries[0]?.qtySource).toBeUndefined()
    expect(entries[0]?.minQty).toBeUndefined()

    expect(entries[1]).toMatchObject({
      type: 'open',
      qtySource: 'balance_delta',
      minQty: 0.18,
      txHash: '0xtx',
      approvalTxHash: '0xapproval',
    })
  })

  it('refuses to construct a non-stable close without source price truth', () => {
    expect(() =>
      buildSwapLedgerEntries(
        {
          fromSymbol: 'ETH',
          toSymbol: 'SOL',
          fromAmount: 0.01,
          rationale: 'missing price',
        },
        {
          receivedQty: 0.2,
          destinationEntryUsd: 100,
          dryRun: true,
        },
      ),
    ).toThrow('SOURCE_EXIT_PRICE_REQUIRED')
  })

  it('writes a dry-run risk rotation as close+open through one ledger append', async () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'ETH',
      qty: 0.01,
      entryUsd: 1900,
      dryRun: true,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('coingecko')) {
        return new Response(
          JSON.stringify({
            ethereum: { usd: 2000 },
            solana: { usd: 100 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const appendSpy = vi.spyOn(fs, 'appendFileSync')
    try {
      const result = await swapExecuteTool.execute(
        {
          fromSymbol: 'ETH',
          toSymbol: 'SOL',
          fromAmount: 0.01,
          expectedToAmount: 0.2,
          estEntryPriceUsd: 100,
          estNotionalUsd: 20,
          rationale: 'D1-P6 integration',
        },
        {
          cfg,
          agent: { name: 'executor' },
          runId: 'd1-p6-integration',
          chatId: 1,
          signal: new AbortController().signal,
          notify: async () => {},
          requestApproval: async () => 'deny',
          callSubagent: async () => '',
          send: {} as never,
        } as never,
      )

      expect(result.text).toContain('SIMULATED EXECUTION')
      expect(result.text).toContain('one append')

      const ledgerCalls = appendSpy.mock.calls.filter(
        (call) => String(call[0]) === ledgerPath(cfg),
      )
      expect(ledgerCalls).toHaveLength(1)
      const payload = String(ledgerCalls[0]![1])
      expect(payload.split('\n').filter(Boolean)).toHaveLength(2)

      const entries = readLedger(cfg)
      expect(entries).toHaveLength(3)
      expect(entries[1]).toMatchObject({
        type: 'close',
        symbol: 'ETH',
        qty: 0.01,
        exitUsd: 2000,
        dryRun: true,
        runId: 'd1-p6-integration',
      })
      expect(entries[2]).toMatchObject({
        type: 'open',
        symbol: 'SOL',
        qty: 0.2,
        entryUsd: 100,
        dryRun: true,
        runId: 'd1-p6-integration',
      })

      const book = readPositions(cfg)
      expect(book.positions.find((p) => p.symbol === 'ETH')).toBeUndefined()
      expect(book.positions.find((p) => p.symbol === 'SOL')?.qty).toBeCloseTo(0.2, 12)
      expect(book.realizedPnlUsd).toBeCloseTo(1, 12)
    } finally {
      appendSpy.mockRestore()
      globalThis.fetch = originalFetch
    }
  })
})

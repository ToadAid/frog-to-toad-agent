import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { appendLedger, ledgerPath, readPositions } from '../src/store/positions.js'
import { portfolioView } from '../src/store/portfolioView.js'
import { formatBrief } from '../src/rituals/brief.js'

// Live price feeds are network-dependent — never let a rate limit decide tests.
// fetchJson returns {} → the feed chain finds no price → marks are null (honest).
const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-integrity-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  fetchJsonMock.mockResolvedValue({})
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(ledgerPath(cfg), { force: true })
})

describe('ledger integrity — fail-closed PnL (Nautilus steal)', () => {
  it('a clean ledger reports ok with zero holes', async () => {
    appendLedger(cfg, { ts: Date.now(), type: 'open', symbol: 'WETH', qty: 1, entryUsd: 3000, dryRun: true })
    const view = await portfolioView(cfg)
    expect(view.integrity).toEqual({ ok: true, corruptLines: 0, orphanCloses: 0, clampedCloses: 0 })
  })

  it('buckets daily spend by the principal timezone and preserves A1 notional authority', () => {
    const principalCfg = { ...cfg, timezone: 'Pacific/Honolulu' }
    const originalTz = process.env['TZ']
    process.env['TZ'] = 'UTC'
    vi.useFakeTimers()

    try {
      vi.setSystemTime(new Date('2026-01-02T08:00:00.000Z'))

      appendLedger(principalCfg, {
        ts: Date.parse('2026-01-02T07:30:00.000Z'),
        type: 'open',
        symbol: 'WETH',
        qty: 1,
        entryUsd: 999,
        notionalUsd: 10,
        capitalPool: 'apprenticeship',
        dryRun: true,
      })

      appendLedger(principalCfg, {
        ts: Date.parse('2026-01-02T10:30:00.000Z'),
        type: 'open',
        symbol: 'ETH',
        qty: 1,
        entryUsd: 20,
        dryRun: true,
      })

      expect(readPositions(principalCfg).dailySpendUsd).toBe(10)
    } finally {
      vi.useRealTimers()
      if (originalTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = originalTz
    }
  })

  it('same ticker contracts stay separate and a close only affects the matching address', async () => {
    const tokenA = '0x1111111111111111111111111111111111111111'
    const tokenB = '0x2222222222222222222222222222222222222222'

    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'DUP',
      tokenAddress: tokenA,
      qty: 2,
      entryUsd: 10,
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'DUP',
      tokenAddress: tokenB,
      qty: 3,
      entryUsd: 20,
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'close',
      symbol: 'DUP',
      tokenAddress: tokenA.toUpperCase(),
      qty: 1,
      exitUsd: 15,
      dryRun: true,
    })

    const book = readPositions(cfg)
    expect(book.positions).toHaveLength(2)
    const a = book.positions.find((p) => p.tokenAddress?.toLowerCase() === tokenA)
    const b = book.positions.find((p) => p.tokenAddress?.toLowerCase() === tokenB)
    expect(a).toMatchObject({ symbol: 'DUP', qty: 1, avgEntryUsd: 10, costBasisUsd: 10 })
    expect(b).toMatchObject({ symbol: 'DUP', qty: 3, avgEntryUsd: 20, costBasisUsd: 60 })
    expect(book.realizedPnlUsd).toBe(5)

    const view = await portfolioView(cfg)
    expect(view.positions).toHaveLength(2)
    expect(view.realizedPnlUsd).toBe(5)
    expect(view.integrity).toEqual({
      ok: true,
      corruptLines: 0,
      orphanCloses: 0,
      clampedCloses: 0,
    })
  })

  it('a same-ticker close with the wrong contract is orphaned and cannot consume another asset', async () => {
    const opened = '0x3333333333333333333333333333333333333333'
    const wrong = '0x4444444444444444444444444444444444444444'

    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'DUP',
      tokenAddress: opened,
      qty: 2,
      entryUsd: 10,
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'close',
      symbol: 'DUP',
      tokenAddress: wrong,
      qty: 1,
      exitUsd: 50,
      dryRun: true,
    })

    const book = readPositions(cfg)
    expect(book.positions).toEqual([
      expect.objectContaining({ symbol: 'DUP', tokenAddress: opened, qty: 2 }),
    ])
    expect(book.realizedPnlUsd).toBe(0)

    const view = await portfolioView(cfg)
    expect(view.realizedPnlUsd).toBe(0)
    expect(view.integrity.orphanCloses).toBe(1)
    expect(view.integrity.ok).toBe(false)
  })

  it('a corrupt ledger line is counted, never silent', async () => {
    appendLedger(cfg, { ts: Date.now(), type: 'open', symbol: 'WETH', qty: 1, entryUsd: 3000, dryRun: true })
    fs.appendFileSync(ledgerPath(cfg), '{"ts": "trunc')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const view = await portfolioView(cfg)
      expect(view.integrity.ok).toBe(false)
      expect(view.integrity.corruptLines).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('a close of a never-opened position is an orphan the fold refuses to count', async () => {
    appendLedger(cfg, { ts: Date.now(), type: 'close', symbol: 'GHOST', qty: 5, exitUsd: 100, dryRun: true })
    const view = await portfolioView(cfg)
    expect(view.integrity.orphanCloses).toBe(1)
    expect(view.integrity.ok).toBe(false)
  })

  it('a close larger than the held position is flagged (excess clamped = understated PnL)', async () => {
    appendLedger(cfg, { ts: Date.now(), type: 'open', symbol: 'WETH', qty: 1, entryUsd: 3000, dryRun: true })
    appendLedger(cfg, { ts: Date.now(), type: 'close', symbol: 'WETH', qty: 4, exitUsd: 3100, dryRun: true })
    const view = await portfolioView(cfg)
    expect(view.integrity.clampedCloses).toBe(1)
    expect(view.integrity.ok).toBe(false)
  })

  it('the morning brief REFUSES to present holed numbers without the warning', () => {
    const portfolio = {
      positions: [],
      realizedPnlUsd: 12.34,
      realizedTodayUsd: 0,
      dailySpendUsd: 0,
      unrealizedPnlUsd: 0,
      pnlDaily: [],
      exec: { opens: 0, closes: 0, liveOpens: 0, avgOpenUsd: null, largestOpenUsd: null },
    }
    const bad = {
      ...portfolio,
      integrity: { ok: false, corruptLines: 2, orphanCloses: 1, clampedCloses: 0 },
    }
    const good = {
      ...portfolio,
      integrity: { ok: true, corruptLines: 0, orphanCloses: 0, clampedCloses: 0 },
    }
    const text = formatBrief({
      day: 'Wednesday 3 September',
      portfolio: bad as never,
      dailyMaxUsd: 200,
      fng: undefined,
      news: [],
      forecasts: undefined,
    })
    expect(text).toContain('LEDGER INTEGRITY')
    expect(text).toContain('2 unreadable ledger line(s)')
    expect(text).toContain('1 close(s) of never-opened positions')
    expect(text).toContain('may be wrong')

    expect(
      formatBrief({
        day: 'Wednesday 3 September',
        portfolio: good as never,
        dailyMaxUsd: 200,
        fng: undefined,
        news: [],
        forecasts: undefined,
      }),
    ).not.toContain('LEDGER INTEGRITY')
  })
})
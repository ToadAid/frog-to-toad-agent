import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { appendLedger, ledgerPath } from '../src/store/positions.js'
import { loadDeskState, setDeskState } from '../src/safety/deskState.js'
import {
  actualFillQty,
  livePositionsFromLedger,
  reconcileLedgerVsWallet,
  RECONCILE_TOLERANCE,
} from '../src/safety/reconcile.js'
import { parseBalanceText, parseSwapOk } from '../src/mcp/bridge.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-reconcile-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(ledgerPath(cfg), { force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'desk_state.json'), { force: true })
})

// Reconcile only runs against a live wallet lane — tests default to dry-run.
function liveCfg(): Config {
  return { ...cfg, dryRun: false, executionMode: 'coinbase-mcp' as const }
}

describe('balance + swap payload parsers (AgentKit formats, probed live)', () => {
  it('parseBalanceText reads the LAST number of AgentKit\'s reply', () => {
    expect(parseBalanceText('Balance of USD Coin (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) at address 0x9999999999999999999999999999999999999999 is 6.0')).toBe(6.0)
    expect(parseBalanceText('Balance of Wrapped Ether (0x4200000000000000000000000000000000000006) at address 0x9999…9999 is 0.00041324')).toBeCloseTo(0.00041324)
  })

  it('parseBalanceText refuses error replies and numberless text', () => {
    expect(parseBalanceText('Error: Could not fetch token details for 0xdead')).toBeUndefined()
    expect(parseBalanceText('no numbers here')).toBeUndefined()
  })

  it('parseBalanceText ignores the desk\'s [units] metadata note (live-caught 2026-09-03)', () => {
    // The wallet server appends this to every get_balance reply — its example
    // "6" must never parse as the balance (the reconciler read "WETH onchain 6").
    const withNote =
      'Balance of Wrapped Ether (0x4200000000000000000000000000000000000006) ' +
      'at address 0x9999999999999999999999999999999999999999 is 0.00041324\n' +
      '[units] Balances above are FORMATTED human-readable units (already decimal-adjusted, e.g. "6" = 6 USDC) — NOT raw onchain units. Never divide again.'
    expect(parseBalanceText(withNote)).toBeCloseTo(0.00041324, 8)
  })

  it('parseSwapOk reads the success payload, ignores failures', () => {
    const ok = parseSwapOk('{"success":true,"transactionHash":"0x1234","toAmount":"0.00041324","minToAmount":"0.00040911"}')
    expect(ok?.transactionHash).toBe('0x1234')
    expect(ok?.toAmount).toBe('0.00041324')
    expect(parseSwapOk('{"success":false,"error":"CDP Swap API is currently only supported on base-mainnet"}')).toBeUndefined()
    expect(parseSwapOk('not json at all')).toBeUndefined()
  })
})

describe('actualFillQty — the honesty ladder', () => {
  it('prefers the onchain balance delta', () => {
    const r = actualFillQty(0, 0.00041324, 0.000416, 0.000416)
    expect(r.qtySource).toBe('balance_delta')
    expect(r.qty).toBeCloseTo(0.00041324, 10)
  })

  it('falls back to the server quote when reads fail', () => {
    expect(actualFillQty(undefined, undefined, 0.00041324, 0.000416)).toEqual({
      qty: 0.00041324,
      qtySource: 'server_quote',
    })
  })

  it('falls back to the estimate last', () => {
    expect(actualFillQty(undefined, undefined, undefined, 0.000416)).toEqual({
      qty: 0.000416,
      qtySource: 'estimate',
    })
  })

  it('never records a negative delta', () => {
    expect(actualFillQty(5, 4.9, 0.5, 0.5).qtySource).toBe('server_quote')
  })
})

describe('boot reconciliation (Nautilus live-node reconciler)', () => {
  function seededLiveLedger() {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'WETH',
      tokenAddress: '0x4200000000000000000000000000000000000006',
      qty: 0.00041324,
      entryUsd: 2400,
      dryRun: false,
    })
  }

  it('skips in dry-run and on lanes without a balance reader', async () => {
    const dry = { ...cfg, dryRun: true }
    expect(await reconcileLedgerVsWallet(dry, { getBalance: async () => 1 })).toMatchObject({ ran: false })
    const cobo = { ...cfg, executionMode: 'cobo-mcp' as const }
    expect(await reconcileLedgerVsWallet(cobo, { getBalance: async () => 1 })).toMatchObject({ ran: false })
  })

  it('dry-run entries never count as positions — sims moved no funds', () => {
    appendLedger(cfg, { ts: Date.now(), type: 'open', symbol: 'WETH', qty: 5, entryUsd: 3000, dryRun: true })
    expect(livePositionsFromLedger([]).size).toBe(0)
    const live = livePositionsFromLedger([
      { ts: 1, type: 'open', symbol: 'WETH', tokenAddress: '0xa', qty: 2, dryRun: false },
      { ts: 2, type: 'open', symbol: 'WETH', tokenAddress: '0xa', qty: 1, dryRun: false },
      { ts: 2, type: 'close', symbol: 'WETH', tokenAddress: '0xa', qty: 3, dryRun: false },
    ])
    expect(live.size).toBe(0)
  })

  it('matching wallet → clean report, no halt', async () => {
    seededLiveLedger()
    const rep = await reconcileLedgerVsWallet(liveCfg(), {
      getBalance: async () => 0.00041324,
      halt: () => {
        throw new Error('must not halt on a clean book')
      },
    })
    expect(rep.ran).toBe(true)
    expect(rep.checked).toBe(1)
    expect(rep.matched).toBe(1)
    expect(rep.halted).toBe(false)
  })

  it('phantom position (ledger > wallet beyond tolerance) fails CLOSED to HALTED', async () => {
    seededLiveLedger()
    let haltedWith: string | undefined
    const rep = await reconcileLedgerVsWallet(liveCfg(), {
      getBalance: async () => 0, // ledger says we hold WETH; wallet says no
      halt: (reason) => {
        haltedWith = reason
        setDeskState(cfg, 'HALTED', reason)
      },
    })
    expect(rep.halted).toBe(true)
    expect(rep.mismatches[0]?.symbol).toBe('WETH')
    expect(haltedWith).toContain('phantom')
    expect(loadDeskState(cfg).state).toBe('HALTED')
  })

  it('small drift within tolerance is normal, not a lie', async () => {
    seededLiveLedger() // ledger 0.00041324; 1.5% dust drift is fine
    const rep = await reconcileLedgerVsWallet(liveCfg(), {
      getBalance: async () => 0.00041324 * 0.985,
      halt: () => {
        throw new Error('tolerance must not halt')
      },
    })
    expect(rep.matched).toBe(1)
    expect(rep.halted).toBe(false)
  })

  it('wallet holding MORE than the ledger claims is a warn, not a halt', async () => {
    seededLiveLedger()
    const rep = await reconcileLedgerVsWallet(liveCfg(), {
      getBalance: async () => 5,
      halt: () => {
        throw new Error('inflated must not halt')
      },
    })
    expect(rep.inflated).toHaveLength(1)
    expect(rep.halted).toBe(false)
  })

  it('inconclusive reads are never treated as zero', async () => {
    seededLiveLedger()
    const rep = await reconcileLedgerVsWallet(liveCfg(), {
      getBalance: async () => undefined,
      halt: () => {
        throw new Error('inconclusive must not halt')
      },
    })
    expect(rep.checked).toBe(0)
    expect(rep.unchecked[0]?.reason).toContain('inconclusive')
    expect(rep.halted).toBe(false)
  })

  it('symbols without a resolvable address are unchecked, not guessed', async () => {
    appendLedger(cfg, { ts: Date.now(), type: 'open', symbol: 'TOBY', qty: 1000, entryUsd: 0.001, dryRun: false })
    const rep = await reconcileLedgerVsWallet(liveCfg(), { getBalance: async () => 0 })
    expect(rep.checked).toBe(0)
    expect(rep.unchecked[0]?.reason).toContain('no contract address')
  })

  it('tolerance is loose enough for real-world dust', () => {
    expect(RECONCILE_TOLERANCE).toBeGreaterThanOrEqual(0.01)
  })
})

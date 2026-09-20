import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { guard } from '../src/safety/guard.js'
import { appendLedger, checkCloseProvenance, ledgerPath } from '../src/store/positions.js'

let dir = ''
let cfg: Config

const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x2222222222222222222222222222222222222222'

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-close-provenance-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(ledgerPath(cfg), { force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'desk_state.json'), { force: true })
})

describe('D1-P5 canonical source-position provenance', () => {
  it('folds prior closes and accepts an exact address-bound quantity case-insensitively', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'DUP',
      tokenAddress: TOKEN_A,
      qty: 5,
      entryUsd: 10,
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: 2,
      type: 'close',
      symbol: 'DUP',
      tokenAddress: TOKEN_A,
      qty: 2,
      exitUsd: 12,
      dryRun: true,
    })

    expect(
      checkCloseProvenance(cfg, {
        symbol: 'DUP',
        tokenAddress: TOKEN_A.toUpperCase(),
        qty: 3,
      }),
    ).toEqual({
      ok: true,
      assetKey: `addr:${TOKEN_A}`,
      heldQty: 3,
      remainingQty: 0,
    })
  })

  it('does not let a same-ticker different contract borrow another position', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'DUP',
      tokenAddress: TOKEN_A,
      qty: 2,
      entryUsd: 10,
      dryRun: true,
    })

    const proof = checkCloseProvenance(cfg, {
      symbol: 'DUP',
      tokenAddress: TOKEN_B,
      qty: 1,
    })
    expect(proof.ok).toBe(false)
    if (!proof.ok) expect(proof.code).toBe('SOURCE_POSITION_NOT_FOUND')
  })

  it('refuses a requested quantity larger than the canonical holding', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'WETH',
      qty: 0.01,
      entryUsd: 3000,
      dryRun: true,
    })

    const proof = checkCloseProvenance(cfg, { symbol: 'WETH', qty: 0.02 })
    expect(proof.ok).toBe(false)
    if (!proof.ok) {
      expect(proof.code).toBe('SOURCE_POSITION_INSUFFICIENT')
      expect(proof.reason).toContain('0.01')
    }
  })

  it('fails closed when canonical JSONL contains a corrupt line', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'WETH',
      qty: 0.01,
      entryUsd: 3000,
      dryRun: true,
    })
    fs.appendFileSync(ledgerPath(cfg), '{not-json\n')

    const proof = checkCloseProvenance(cfg, { symbol: 'WETH', qty: 0.005 })
    expect(proof.ok).toBe(false)
    if (!proof.ok) expect(proof.code).toBe('SOURCE_LEDGER_CORRUPT')
  })

  it('fails closed on malformed source history that the ordinary position fold would skip', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'DUP',
      tokenAddress: TOKEN_A,
      qty: 2,
      entryUsd: 10,
      dryRun: true,
    })
    fs.appendFileSync(
      ledgerPath(cfg),
      `${JSON.stringify({
        ts: 2,
        type: 'close',
        symbol: 'DUP',
        tokenAddress: TOKEN_A,
        qty: 1,
        dryRun: true,
      })}\n`,
    )

    const proof = checkCloseProvenance(cfg, {
      symbol: 'DUP',
      tokenAddress: TOKEN_A,
      qty: 1,
    })
    expect(proof.ok).toBe(false)
    if (!proof.ok) expect(proof.code).toBe('SOURCE_LEDGER_INVALID')
  })

  it('fails closed if prior source history already contains an orphan or over-close', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'WETH',
      qty: 0.01,
      entryUsd: 3000,
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: 2,
      type: 'close',
      symbol: 'WETH',
      qty: 0.02,
      exitUsd: 3100,
      dryRun: true,
    })

    const proof = checkCloseProvenance(cfg, { symbol: 'WETH', qty: 0.001 })
    expect(proof.ok).toBe(false)
    if (!proof.ok) expect(proof.code).toBe('SOURCE_LEDGER_INVALID')
  })

  it('hard guard rejects an unowned non-stable source and accepts the exact held source', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'DUP',
      tokenAddress: TOKEN_A,
      qty: 2,
      entryUsd: 10,
      dryRun: true,
    })

    const good = guard(cfg).precheckTrade({
      from: 'DUP',
      fromAddress: TOKEN_A.toUpperCase(),
      fromQty: 1,
      to: 'USDC',
      notionalUsd: 10,
    })
    expect(good.ok).toBe(true)

    const bad = guard(cfg).precheckTrade({
      from: 'DUP',
      fromAddress: TOKEN_B,
      fromQty: 1,
      to: 'USDC',
      notionalUsd: 10,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('SOURCE_POSITION_NOT_FOUND')
  })

  it('does not let dry-run holdings authorize a live source close', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'WETH',
      qty: 0.01,
      entryUsd: 3000,
      dryRun: true,
    })

    const liveCfg = { ...cfg, dryRun: false }
    const proof = checkCloseProvenance(liveCfg, {
      symbol: 'WETH',
      qty: 0.005,
    })
    expect(proof.ok).toBe(false)
    if (!proof.ok) expect(proof.code).toBe('SOURCE_POSITION_NOT_FOUND')
  })

  it('does not let apprenticeship holdings authorize a manual source close', () => {
    appendLedger(cfg, {
      ts: 1,
      type: 'open',
      symbol: 'WETH',
      qty: 0.01,
      entryUsd: 3000,
      notionalUsd: 30,
      capitalPool: 'apprenticeship',
      dryRun: true,
    })

    const manual = checkCloseProvenance(cfg, {
      symbol: 'WETH',
      qty: 0.005,
    })
    expect(manual.ok).toBe(false)
    if (!manual.ok) expect(manual.code).toBe('SOURCE_POSITION_NOT_FOUND')

    const apprenticeship = checkCloseProvenance(cfg, {
      symbol: 'WETH',
      qty: 0.005,
      capitalPool: 'apprenticeship',
    })
    expect(apprenticeship.ok).toBe(true)
  })

  it('stable source spends remain on the existing treasury/wallet rails', () => {
    const check = guard(cfg).precheckTrade({
      from: 'USDC',
      to: 'WETH',
      notionalUsd: 1,
    })
    expect(check.ok).toBe(true)
  })
})

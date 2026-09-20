import type { Config } from '../config.js'
import { readLedger } from '../store/positions.js'
import { isStable } from './deskState.js'

const EPSILON_USD = 1e-9

export type ApprenticeshipTreasury =
  | {
      ok: true
      seedUsd: number
      spentUsd: number
      returnedUsd: number
      cashUsd: number
      cashEvents: number
    }
  | {
      ok: false
      code:
        | 'APPRENTICESHIP_SEED_UNGRANTED'
        | 'APPRENTICESHIP_TREASURY_LEDGER_INVALID'
        | 'APPRENTICESHIP_TREASURY_OVERSPENT'
      reason: string
    }

export type ApprenticeshipSpendCheck =
  | { ok: true; treasury: Extract<ApprenticeshipTreasury, { ok: true }> }
  | {
      ok: false
      code:
        | 'APPRENTICESHIP_NOT_DRY_RUN'
        | 'APPRENTICESHIP_ENTRY_REQUIRES_STABLE'
        | 'APPRENTICESHIP_INVALID_NOTIONAL'
        | 'APPRENTICESHIP_TREASURY_INSUFFICIENT'
        | Extract<ApprenticeshipTreasury, { ok: false }>['code']
      reason: string
    }

/**
 * A1 treasury is a deterministic projection of the existing canonical ledger.
 *
 * There is deliberately no balance.json and no mutable balance cache:
 *   seed grant - apprenticeship opens + apprenticeship closes = current cash.
 *
 * Legacy dry-run entries are ignored unless explicitly namespaced into the
 * apprenticeship capital pool, so importing a known-good desk cannot silently
 * consume or create the frog's bankroll.
 */
export function readApprenticeshipTreasury(cfg: Config): ApprenticeshipTreasury {
  const seedUsd = cfg.apprenticeshipSeedUsd
  if (seedUsd === undefined || !Number.isFinite(seedUsd) || seedUsd <= 0) {
    return {
      ok: false,
      code: 'APPRENTICESHIP_SEED_UNGRANTED',
      reason: 'APPRENTICESHIP_SEED_USD is not a positive finite principal-granted amount',
    }
  }

  let spentUsd = 0
  let returnedUsd = 0
  let cashEvents = 0
  let corruptLines = 0

  const entries = readLedger(cfg, {
    onCorrupt: (count) => {
      corruptLines = count
    },
  })

  if (corruptLines > 0) {
    return {
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_LEDGER_INVALID',
      reason:
        `canonical ledger contains ${corruptLines} corrupt line(s) — ` +
        `refusing simulated treasury projection`,
    }
  }

  for (const entry of entries) {
    if (entry.capitalPool !== 'apprenticeship') continue
    if (entry.type !== 'open' && entry.type !== 'close') continue

    cashEvents += 1

    if (!entry.dryRun) {
      return {
        ok: false,
        code: 'APPRENTICESHIP_TREASURY_LEDGER_INVALID',
        reason: 'apprenticeship capital pool contains a live ledger entry — refusing simulated treasury projection',
      }
    }

    const notionalUsd = entry.notionalUsd
    if (notionalUsd === undefined || !Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      return {
        ok: false,
        code: 'APPRENTICESHIP_TREASURY_LEDGER_INVALID',
        reason: `apprenticeship ${entry.type} ledger entry is missing a positive finite notionalUsd`,
      }
    }

    if (entry.type === 'open') spentUsd += notionalUsd
    else returnedUsd += notionalUsd
  }

  const cashUsd = seedUsd - spentUsd + returnedUsd
  if (cashUsd < -EPSILON_USD) {
    return {
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_OVERSPENT',
      reason: `ledger-derived apprenticeship cash is negative ($${cashUsd.toFixed(2)}) — refusing further simulated spend`,
    }
  }

  return {
    ok: true,
    seedUsd,
    spentUsd,
    returnedUsd,
    cashUsd: Math.max(0, cashUsd),
    cashEvents,
  }
}

/**
 * Hard A1 spend gate for autonomous simulated entries.
 *
 * Until the later position-management cut exists, autonomous apprenticeship
 * execution may only deploy the stable-cash treasury into a position. Selling
 * held risk assets / rotations are not classified as closes by the inherited
 * swap tool yet, so they fail closed here rather than corrupt treasury truth.
 */
export function checkApprenticeshipSpend(
  cfg: Config,
  input: { fromSymbol: string; notionalUsd: number },
): ApprenticeshipSpendCheck {
  if (!cfg.dryRun) {
    return {
      ok: false,
      code: 'APPRENTICESHIP_NOT_DRY_RUN',
      reason: 'apprenticeship treasury may only authorize DRY_RUN execution',
    }
  }

  if (!isStable(input.fromSymbol)) {
    return {
      ok: false,
      code: 'APPRENTICESHIP_ENTRY_REQUIRES_STABLE',
      reason:
        `A1 autonomous apprenticeship entries must spend from a stable treasury; ` +
        `${input.fromSymbol.toUpperCase()}→risk-asset rotations/exits wait for the position-management cut`,
    }
  }

  if (!Number.isFinite(input.notionalUsd) || input.notionalUsd <= 0) {
    return {
      ok: false,
      code: 'APPRENTICESHIP_INVALID_NOTIONAL',
      reason: 'simulated apprenticeship spend requires a positive finite USD notional',
    }
  }

  const treasury = readApprenticeshipTreasury(cfg)
  if (!treasury.ok) return treasury

  if (input.notionalUsd > treasury.cashUsd + EPSILON_USD) {
    return {
      ok: false,
      code: 'APPRENTICESHIP_TREASURY_INSUFFICIENT',
      reason:
        `finite simulated treasury has $${treasury.cashUsd.toFixed(2)} cash, ` +
        `cannot fund $${input.notionalUsd.toFixed(2)}`,
    }
  }

  return { ok: true, treasury }
}

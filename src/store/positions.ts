import path from 'node:path'
import type { Config } from '../config.js'
import { readJsonl, appendJsonl, appendJsonlBatch } from './jsonl.js'

/**
 * The ledger is the single source of truth (append-only JSONL).
 * Positions and P&L are always DERIVED by folding the ledger — never stored.
 */

export type LedgerEntry = {
  ts: number
  type: 'open' | 'close' | 'pnl_mark' | 'note'
  symbol?: string
  /** Contract address of the token — the asset identity; symbol is a label. */
  tokenAddress?: string
  chain?: string
  qty?: number
  entryUsd?: number
  exitUsd?: number
  feesUsd?: number
  /**
   * A1 apprenticeship cash debit/credit in USD.
   * `open` spends this amount; `close` returns this amount.
   * Only meaningful when capitalPool === 'apprenticeship'.
   */
  notionalUsd?: number
  /** Explicit namespace so legacy dry-run desk entries cannot contaminate the apprenticeship bankroll. */
  capitalPool?: 'apprenticeship'
  dryRun: boolean
  runId?: string
  rationale?: string
  /** How `qty` was determined: onchain balance delta > server quote > our estimate. */
  qtySource?: 'balance_delta' | 'server_quote' | 'estimate'
  /** Guaranteed-minimum output from the swap quote (honest floor for qty). */
  minQty?: number
  /** Onchain receipt hashes (live fills only) — reconciliation anchors. */
  txHash?: string
  approvalTxHash?: string
}

export type Position = {
  symbol: string
  tokenAddress?: string
  qty: number
  avgEntryUsd: number
  costBasisUsd: number
}

export type PositionBook = {
  positions: Position[]
  realizedPnlUsd: number
  dailySpendUsd: number
  dryRun: boolean
}

export function ledgerPath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'ledger.jsonl')
}

export function readLedger(cfg: Config, opts?: { onCorrupt?: (corruptLines: number) => void }): LedgerEntry[] {
  return readJsonl<LedgerEntry>(ledgerPath(cfg), opts)
}

export function appendLedger(cfg: Config, entry: LedgerEntry): void {
  appendJsonl(ledgerPath(cfg), entry)
}

/**
 * Write related ledger records through the store's single-append batch
 * primitive. Callers still own the semantic decision about which records
 * belong in one batch.
 */
export function appendLedgerBatch(cfg: Config, entries: LedgerEntry[]): void {
  appendJsonlBatch(ledgerPath(cfg), entries)
}

/**
 * Canonical ledger asset identity.
 *
 * Contract address wins whenever present; symbol is only the legacy/major
 * fallback. Trimming avoids an empty optional address collapsing unrelated
 * symbols into one key, and address matching is case-insensitive.
 */
export function ledgerAssetKey(
  entry: Pick<LedgerEntry, 'symbol' | 'tokenAddress'>,
): string | undefined {
  if (!entry.symbol) return undefined
  const address = entry.tokenAddress?.trim().toLowerCase()
  return address ? `addr:${address}` : `sym:${entry.symbol.toUpperCase()}`
}


export type CloseProvenanceCode =
  | 'SOURCE_QTY_INVALID'
  | 'SOURCE_IDENTITY_INVALID'
  | 'SOURCE_LEDGER_CORRUPT'
  | 'SOURCE_LEDGER_INVALID'
  | 'SOURCE_POSITION_NOT_FOUND'
  | 'SOURCE_POSITION_INSUFFICIENT'

export type CloseProvenanceResult =
  | { ok: true; assetKey: string; heldQty: number; remainingQty: number }
  | { ok: false; code: CloseProvenanceCode; reason: string }

const CLOSE_PROVENANCE_EPSILON = 1e-9

function positiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Prove that a requested close consumes quantity the canonical ledger
 * actually owns. Address identity wins; symbol is only the legacy/major
 * fallback. Corrupt JSON and impossible/malformed history for this source
 * fail closed instead of being silently folded away.
 *
 * This proves source ownership only. It does not append a close. Source
 * quantity is lane-bound by dry/live and capital namespace so one ledger lane
 * cannot authorize a close in another.
 */
export function checkCloseProvenance(
  cfg: Config,
  input: {
    symbol: string
    tokenAddress?: string
    qty: number
    /** Defaults to the runtime lane; explicit for tests/future callers. */
    dryRun?: boolean
    /** Undefined is the manual/legacy lane. */
    capitalPool?: 'apprenticeship'
  },
): CloseProvenanceResult {
  if (!positiveFinite(input.qty)) {
    return {
      ok: false,
      code: 'SOURCE_QTY_INVALID',
      reason: 'source close quantity must be a positive finite number',
    }
  }

  const assetKey = ledgerAssetKey(input)
  if (!assetKey) {
    return {
      ok: false,
      code: 'SOURCE_IDENTITY_INVALID',
      reason: 'source asset identity is missing',
    }
  }

  let corruptLines = 0
  const entries = readLedger(cfg, { onCorrupt: (n) => (corruptLines = n) })
  if (corruptLines > 0) {
    return {
      ok: false,
      code: 'SOURCE_LEDGER_CORRUPT',
      reason: `canonical ledger contains ${corruptLines} corrupt line(s); source quantity is not trustworthy`,
    }
  }

  const requestAddress = input.tokenAddress?.trim().toLowerCase()
  const requestedDryRun = input.dryRun ?? cfg.dryRun
  const requestedCapitalPool = input.capitalPool
  let heldQty = 0
  let sawOpen = false

  for (const entry of entries) {
    const entryAddress = entry.tokenAddress?.trim().toLowerCase()

    if (
      (entry.type === 'open' || entry.type === 'close') &&
      requestAddress &&
      entryAddress === requestAddress &&
      !entry.symbol
    ) {
      return {
        ok: false,
        code: 'SOURCE_LEDGER_INVALID',
        reason: `canonical source history for ${requestAddress} contains an entry with no symbol`,
      }
    }

    if (ledgerAssetKey(entry) !== assetKey) continue

    if (typeof entry.dryRun !== 'boolean') {
      return {
        ok: false,
        code: 'SOURCE_LEDGER_INVALID',
        reason: `canonical source history for ${input.symbol.toUpperCase()} contains an entry with invalid dryRun lane`,
      }
    }
    if (entry.capitalPool !== undefined && entry.capitalPool !== 'apprenticeship') {
      return {
        ok: false,
        code: 'SOURCE_LEDGER_INVALID',
        reason: `canonical source history for ${input.symbol.toUpperCase()} contains an unknown capital namespace`,
      }
    }

    // Source quantity authority is lane-local. Simulated holdings can never
    // authorize a live close, and apprenticeship holdings cannot be silently
    // consumed by the manual/legacy lane.
    if (
      entry.dryRun !== requestedDryRun ||
      entry.capitalPool !== requestedCapitalPool
    ) {
      continue
    }

    if (entry.type === 'open') {
      if (!positiveFinite(entry.qty) || !positiveFinite(entry.entryUsd)) {
        return {
          ok: false,
          code: 'SOURCE_LEDGER_INVALID',
          reason: `canonical source history for ${input.symbol.toUpperCase()} contains a malformed open`,
        }
      }
      sawOpen = true
      heldQty += entry.qty
      continue
    }

    if (entry.type === 'close') {
      if (!positiveFinite(entry.qty) || !positiveFinite(entry.exitUsd)) {
        return {
          ok: false,
          code: 'SOURCE_LEDGER_INVALID',
          reason: `canonical source history for ${input.symbol.toUpperCase()} contains a malformed close`,
        }
      }
      if (entry.qty > heldQty + CLOSE_PROVENANCE_EPSILON) {
        return {
          ok: false,
          code: 'SOURCE_LEDGER_INVALID',
          reason:
            `canonical source history for ${input.symbol.toUpperCase()} already contains an orphan/over-close ` +
            `(${entry.qty} > ${heldQty})`,
        }
      }
      heldQty = Math.max(0, heldQty - entry.qty)
    }
  }

  if (!sawOpen || heldQty <= CLOSE_PROVENANCE_EPSILON) {
    return {
      ok: false,
      code: 'SOURCE_POSITION_NOT_FOUND',
      reason: `canonical ledger has no open source position for ${input.symbol.toUpperCase()}`,
    }
  }

  if (input.qty > heldQty + CLOSE_PROVENANCE_EPSILON) {
    return {
      ok: false,
      code: 'SOURCE_POSITION_INSUFFICIENT',
      reason:
        `requested source quantity ${input.qty} exceeds canonical held quantity ${heldQty} ` +
        `for ${input.symbol.toUpperCase()}`,
    }
  }

  return {
    ok: true,
    assetKey,
    heldQty,
    remainingQty: Math.max(0, heldQty - input.qty),
  }
}

export function readPositions(cfg: Config): PositionBook {
  const entries = readLedger(cfg)
  const open = new Map<
    string,
    { symbol: string; tokenAddress?: string; qty: number; cost: number }
  >()
  let realized = 0

  for (const e of entries) {
    const key = ledgerAssetKey(e)
    if (!key || !e.symbol) continue
    if (e.type === 'open' && e.qty && e.entryUsd) {
      const cur = open.get(key) ?? {
        symbol: e.symbol.toUpperCase(),
        tokenAddress: e.tokenAddress?.trim() || undefined,
        qty: 0,
        cost: 0,
      }
      cur.qty += e.qty
      cur.cost += e.qty * e.entryUsd
      open.set(key, cur)
    } else if (e.type === 'close' && e.qty && e.exitUsd) {
      const cur = open.get(key)
      if (!cur) continue
      const qty = Math.min(e.qty, cur.qty)
      const avg = cur.cost / cur.qty
      realized += qty * (e.exitUsd - avg) - (e.feesUsd ?? 0)
      cur.qty -= qty
      cur.cost -= qty * avg
      if (cur.qty <= 1e-12) open.delete(key)
    }
  }

  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone })
  const today = dayFmt.format(new Date())
  const dailySpend = entries
    .filter((e) => e.type === 'open' && dayFmt.format(new Date(e.ts)) === today)
    .reduce(
      (sum, e) => sum + (e.notionalUsd ?? (e.qty ?? 0) * (e.entryUsd ?? 0)),
      0,
    )

  return {
    positions: [...open.values()].map((p) => ({
      symbol: p.symbol,
      tokenAddress: p.tokenAddress,
      qty: p.qty,
      avgEntryUsd: p.cost / p.qty,
      costBasisUsd: p.cost,
    })),
    realizedPnlUsd: realized,
    dailySpendUsd: dailySpend,
    dryRun: entries.every((e) => e.dryRun) || entries.length === 0,
  }
}
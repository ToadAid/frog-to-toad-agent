import { log } from '../log.js'
import type { Config } from '../config.js'
import { readLedger, type LedgerEntry } from '../store/positions.js'
import { BASE_TOKENS, mcpReadTokenBalance } from '../mcp/bridge.js'
import { setDeskState } from './deskState.js'

/**
 * Boot-time reconciliation (NautilusTrader live-node reconciler, desk-sized).
 * The ledger claims positions; the wallet either has the tokens or it doesn't.
 * A ledger that lies is worse than an empty one — the phantom-ledger incident
 * (2026-09-03) is exactly the failure this catches at every boot instead of
 * by the principal's sharp eye.
 *
 * Policy (deny-default):
 *  - dry-run / non-coinbase lane → skip (nothing to reconcile against)
 *  - reads that fail are INCONCLUSIVE — never treated as zero; if NOTHING
 *    could be read (lane broken), report and leave state alone
 *  - ledger claims more than the wallet holds (beyond tolerance) → phantom
 *    position → fail CLOSED: desk HALTED until the principal fixes or resumes
 *  - wallet holds more than the ledger claims → inflated: loud warn, no halt
 *    (funding, airdrops, missed closes are real but not immediately unsafe)
 */

export type ReconcileMismatch = {
  symbol: string
  tokenAddress?: string
  ledgerQty: number
  onchainQty: number
}

export type ReconcileReport = {
  ran: boolean
  skippedReason?: string
  /** Positions checked against the wallet. */
  checked: number
  matched: number
  /** Positions that could not be read (lane down, no address) — inconclusive. */
  unchecked: Array<{ symbol: string; reason: string }>
  /** Ledger > wallet: the ledger lies → fail-closed HALTED. */
  mismatches: ReconcileMismatch[]
  /** Wallet > ledger: untracked assets — warn, never halt. */
  inflated: ReconcileMismatch[]
  halted: boolean
}

/** Positions the ledger claims from LIVE fills only (dry-run sims never moved funds). */
export function livePositionsFromLedger(entries: LedgerEntry[]): Map<string, { symbol: string; tokenAddress?: string; qty: number }> {
  const open = new Map<string, { symbol: string; tokenAddress?: string; qty: number }>()
  for (const e of entries) {
    const key = e.tokenAddress?.toLowerCase() ?? (e.symbol ? `sym:${e.symbol.toUpperCase()}` : undefined)
    if (!key || !e.symbol) continue
    if (e.type === 'open' && e.qty) {
      const cur = open.get(key) ?? { symbol: e.symbol.toUpperCase(), tokenAddress: e.tokenAddress, qty: 0 }
      cur.qty += e.qty
      if (e.tokenAddress && !cur.tokenAddress) cur.tokenAddress = e.tokenAddress
      open.set(key, cur)
    } else if (e.type === 'close' && e.qty) {
      const cur = open.get(key)
      if (!cur) continue
      cur.qty -= e.qty
      if (cur.qty <= 1e-12) open.delete(key)
    }
  }
  return new Map([...open.entries()].filter(([, p]) => p.qty > 1e-12))
}

/** 2% tolerance: fees, dust, and quote-vs-fill drift are normal; lies are bigger. */
export const RECONCILE_TOLERANCE = 0.02

export type ReconcileDeps = {
  getBalance?: (tokenAddress: string) => Promise<number | undefined>
  halt?: (reason: string) => void
}

export async function reconcileLedgerVsWallet(cfg: Config, deps: ReconcileDeps = {}): Promise<ReconcileReport> {
  const getBalance = deps.getBalance ?? ((addr: string) => mcpReadTokenBalance(cfg, addr))
  const halt = deps.halt ?? ((reason: string) => setDeskState(cfg, 'HALTED', reason))

  const skipped = (skippedReason: string): ReconcileReport => ({
    ran: false,
    skippedReason,
    checked: 0,
    matched: 0,
    unchecked: [],
    mismatches: [],
    inflated: [],
    halted: false,
  })

  if (cfg.dryRun) return skipped('dry-run — simulated fills never moved funds')
  if (cfg.executionMode !== 'coinbase-mcp') return skipped(`wallet lane ${cfg.executionMode} has no balance reader wired`)

  const entries = readLedger(cfg).filter((e) => !e.dryRun)
  const positions = livePositionsFromLedger(entries)

  const report: ReconcileReport = {
    ran: true,
    checked: 0,
    matched: 0,
    unchecked: [],
    mismatches: [],
    inflated: [],
    halted: false,
  }

  for (const [key, pos] of positions) {
    const address = pos.tokenAddress ?? BASE_TOKENS[pos.symbol]
    if (!address) {
      positions.delete(key)
      report.unchecked.push({ symbol: pos.symbol, reason: 'no contract address on the ledger entry and not a desk major' })
      continue
    }
    const onchain = await getBalance(address)
    if (onchain === undefined) {
      report.unchecked.push({ symbol: pos.symbol, reason: 'wallet balance read inconclusive' })
      continue
    }
    report.checked++
    if (onchain < pos.qty * (1 - RECONCILE_TOLERANCE)) {
      report.mismatches.push({ symbol: pos.symbol, tokenAddress: address, ledgerQty: pos.qty, onchainQty: onchain })
    } else if (onchain > pos.qty * (1 + RECONCILE_TOLERANCE)) {
      report.inflated.push({ symbol: pos.symbol, tokenAddress: address, ledgerQty: pos.qty, onchainQty: onchain })
    } else {
      report.matched++
    }
  }

  if (report.mismatches.length > 0) {
    const reason = `ledger reconciles against the wallet with ${report.mismatches.length} phantom position(s): ` +
      report.mismatches
        .map((m) => `${m.symbol} ledger ${m.ledgerQty} vs onchain ${m.onchainQty}`)
        .join('; ')
    log.warn(`[reconcile] LEDGER LIES — failing CLOSED: ${reason}`)
    halt(reason)
    report.halted = true
  }
  for (const m of report.inflated) {
    log.warn(`[reconcile] wallet holds more than the ledger claims: ${m.symbol} onchain ${m.onchainQty} vs ledger ${m.ledgerQty} — untracked (funding? missed close?)`)
  }
  return report
}

/**
 * Ladder for recording an honest fill qty (best evidence wins):
 * onchain balance delta > server-quoted output > our estimate.
 */
export function actualFillQty(
  pre: number | undefined,
  post: number | undefined,
  serverToAmount: number | undefined,
  estimated: number,
): { qty: number; qtySource: 'balance_delta' | 'server_quote' | 'estimate' } {
  if (pre !== undefined && post !== undefined && post - pre >= 0) {
    return { qty: post - pre, qtySource: 'balance_delta' }
  }
  if (serverToAmount !== undefined && Number.isFinite(serverToAmount) && serverToAmount > 0) {
    return { qty: serverToAmount, qtySource: 'server_quote' }
  }
  return { qty: estimated, qtySource: 'estimate' }
}
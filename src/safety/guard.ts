import type { Config } from '../config.js'
import { checkCloseProvenance, readPositions } from '../store/positions.js'
import { isStable, loadDeskState } from './deskState.js'

/**
 * Hard safety rails — enforced in CODE, not prompt. Prompt rules are advisory;
 * these checks are not. Runs inside trade tools AND before approval cards.
 * Every refusal carries a stable CODE (NautilusTrader RiskEngine pattern) so
 * denials are auditable and summarizable in the morning brief.
 */

const SECRET_PATTERNS = [/sk-[a-zA-Z0-9_-]{8,}/g, /api[_-]?key\s*[:=]\s*\S+/gi, /bearer\s+[a-zA-Z0-9._-]{10,}/gi]

export type GuardCheck = { ok: true } | { ok: false; reason: string; code?: string }

export type TradeCheckInput = {
  from: string
  /** Contract address of the source token when known — source identity is address-first. */
  fromAddress?: string
  /** Exact source token quantity the trade proposes to consume. */
  fromQty?: number
  to: string
  /** Contract address of the buy token when known — checked against blockedAddresses. */
  toAddress?: string
  notionalUsd: number
}

export function guard(cfg: Config) {
  return {
    /** Hard pre-trade checks. Called by swap tools AND before approval cards. */
    precheckTrade(trade: TradeCheckInput): GuardCheck {
      const { limits } = cfg

      // Desk trading state gates EVERYTHING (Nautilus RiskEngine pattern):
      // HALTED refuses all orders; REDUCING allows only exits that reduce a
      // held position into a stable — rotations and fresh entries are refused.
      const desk = loadDeskState(cfg)
      if (desk.state === 'HALTED') {
        return {
          ok: false,
          reason: `desk trading state is HALTED${desk.reason ? ` (${desk.reason})` : ''} — all trades refused until the principal resumes`,
          code: 'TRADING_HALTED',
        }
      }

      const fromStable = isStable(trade.from)
      const toStable = isStable(trade.to)

      // REDUCING means true exits only. Stable-source entries and rotations
      // are state-refused before source provenance is even consulted.
      if (desk.state === 'REDUCING' && (fromStable || !toStable)) {
        return {
          ok: false,
          reason: `desk is REDUCING — only exits (selling a held position into a stable) pass; ${trade.from}→${trade.to} refused`,
          code: 'REDUCING_ENTRY_BLOCKED',
        }
      }

      // Resource law: a non-stable source must already exist in the canonical
      // ledger, under the exact address-first identity, in sufficient quantity.
      if (!fromStable) {
        const sourceProof = checkCloseProvenance(cfg, {
          symbol: trade.from,
          tokenAddress: trade.fromAddress,
          qty: trade.fromQty ?? Number.NaN,
          dryRun: cfg.dryRun,
        })
        if (!sourceProof.ok) {
          return {
            ok: false,
            reason: sourceProof.reason,
            code: sourceProof.code,
          }
        }
      }

      const book = readPositions(cfg)

      if (trade.notionalUsd > limits.perTradeUsdMax) {
        return {
          ok: false,
          reason: `notional $${trade.notionalUsd.toFixed(2)} exceeds per-trade cap $${limits.perTradeUsdMax}`,
          code: 'PER_TRADE_CAP_EXCEEDED',
        }
      }

      if (book.dailySpendUsd + trade.notionalUsd > limits.dailyUsdMax) {
        return {
          ok: false,
          reason: `daily cap: already deployed $${book.dailySpendUsd.toFixed(2)} today, cap $${limits.dailyUsdMax}`,
          code: 'DAILY_CAP_EXCEEDED',
        }
      }

      if (book.positions.length >= limits.maxOpenPositions) {
        return {
          ok: false,
          reason: `max open positions reached (${limits.maxOpenPositions}) — close something first`,
          code: 'MAX_OPEN_POSITIONS',
        }
      }

      const to = trade.to.toUpperCase()
      if (limits.blockedSymbols.some((b) => b.toUpperCase() === to)) {
        return { ok: false, reason: `${to} is on the blocked list (config.json)`, code: 'SYMBOL_BLOCKED' }
      }

      // Address-level block: a lookalike contract can't ride an allowed symbol.
      if (trade.toAddress && limits.blockedAddresses.some((b) => b.toLowerCase() === trade.toAddress!.toLowerCase())) {
        return {
          ok: false,
          reason: `contract ${trade.toAddress} is on the blocked-address list (config.json)`,
          code: 'ADDRESS_BLOCKED',
        }
      }

      // Allowlist semantics: empty = majors only (BTC/ETH/SOL/stables on the symbol map);
      // non-empty = only listed tokens.
      const allow = limits.tokenAllowlist
      if (allow.length > 0 && !allow.some((a) => a.toUpperCase() === to)) {
        return { ok: false, reason: `${to} is not in the token allowlist (config.json)`, code: 'NOT_ALLOWLISTED' }
      }

      return { ok: true }
    },

    /** Scrub anything secret-shaped before it enters the LLM context. */
    redact(text: string): string {
      let out = text
      for (const pattern of SECRET_PATTERNS) {
        out = out.replaceAll(pattern, '[redacted]')
      }
      return out
    },
  }
}
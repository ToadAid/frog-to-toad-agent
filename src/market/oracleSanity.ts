import { chainlinkPrice } from './chainlink.js'

/**
 * Pre-trade oracle sanity: the web price chain (CoinGecko/Coinbase/Binance —
 * all centralized, all scrapeable, all occasionally wrong) is cross-checked
 * against the Chainlink aggregator on Base before a trade is allowed. If the
 * two disagree beyond the threshold, something is broken or being manipulated
 * — refuse and let a human look.
 *
 * Tokens without a Chainlink feed (long-tail) skip the check: there is
 * nothing independent to compare against; DexScreener pair identity remains
 * their anchor.
 */

export type OracleSanity = {
  /** false when no Chainlink feed exists for the symbol — check skipped. */
  checked: boolean
  ok: boolean
  divergencePct?: number
  oracleUsd?: number
  webUsd?: number
  reason?: string
}

function maxDivergencePct(): number {
  const v = Number(process.env.ORACLE_MAX_DIVERGENCE_PCT)
  return Number.isFinite(v) && v > 0 ? v : 2
}

export async function oracleSanityCheck(
  symbol: string,
  webUsd: number,
  thresholdPct: number = maxDivergencePct(),
): Promise<OracleSanity> {
  const oracle = await chainlinkPrice(symbol)
  if (!oracle) return { checked: false, ok: true }

  const divergencePct = (Math.abs(webUsd - oracle.usd) / oracle.usd) * 100
  if (divergencePct > thresholdPct) {
    return {
      checked: true,
      ok: false,
      divergencePct,
      oracleUsd: oracle.usd,
      webUsd,
      reason:
        `oracle sanity: ${symbol.toUpperCase()} web price $${webUsd.toLocaleString()} vs Chainlink $${oracle.usd.toLocaleString()} ` +
        `differs by ${divergencePct.toFixed(2)}% (max ${thresholdPct}%). ` +
        `Something is wrong or being manipulated — do not trade. Verify sources manually.`,
    }
  }
  return { checked: true, ok: true, divergencePct, oracleUsd: oracle.usd, webUsd }
}
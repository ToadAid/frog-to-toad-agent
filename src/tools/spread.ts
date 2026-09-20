import { z } from 'zod'
import { defineTool } from './registry.js'
import { allPairsByAddress, isContractAddress, searchTokenPairs, shortAddress, type DexPair } from './tokens.js'

/**
 * LP spread hunter — READ-ONLY research tool, paper-trades only.
 * Finds price differences for the same token across LPs/DEXs and — critically —
 * checks whether the spread survives the round-trip tax:
 *   2× swap fee + 2× gas + slippage on both legs (constant-product approx).
 * Most "spreads" die here, and showing that IS the value: the desk journals the
 * paper signal instead of executing it, and the lessons engine grades reality.
 *
 * NOT an auto-executor. Real arb needs atomic both-legs execution we do not
 * have; sequential legs = inventory risk. Any real trade still goes through
 * swap_quote → approval per leg.
 */

/** Pairs below this liquidity quote meaningless prices (a $50 pool moves on any trade). */
const MIN_PAIR_LIQUIDITY_USD = 5_000

/** Assumed DEX swap fee per leg (Uniswap v2-style default; varies per pool). */
const SWAP_FEE_PCT = 0.3

/** Rough per-swap gas in USD by chain family. Two legs = ×2. */
const GAS_USD: Record<string, number> = {
  ethereum: 6,
  base: 0.05,
  arbitrum: 0.05,
  optimism: 0.05,
  blast: 0.05,
  polygon: 0.02,
  bsc: 0.15,
  avalanche: 0.1,
  solana: 0.01,
  pulsechain: 0.01,
  sui: 0.02,
}

export const lpSpreadTool = defineTool({
  name: 'market_lp_spread',
  description:
    'Hunt LP price differences for ONE token: lists every liquid LP/DEX price for it and computes ' +
    'whether any spread survives round-trip costs (2× swap fee + gas + slippage). Paper-trades only — ' +
    'a positive net spread is a RESEARCH SIGNAL to journal, never an auto-execute.',
  danger: 'readonly',
  input: z.object({
    query: z.string().describe('token ticker or contract address'),
    sizeUsd: z
      .number()
      .positive()
      .optional()
      .describe('assumed trade size for slippage/gas math (default $100)'),
  }),
  execute: async (input) => {
    const sizeUsd = input.sizeUsd ?? 100

    // SPREADS ARE ONLY REAL WITHIN ONE CONTRACT. A ticker like "PEPE" matches
    // dozens of unrelated tokens — comparing their prices is not arbitrage.
    // Resolve the ticker to its dominant contract first, then scan ONLY that
    // contract's LPs.
    let pairs: DexPair[]
    let identity: string
    if (isContractAddress(input.query)) {
      const addr = input.query.trim()
      pairs = await allPairsByAddress(addr)
      identity = `contract ${shortAddress(addr)} (exact)`
    } else {
      const candidates = await searchTokenPairs(input.query, 5)
      const canon = candidates[0]
      if (!canon) {
        return { text: `no DexScreener pairs found for '${input.query}' — nothing to scan` }
      }
      pairs = await allPairsByAddress(canon.baseToken.address)
      identity =
        `ticker '${input.query}' → ${canon.baseToken.symbol} ${shortAddress(canon.baseToken.address)} ` +
        `on ${canon.chainId} (highest liquidity $${Math.round(canon.liquidity?.usd ?? 0).toLocaleString()}). ` +
        `Scanning ONLY this contract's LPs — other tickers-matching tokens are excluded on purpose`
    }

    const tradable = pairs.filter(
      (p) => p.priceUsd !== undefined && (p.liquidity?.usd ?? 0) >= MIN_PAIR_LIQUIDITY_USD,
    )
    const byChain = new Map<string, DexPair[]>()
    for (const p of tradable) {
      const list = byChain.get(p.chainId) ?? []
      list.push(p)
      byChain.set(p.chainId, list)
    }
    // A chain with a single LP has no spread by definition — skip it.
    const multi = [...byChain.entries()].filter(([, list]) => list.length >= 2)

    if (multi.length === 0) {
      return {
        text:
          `No spread to hunt for ${identity}: ${byChain.size} chain(s) but every chain has a single dominant LP ` +
          `(≥$${MIN_PAIR_LIQUIDITY_USD.toLocaleString()} liquidity). No LP pair to cross — or the token is too illiquid to trust the quotes.`,
      }
    }

    const lines: string[] = [`🔍 LP SPREAD SCAN — ${identity} (size assumption $${sizeUsd})`, '']
    for (const [chain, list] of multi) {
      const sorted = [...list].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd))
      const buy = sorted[0]!
      const sell = sorted[sorted.length - 1]!
      const buyPrice = Number(buy.priceUsd)
      const sellPrice = Number(sell.priceUsd)
      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100

      // Costs: fees both legs, gas both legs, constant-product slippage approx
      // per leg: impact ≈ size / liquidity (×100 → %).
      const minLiq = Math.min(buy.liquidity?.usd ?? 0, sell.liquidity?.usd ?? 0)
      const slippagePct = (sizeUsd / Math.max(minLiq, 1)) * 100
      const gasUsd = 2 * (GAS_USD[chain] ?? 1)
      const gasPct = (gasUsd / sizeUsd) * 100
      const netPct = spreadPct - 2 * SWAP_FEE_PCT - gasPct - 2 * slippagePct

      lines.push(
        `── ${chain} (${sorted.length} LPs) ──`,
        `  BUY  ${buy.dexId} @ $${fmt(buyPrice)}  (liq $${Math.round(buy.liquidity?.usd ?? 0).toLocaleString()})`,
        `  SELL ${sell.dexId} @ $${fmt(sellPrice)}  (liq $${Math.round(sell.liquidity?.usd ?? 0).toLocaleString()})`,
        `  gross spread ${spreadPct.toFixed(2)}% → fees ${2 * SWAP_FEE_PCT}% + gas ${gasPct.toFixed(2)}% + slippage ${(2 * slippagePct).toFixed(2)}% = NET ${netPct.toFixed(2)}% ${netVerdict(netPct)}`,
        '',
      )
    }

    // Same address on multiple chains (a genuine multichain deployment) — the
    // only cross-chain case worth mentioning, and even then: bridge, not swap.
    if (byChain.size > 1) {
      const chainPrices = [...byChain.entries()].map(
        ([chain, list]) => [chain, Math.min(...list.map((p) => Number(p.priceUsd)))] as const,
      )
      chainPrices.sort((a, b) => a[1] - b[1])
      const cheap = chainPrices[0]!
      const rich = chainPrices[chainPrices.length - 1]!
      const crossPct = ((rich[1] - cheap[1]) / cheap[1]) * 100
      if (crossPct > 0.5) {
        lines.push(
          `⚠️ CROSS-CHAIN: ${cheap[0]} is ${crossPct.toFixed(1)}% cheaper than ${rich[0]} — same contract address, but moving between chains means a BRIDGE (risk + latency), not a swap. Not tradable directly.`,
          '',
        )
      }
    }

    lines.push(
      `⚠️ DexScreener quotes are cached — a spread seen here may be gone before you act.`,
      `⚠️ Both legs sequential = you hold one leg in between (inventory risk). Never execute both sides blindly.`,
      `📜 Log paper signals with journal_append (pattern "arb:<symbol>:<chain>:net<sign>") — the reviewer needs n≥5 samples before any lesson.`,
      `🪪 Confirm the contract before ANY real trade — a spread on the wrong contract is just two bad trades.`,
    )

    return { text: lines.join('\n') }
  },
})

function fmt(p: number): string {
  return p >= 1 ? p.toLocaleString(undefined, { maximumFractionDigits: 4 }) : p.toPrecision(4)
}

function netVerdict(netPct: number): string {
  if (netPct > 1) return '✅ edge after costs (PAPER — verify live quotes on BOTH LPs before ever trading)'
  if (netPct > 0.25) return '🟡 thin edge after costs — one bad fill erases it'
  return '❌ no edge after costs'
}
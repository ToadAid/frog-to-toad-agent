import { z } from 'zod'
import { defineTool } from './registry.js'
import { bestPairByAddress, isContractAddress, searchTokenPairs, type DexPair } from './tokens.js'

/**
 * token_safety_scan — heuristics over public data: pair age, liquidity,
 * volume/fdv sanity, txn balance. DexScreener-based (no key). The GoPlus
 * honeypot/permission checks arrive with the Base/MCP phase.
 *
 * ADDRESS-FIRST: pass the contract address when known (exact asset, no
 * ambiguity). Symbol-only scans resolve via search and are flagged so the
 * human can confirm the contract before anything trades.
 */

export const tokenSafetyScanTool = defineTool({
  name: 'token_safety_scan',
  description:
    'Screen a token for rug/tradeability red flags: liquidity, pair age, volume-vs-FDV, buy/sell balance. ' +
    'Pass the CONTRACT ADDRESS when known (preferred — exact asset); symbol alone resolves by search and is flagged. ' +
    'Missing data is itself a red flag.',
  danger: 'readonly',
  input: z.object({
    address: z.string().optional().describe('contract address (preferred) — the exact asset to screen'),
    symbol: z.string().optional().describe('ticker only if no address is known — result is flagged as search-resolved'),
  }),
  execute: async (input) => {
    if (!input.address && !input.symbol) {
      return { text: '[error] provide a contract address (preferred) or a symbol' }
    }

    let best: DexPair | undefined
    let resolvedBy = ''

    if (input.address && isContractAddress(input.address)) {
      best = await bestPairByAddress(input.address)
      if (!best) {
        return {
          text:
            `🚨 NO LIQUID DATA for contract ${input.address} — no DexScreener pair with liquidity found.\n` +
            `VERDICT: NO-GO (missing data is a red flag).`,
        }
      }
    } else if (input.symbol) {
      const pairs = await searchTokenPairs(input.symbol, 3)
      if (pairs.length === 0) {
        return {
          text:
            `🚨 NO LIQUID DATA for '${input.symbol}' — no DexScreener pair with liquidity found.\n` +
            `VERDICT: NO-GO (missing data is a red flag).`,
        }
      }
      resolvedBy = '⚠️ resolved by SYMBOL SEARCH — confirm this is the contract you mean before trading'
      best = pairs[0]!
    } else {
      return { text: `[error] '${input.address}' is not a valid contract address (expected 0x… 40 hex chars)` }
    }

    const flags: string[] = []
    const greens: string[] = []

    const liq = best.liquidity?.usd ?? 0
    if (liq < 100_000) flags.push(`thin liquidity: $${Math.round(liq).toLocaleString()} (< $100k)`)
    else greens.push(`liquidity $${Math.round(liq).toLocaleString()}`)

    if (best.pairCreatedAt) {
      const ageDays = Math.floor((Date.now() - best.pairCreatedAt) / 86_400_000)
      if (ageDays < 7) flags.push(`very new pair: ${ageDays}d old (< 7d)`)
      else greens.push(`pair age ${ageDays}d`)
    } else {
      flags.push('pair age unknown')
    }

    const vol = best.volume?.h24 ?? 0
    const fdv = best.fdv ?? 0
    if (fdv > 0 && vol > 0) {
      const ratio = vol / fdv
      if (ratio > 5) flags.push(`volume/FDV ratio ${ratio.toFixed(1)}x — likely wash trading`)
      else greens.push(`volume/FDV ${(ratio * 100).toFixed(0)}% looks organic`)
    } else {
      flags.push('volume or FDV unknown')
    }

    const txns = best.txns?.h24
    if (txns) {
      if (txns.buys === 0 && txns.sells === 0) flags.push('zero trades in 24h — dead market')
      else if (txns.sells > txns.buys * 3) flags.push(`sell pressure: ${txns.sells} sells vs ${txns.buys} buys (24h)`)
      else greens.push(`24h flow balanced: ${txns.buys} buys / ${txns.sells} sells`)
    } else {
      flags.push('trade counts unknown')
    }

    if (best.priceChange?.m5 !== undefined && Math.abs(best.priceChange.m5) > 50) {
      flags.push(`extreme 5m volatility: ${best.priceChange.m5.toFixed(0)}%`)
    }

    const verdict = flags.length === 0 ? 'GO' : flags.length <= 1 ? 'CAUTION' : 'NO-GO'
    const lines = [
      `🧪 Safety scan for ${best.baseToken.name} (${best.baseToken.symbol}) on ${best.chainId}/${best.dexId}`,
      `Contract: ${best.baseToken.address}`,
      `Price: $${best.priceUsd ?? '?'} · FDV: $${fdv ? Math.round(fdv).toLocaleString() : '?'}`,
      ...(resolvedBy ? ['', resolvedBy] : []),
      '',
      `Red flags (${flags.length}):`,
      ...(flags.length > 0 ? flags.map((f) => `  🚩 ${f}`) : ['  none found in available data']),
      `Green flags (${greens.length}):`,
      ...(greens.length > 0 ? greens.map((g) => `  ✅ ${g}`) : ['  none']),
      '',
      `VERDICT: ${verdict}`,
      `Note: onchain permission/honeypot checks arrive with the Base MCP phase — this scan covers market-structure risk only.`,
    ]
    return { text: lines.join('\n') }
  },
})
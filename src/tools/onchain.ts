import { z } from 'zod'
import { defineTool } from './registry.js'
import { fetchChainTvl, fetchTopChains, fetchStablecoins } from '../market/onchain.js'

/**
 * market_onchain — DefiLlama lane (no keys): chain TVL trends and stablecoin
 * supply flows. The two things price charts cannot see — where capital is
 * parked, and whether new dollars are minting in or burning out.
 */

const usdFmt = (n: number): string => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return `$${Math.round(n).toLocaleString()}`
}

const pctFmt = (p: number | null): string => (p === null ? '–' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`)

export const marketOnchainTool = defineTool({
  name: 'market_onchain',
  description:
    'Onchain capital flows via DefiLlama (no keys): chain TVL levels + 7d/30d trends (Base spotlighted — the ' +
    "desk's home chain), and stablecoin supply — minting = dollars flowing INTO crypto, burning = flowing OUT. " +
    'Use this for the macro layer a candle chart cannot show: is liquidity expanding or draining, and which ' +
    'chain is absorbing it. Pair with technicals/news; never a standalone trade trigger.',
  danger: 'readonly',
  input: z.object({
    topic: z.enum(['tvl', 'stablecoins']).describe('capital-parked-by-chain OR stablecoin in/outflow'),
    chain: z.string().optional().describe('spotlight one chain for topic=tvl, e.g. "Base", "Ethereum", "Solana"'),
  }),
  execute: async (input) => {
    if (input.topic === 'stablecoins') {
      const snap = await fetchStablecoins()
      if (!snap) return { text: '[error] stablecoin feed returned nothing — DefiLlama may be down, retry shortly.' }
      const movers = snap.top.map(
        (s) => `  • ${s.symbol.padEnd(6)} ${usdFmt(s.supplyUsd).padStart(10)}  7d ${pctFmt(s.changePct7d)}`,
      )
      const read =
        snap.changePct7d === null
          ? ''
          : snap.changePct7d > 0.5
            ? ' — new dollars minting in: net liquidity INFLOW'
            : snap.changePct7d < -0.5
              ? ' — supply burning down: net liquidity OUTFLOW'
              : ' — flat: no meaningful net flow this week'
      return {
        text: [
          `🪙 STABLECOIN FLOWS (7d)`,
          `total ${usdFmt(snap.totalSupplyUsd)} · 7d ${pctFmt(snap.changePct7d)}${read}`,
          '',
          ...movers,
          '',
          `Stablecoin supply is the cleanest dollar-flow proxy in crypto: it grows when buyers reload dry powder,`,
          `shrinks when they deploy or exit. Slow signal — weeks, not hours. The call is yours.`,
        ].join('\n'),
      }
    }

    const top = await fetchTopChains(input.chain ? 5 : 6)
    const spotlight = input.chain ? await fetchChainTvl(input.chain) : undefined
    if (!spotlight && input.chain) {
      return { text: `[error] no TVL history for chain "${input.chain}" — check spelling against DefiLlama's names (case-sensitive).` }
    }
    const rows = top.map(
      (c) => `  • ${c.name.padEnd(12)} ${usdFmt(c.tvl).padStart(10)}`,
    )
    const spotLines = spotlight
      ? [
          '',
          `🔍 ${spotlight.name} spotlight: ${usdFmt(spotlight.tvl)} · 7d ${pctFmt(spotlight.changePct7d)} · 30d ${pctFmt(spotlight.changePct30d)}`,
          spotlight.changePct7d !== null && spotlight.changePct7d > 3
            ? `  TVL accelerating on ${spotlight.name} — capital rotating in`
            : spotlight.changePct7d !== null && spotlight.changePct7d < -3
              ? `  TVL draining from ${spotlight.name} — capital leaving`
              : `  ${spotlight.name} TVL steady`,
        ]
      : []
    return {
      text: [
        `⛓️ CHAIN TVL (top by capital parked)`,
        ...rows,
        ...spotLines,
        '',
        `TVL is where capital sits, not where price goes — divergences are the signal (price up + TVL flat = ` +
          `speculation; TVL up + price flat = builders and LPs positioning). The call is yours.`,
      ].join('\n'),
    }
  },
})
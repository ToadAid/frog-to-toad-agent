import { BASE_RPCS } from './rpc.js'
import { fetchJson } from '../http.js'
import type { PriceQuote } from './feeds.js'

/**
 * Chainlink Data Feeds — the staple fallback. The oracle networks that secure
 * the protocols we'd ever trade on, read straight offchain via a keyless
 * public-RPC `eth_call` to the aggregator proxy (`latestRoundData`). No API
 * key, no payment, no registration. Majors only (long-tail tokens have no
 * feeds — DexScreener pair data covers those).
 *
 * The paid "Chainlink for Agents" x402 gateway (Data Streams, CRE, CCIP) is a
 * Phase 7 question — the onchain reads here need none of it.
 */

// Chainlink Data Feeds v2 proxy addresses on Base (docs.chain.link, verified live).
const FEEDS_ON_BASE: Record<string, string> = {
  BTC: '0x32F587986D3fb47601157c19615d568BeD0BCabc',
  ETH: '0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b',
  SOL: '0xDa5Fd22F9382e57534fEdA4fF544878aa1cf401f',
  LINK: '0x17CAb8FE31E32f08326e5E27412894e49B0f9D65',
  AVAX: '0xE70f2D34Fd04046aaEC26a198A35dD8F2dF5cd92',
}

// Keyless public Base RPCs, tried in order.
const RPCS = BASE_RPCS

const LATEST_ROUND_DATA = '0xfeaf968c' // latestRoundData()
const DECIMALS = '0x313ce567' // decimals()

/** Feeds update on heartbeat/deviation; older than this = treat as dead. */
const MAX_FEED_AGE_MS = 2 * 3600_000

const decimalsCache = new Map<string, number>()

type EthCallResult = { result?: string; error?: { message?: string } }

/** Chainlink reads want the extra retry + empty-result guard (bad feed address case). */
async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetchJson<EthCallResult>(rpc, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] },
    retries: 1,
  })
  if (res.error) throw new Error(`eth_call: ${res.error.message}`)
  if (!res.result || res.result === '0x') throw new Error('eth_call returned empty — bad feed address?')
  return res.result
}

function word(result: string, i: number): bigint {
  const hex = result.slice(2 + i * 64, 2 + (i + 1) * 64)
  return BigInt('0x' + (hex || '0'.repeat(64)))
}

export async function chainlinkPrice(symbolIn: string): Promise<PriceQuote | undefined> {
  const symbol = symbolIn.toUpperCase()
  const feed = FEEDS_ON_BASE[symbol]
  if (!feed) return undefined

  for (const rpc of RPCS) {
    try {
      const result = await ethCall(rpc, feed, LATEST_ROUND_DATA)
      // latestRoundData returns (roundId, answer, startedAt, updatedAt, answeredInRound)
      const answer = word(result, 1)
      const updatedAt = Number(word(result, 3))
      if (answer <= 0n || !Number.isFinite(updatedAt) || updatedAt <= 0) return undefined
      if (Date.now() - updatedAt * 1000 > MAX_FEED_AGE_MS) return undefined // stale — do not trust

      let decimals = decimalsCache.get(feed)
      if (decimals === undefined) {
        decimals = Number(await ethCall(rpc, feed, DECIMALS))
        if (!Number.isFinite(decimals) || decimals <= 0 || decimals > 18) return undefined
        decimalsCache.set(feed, decimals)
      }
      const usd = Number(answer) / 10 ** decimals
      if (!Number.isFinite(usd) || usd <= 0) return undefined
      return { symbol, usd, source: 'chainlink' }
    } catch {
      // next RPC; if all fail the caller's chain falls through as usual
    }
  }
  return undefined
}

/** Address of the Chainlink feed for a major on Base (for reporting/guards). */
export function chainlinkFeedAddress(symbol: string): string | undefined {
  return FEEDS_ON_BASE[symbol.toUpperCase()]
}
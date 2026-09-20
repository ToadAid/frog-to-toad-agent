import { fetchJson } from '../http.js'

/**
 * Onchain lane (Phase 10.2) — DefiLlama's free, key-less APIs. This is the
 * desk's home turf (Base) and the data technicals and news CANNOT see: where
 * capital is parked (chain TVL), and whether the dollar is flowing in or out
 * of crypto (stablecoin supply — minting = inflow, burning = outflow).
 */

export type ChainTvl = {
  name: string
  tvl: number
  weekAgo: number | null
  monthAgo: number | null
  changePct7d: number | null
  changePct30d: number | null
}

type TvlPoint = { date: number; tvl: number }

// ── Test seam ────────────────────────────────────────────────────────────────

type FetchFn = (url: string, opts?: { retries?: number }) => Promise<unknown>
const realFetch: FetchFn = (url, opts) => fetchJson(url, opts)
let llamaJson: FetchFn = realFetch
/** Test seam — swap the JSON fetcher (set undefined to restore the real one). */
export function setLlamaFetcher(fn: FetchFn | undefined): void {
  llamaJson = fn ?? realFetch
}

// ── Chain TVL ────────────────────────────────────────────────────────────────

/** Chain TVL history (daily points). */
export async function fetchChainTvlHistory(chain: string): Promise<TvlPoint[]> {
  return (await llamaJson(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`, { retries: 1 })) as TvlPoint[]
}

/** Current TVL for a chain + 7d/30d deltas from its own history. */
export async function fetchChainTvl(chain: string): Promise<ChainTvl | undefined> {
  const hist = await fetchChainTvlHistory(chain)
  const last = hist[hist.length - 1]
  if (!last) return undefined
  const atDaysAgo = (days: number): number | null => {
    const target = last.date - days * 86_400
    for (let i = hist.length - 1; i >= 0; i--) {
      const p = hist[i]
      if (p && p.date <= target) return p.tvl
    }
    return null
  }
  const week = atDaysAgo(7)
  const month = atDaysAgo(30)
  const pct = (past: number | null) =>
    past !== null && past > 0 ? Math.round((last.tvl / past - 1) * 1000) / 10 : null
  return { name: chain, tvl: last.tvl, weekAgo: week, monthAgo: month, changePct7d: pct(week), changePct30d: pct(month) }
}

/** Top chains by current TVL. */
export async function fetchTopChains(n = 6): Promise<Array<{ name: string; tvl: number }>> {
  const chains = (await llamaJson('https://api.llama.fi/v2/chains', { retries: 1 })) as Array<{ name?: string; tvl?: number }>
  return chains
    .filter((c) => typeof c.name === 'string' && typeof c.tvl === 'number')
    .map((c) => ({ name: c.name as string, tvl: c.tvl as number }))
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, n)
}

// ── Stablecoins ──────────────────────────────────────────────────────────────

export type StablecoinFlow = {
  symbol: string
  name: string
  supplyUsd: number
  changePct7d: number | null
}

export type StablecoinSnapshot = {
  totalSupplyUsd: number
  changePct7d: number | null
  top: StablecoinFlow[]
}

type PeggedAsset = {
  name?: string
  symbol?: string
  circulating?: { peggedUSD?: number }
  /** Weekly/daily deltas live at the ASSET level, not inside circulating. */
  circulatingPrevWeek?: { peggedUSD?: number } | number
}

export async function fetchStablecoins(topN = 5): Promise<StablecoinSnapshot | undefined> {
  const data = (await llamaJson('https://stablecoins.llama.fi/stablecoins?includePrices=false', {
    retries: 1,
  })) as { peggedAssets?: PeggedAsset[] }
  const usable = (data.peggedAssets ?? [])
    .filter((a) => typeof a.circulating?.peggedUSD === 'number' && a.circulating.peggedUSD > 1_000_000)
    .map((a) => {
      const supply = a.circulating!.peggedUSD as number
      const prev = a.circulatingPrevWeek
      const prevUsd = typeof prev === 'number' ? prev : prev?.peggedUSD
      const changePct7d = typeof prevUsd === 'number' && prevUsd > 0 ? Math.round((supply / prevUsd - 1) * 1000) / 10 : null
      return { symbol: (a.symbol ?? '?').toUpperCase(), name: a.name ?? '?', supplyUsd: supply, changePct7d }
    })
    .sort((a, b) => b.supplyUsd - a.supplyUsd)
  if (usable.length === 0) return undefined
  const total = usable.reduce((acc, s) => acc + s.supplyUsd, 0)
  // Aggregate 7d flow: reconstruct each asset's supply a week ago from its own
  // ratio (assets with unknown prev count at today's value — they dilute the
  // aggregate toward 0% rather than inventing a number).
  const totalPrev = usable.reduce((acc, s) => {
    return acc + (s.changePct7d !== null ? s.supplyUsd / (1 + s.changePct7d / 100) : s.supplyUsd)
  }, 0)
  const changePct7d = totalPrev > 0 ? Math.round((total / totalPrev - 1) * 1000) / 10 : null
  return { totalSupplyUsd: total, changePct7d, top: usable.slice(0, topN) }
}
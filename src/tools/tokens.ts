import { fetchJson } from '../http.js'

/**
 * Token identity — CONTRACT ADDRESS FIRST, ticker as a display label.
 * Tickers are user-interface sugar; the address is the asset. Every tool that
 * quotes, screens, or executes keys on the address; every ledger/journal entry
 * records it. Symbol-only lookups are resolved here and must say so.
 */

export type DexPair = {
  chainId: string
  dexId: string
  url: string
  baseToken: { address: string; name: string; symbol: string }
  pairAddress?: string
  priceUsd?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  priceChange?: { h24?: number; m5?: number }
  pairCreatedAt?: number
  fdv?: number
  txns?: { h24?: { buys: number; sells: number }; m5?: { buys: number; sells: number } }
}

export type TokenCandidate = {
  symbol: string
  name: string
  address: string
  chainId: string
  dexId: string
  priceUsd: number | null
  liquidityUsd: number
  volumeUsd24h: number
  pairUrl: string
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function isContractAddress(s: string): boolean {
  return EVM_ADDRESS_RE.test(s.trim())
}

/** `0x6982508145454ce325ddbe47a25d4ec3d2311933` → `0x6982…1933` */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Majors keep symbol-only shortcuts everywhere (price feeds, guard, quoting). */
export const MAJOR_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'USDC', 'USDT', 'AVAX', 'DOGE', 'XRP', 'ADA', 'LINK', 'ARB', 'OP'])

export function isMajor(symbol: string): boolean {
  return MAJOR_SYMBOLS.has(symbol.toUpperCase())
}

function toCandidate(p: DexPair): TokenCandidate {
  return {
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    address: p.baseToken.address,
    chainId: p.chainId,
    dexId: p.dexId,
    priceUsd: p.priceUsd !== undefined ? Number(p.priceUsd) : null,
    liquidityUsd: p.liquidity?.usd ?? 0,
    volumeUsd24h: p.volume?.h24 ?? 0,
    pairUrl: p.url,
  }
}

/**
 * Search DexScreener and return the BEST liquid pair per token (deduped by
 * chain+address), ranked by liquidity. NEVER auto-trust the top hit — callers
 * must show candidates and let the human pick.
 */
export async function searchTokenPairs(query: string, limit = 5): Promise<DexPair[]> {
  // DexScreener changed shape: {schemaVersion, pairs:[…]} — older docs said array.
  const data = await fetchJson<DexPair[] | { pairs?: DexPair[] }>(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
  )
  const pairs = Array.isArray(data) ? data : (data.pairs ?? [])
  const best = new Map<string, DexPair>()
  for (const p of pairs) {
    if (!p.baseToken.address || (p.liquidity?.usd ?? 0) <= 0) continue
    const key = `${p.chainId}:${p.baseToken.address.toLowerCase()}`
    const prev = best.get(key)
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(key, p)
  }
  return [...best.values()].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, limit)
}

/** Convenience wrapper: ranked candidate summaries for display. */
export async function searchTokenCandidates(query: string, limit = 5): Promise<TokenCandidate[]> {
  return (await searchTokenPairs(query, limit)).map(toCandidate)
}

/** Exact-asset lookup: best liquid pair for a contract address across chains. */
export async function bestPairByAddress(address: string): Promise<DexPair | undefined> {
  const data = await fetchJson<{ pairs?: DexPair[] }>(
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address.trim())}`,
  )
  return (data.pairs ?? [])
    .filter((p) => p.baseToken.address && (p.liquidity?.usd ?? 0) > 0)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
}

/** ALL liquid pairs for a contract across every chain/LP (spread hunting needs the full list). */
export async function allPairsByAddress(address: string): Promise<DexPair[]> {
  const data = await fetchJson<{ pairs?: DexPair[] }>(
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address.trim())}`,
  )
  return (data.pairs ?? []).filter((p) => p.baseToken.address && (p.liquidity?.usd ?? 0) > 0)
}

/** Exact-asset candidate by contract address (best pair wins). */
export async function tokenByAddress(address: string): Promise<TokenCandidate | undefined> {
  const best = await bestPairByAddress(address)
  return best ? toCandidate(best) : undefined
}

// ── Forecast/chart symbol resolution ─────────────────────────────────────────
// The kronos + chart lanes speak candle feeds, and every candle feed is
// per-ASSET: a ticker is only as good as the feed that serves it, and a
// contract address is the only pinpoint identity (same ticker, different
// contract, is everywhere). Base-only: it is the desk's home chain and the
// only one the wallet lane can verify anything on.

export type ResolvedForecastSymbol =
  | { kind: 'ticker'; symbol: string }
  | {
      kind: 'contract'
      address: string
      symbol: string
      label: string
      pairAddress: string
      chainId: string
      dexId: string
      liquidityUsd: number
      /** Runner-up Base pools (most liquid first) — callers may fall back if the
       * top pool has no candle history. */
      alternates: string[]
    }
  | { kind: 'refuse'; reason: string }

/**
 * Resolve a user-entered symbol for the candle lanes (kronos forecast, chart):
 * a ticker passes through untouched (feed-validated downstream, zero network
 * here); a contract address resolves to its MOST LIQUID Base pool via
 * DexScreener — the pool that is actually traded, never a namesake. Refusals
 * name what was seen, never "you typed it wrong".
 */
export async function resolveForecastSymbol(raw: string): Promise<ResolvedForecastSymbol> {
  const input = raw.trim()
  if (!input) return { kind: 'refuse', reason: 'empty symbol — enter a ticker or a Base contract address.' }
  if (!isContractAddress(input)) {
    return { kind: 'ticker', symbol: input.toUpperCase() }
  }

  let pairs: DexPair[]
  try {
    pairs = await allPairsByAddress(input)
  } catch {
    return { kind: 'refuse', reason: `cannot resolve a pool for candles — DexScreener is unreachable for ${shortAddress(input)}.` }
  }
  const lower = input.toLowerCase()
  const usable = pairs
    // The token must be the BASE side of the pool — GeckoTerminal's token=base
    // charts the pool's base token, and a quote-side pair would chart the OTHER
    // asset (USDC/WETH pairs list them as quote).
    .filter(
      (p) =>
        p.chainId === 'base' &&
        p.pairAddress &&
        p.baseToken.address.toLowerCase() === lower &&
        (p.liquidity?.usd ?? 0) > 0,
    )
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
  if (usable.length === 0) {
    const elsewhere = [...new Set(pairs.map((p) => p.chainId))].filter((c) => c !== 'base')
    return {
      kind: 'refuse',
      reason:
        elsewhere.length > 0
          ? `no Base pool for ${shortAddress(input)} — DexScreener shows it on: ${elsewhere.join(', ')}. The forecast/chart lanes are Base-only.`
          : `no liquid pool found for ${shortAddress(input)} on any chain (DexScreener returned nothing tradable).`,
    }
  }
  const best = usable[0]!
  return {
    kind: 'contract',
    address: input,
    symbol: best.baseToken.symbol.toUpperCase(),
    label: `${best.baseToken.name} (${best.baseToken.symbol})`,
    pairAddress: best.pairAddress!,
    chainId: best.chainId,
    dexId: best.dexId,
    liquidityUsd: Math.round(best.liquidity?.usd ?? 0),
    alternates: usable.slice(1).map((p) => p.pairAddress!),
  }
}
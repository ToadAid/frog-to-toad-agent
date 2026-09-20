import { fetchJson } from '../http.js'
import type { FetchJsonOptions } from '../http.js'
import { log } from '../log.js'
import { chainlinkPrice } from './chainlink.js'

/**
 * Redundant price feed — one interface, several providers, tried in order.
 * CoinGecko (rate-limited on free tier) → Binance → Coinbase Exchange →
 * Chainlink onchain (Base oracle read — see chainlink.ts).
 * A 30s TTL cache keeps the desk well under public rate limits even when the
 * agent asks repeatedly during one run.
 *
 * Symbol-scoped (majors + liquid tickers). Long-tail tokens use DexScreener
 * pair data directly (see tools/tokens.ts).
 */

export type PriceQuote = {
  symbol: string
  usd: number
  change24hPct?: number
  source: 'coingecko' | 'binance' | 'coinbase' | 'chainlink'
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { at: number; quote: PriceQuote }>()

// ── Circuit breaker ──────────────────────────────────────────────────────────
// 2026-09-02 incident: CoinGecko 429 bursts stalled the chain in fetchJson's
// 429-backoff, and binance.com geo-blocks this box — but answers HTTP 200 with
// an error body, which parses as "no price" and never even trips an error. Fix:
// a provider that fails or returns nothing goes on a short cooldown so the
// chain stops paying for dead/limited providers on every single call.
const BREAKER_COOLDOWN_MS = 5 * 60_000
const breaker = new Map<string, number>()

/** Test seam — clear all provider cooldowns. */
export function resetFeedBreakers(): void {
  breaker.clear()
}

function onCooldown(name: string): boolean {
  const until = breaker.get(name)
  if (until === undefined) return false
  if (until < Date.now()) {
    breaker.delete(name)
    return false
  }
  return true
}

function tripBreaker(name: string): void {
  breaker.set(name, Date.now() + BREAKER_COOLDOWN_MS)
  log.debug(`feed breaker: ${name} on cooldown for ${BREAKER_COOLDOWN_MS / 1000}s`)
}

/** Shared breaker access for other chains (news, …): same map, same cooldown. */
export function feedBreakerOnCooldown(name: string): boolean {
  return onCooldown(name)
}

export function tripFeedBreaker(name: string): void {
  tripBreaker(name)
}

export async function getUsdPrice(symbolIn: string): Promise<PriceQuote | undefined> {
  const symbol = symbolIn.toUpperCase()

  const hit = cache.get(symbol)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.quote

  // Chainlink last: the staple onchain oracle (Base, keyless) — when every
  // web API is down or lying, the oracle the protocols themselves use still answers.
  for (const attempt of [coingeckoPrice, coinbasePrice, binancePrice, chainlinkPrice]) {
    if (onCooldown(attempt.name)) continue
    try {
      const quote = await attempt(symbol)
      if (quote) {
        cache.set(symbol, { at: Date.now(), quote })
        return quote
      }
      // "Worked" but unusable (e.g. binance.com's 200-with-error-body) — don't
      // keep asking the same silent failure for the next quote.
      tripBreaker(attempt.name)
    } catch (err) {
      // A dead feed is not fatal — fall through to the next one, on cooldown.
      tripBreaker(attempt.name)
      log.debug(`price feed ${attempt.name} failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return undefined
}

export function clearPriceCache(): void {
  cache.clear()
}

/** Human price: full commas for big numbers, significant digits for sub-cent. */
export function fmtUsd(p: number): string {
  return p >= 1 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.toPrecision(3)
}

// ── Providers (all keyless) ──────────────────────────────────────────────────
// Price providers use fetchJson(retries: 0): the fallback chain IS the retry —
// a 429 must move to the next provider instantly, never sleep inside one link.

async function coingeckoPrice(symbol: string): Promise<PriceQuote | undefined> {
  const id = COINGECKO_IDS[symbol]
  if (!id) return undefined
  const data = await fetchJson<Record<string, { usd?: number; usd_24h_change?: number }>>(
    `https://api.coingecko.com/api/v3/simple/price?${new URLSearchParams({ vs_currencies: 'usd', include_24hr_change: 'true', ids: id })}`,
    { retries: 0 },
  )
  const row = data[id]
  if (row?.usd === undefined) return undefined
  return { symbol, usd: row.usd, change24hPct: row.usd_24h_change, source: 'coingecko' }
}

/** .com geo-blocks some deployments (2026-09-02: HTTP 200 with an error body); .us serves the majors. */
const BINANCE_HOSTS = ['api.binance.com', 'api.binance.us']

/** Binance JSON with host fallback + per-host breaker cooldowns.
 * `ok` guards against the silent-block shape: HTTP 200 carrying an error body
 * instead of the requested data. Unusable payloads trip the host's cooldown
 * and the loop moves to the next host. */
export async function binanceJson<T>(
  path: string,
  opts: FetchJsonOptions & { ok?: (data: T) => boolean } = {},
): Promise<T> {
  const { ok, ...fetchOpts } = opts
  let lastError: unknown
  for (const host of BINANCE_HOSTS) {
    const key = `binance:${host}`
    if (onCooldown(key)) continue
    try {
      const data = await fetchJson<T>(`https://${host}${path}`, fetchOpts)
      if (ok && !ok(data)) {
        lastError = new Error(`unusable payload from ${host}${path}`)
        tripBreaker(key)
        continue
      }
      return data
    } catch (err) {
      lastError = err
      tripBreaker(key)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all binance hosts failed')
}

async function binancePrice(symbol: string): Promise<PriceQuote | undefined> {
  const data = await binanceJson<{ lastPrice?: string; priceChangePercent?: string }>(
    `/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}USDT`,
    { retries: 0, ok: (d) => typeof d?.lastPrice === 'string' },
  )
  const price = Number(data.lastPrice)
  if (!Number.isFinite(price) || price <= 0) return undefined
  const change = Number(data.priceChangePercent)
  return { symbol, usd: price, change24hPct: Number.isFinite(change) ? change : undefined, source: 'binance' }
}

async function coinbasePrice(symbol: string): Promise<PriceQuote | undefined> {
  const data = await fetchJson<{ price?: string }>(
    `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/ticker`,
    { retries: 0 },
  )
  const price = Number(data.price)
  if (!Number.isFinite(price) || price <= 0) return undefined
  return { symbol, usd: price, source: 'coinbase' }
}

/**
 * Closest hourly close AT a past timestamp (majors via Coinbase). Used to
 * benchmark-grade signals: alpha needs the benchmark's price at entry time,
 * not just now. undefined when the history can't serve it — callers fall back.
 */
export async function priceAt(symbol: string, ts: number): Promise<number | undefined> {
  try {
    const rows = await fetchJson<number[][]>(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/candles` +
        `?granularity=3600&start=${new Date(ts - 3600_000).toISOString()}&end=${new Date(ts + 3600_000).toISOString()}`,
    )
    if (!Array.isArray(rows) || rows.length === 0) return undefined
    // rows are [timeSec, low, high, open, close, volume], newest first
    const usable = rows.filter((r) => (r[0] ?? 0) <= ts / 1000 + 3600).sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0))
    const close = (usable[0] ?? rows[rows.length - 1])?.[4]
    return typeof close === 'number' && Number.isFinite(close) && close > 0 ? close : undefined
  } catch {
    return undefined
  }
}

/** Coingecko id per symbol — shared with the candle fallback in tools/technicals.ts. */
export const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  USDC: 'usd-coin',
  USDT: 'tether',
  AVAX: 'avalanche-2',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  LINK: 'chainlink',
  ARB: 'arbitrum',
  OP: 'optimism',
  PEPE: 'pepe',
  MOG: 'mog-coin',
}
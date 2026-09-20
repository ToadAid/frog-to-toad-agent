/**
 * Point-in-time prices for GRADING, keyed by how the record was issued —
 * not by a hardcoded symbol list. A forecast graded against a different
 * asset than the one it was issued on is a horoscope with extra steps:
 *   • contract records (pairAddress set) → the SAME pool's OHLCV close at
 *     horizon — never re-resolved, never substituted (a "new best pool"
 *     mid-life is a different price series)
 *   • ticker records → Coinbase first (every historical record), then
 *     Binance klines for tickers Coinbase doesn't list
 * No pool → undefined → the record stays awaitingPrice and the nightly
 * grade retries. Never guessed.
 */
import type { ForecastRecord } from './forecastGrader.js'
import { priceAt } from './feeds.js'
import { binanceCloseAt, geckoTerminalCandles } from '../tools/technicals.js'

export async function priceAtOnPool(
  chainId: string,
  pairAddress: string,
  ts: number,
  interval: 'hourly' | 'daily',
): Promise<number | undefined> {
  try {
    const candles = await geckoTerminalCandles(chainId, pairAddress, interval)
    const width = interval === 'hourly' ? 3_600_000 : 86_400_000
    const t = Math.floor(ts)
    // newest candle whose open is at/before ts, within one candle width
    const hit = candles
      .filter((c) => c.time * 1000 <= t && t < c.time * 1000 + width)
      .sort((a, b) => b.time - a.time)[0]
    const close = hit?.close
    return close !== undefined && Number.isFinite(close) && close > 0 ? close : undefined
  } catch {
    return undefined // a dead pool / dead feed is an awaitingPrice, never a crash
  }
}

export async function priceForRecord(rec: ForecastRecord, ts: number): Promise<number | undefined> {
  if (rec.pairAddress) {
    return priceAtOnPool(rec.chainId ?? 'base', rec.pairAddress, ts, rec.interval)
  }
  const coinbase = await priceAt(rec.symbol, ts)
  if (coinbase !== undefined) return coinbase
  try {
    return await binanceCloseAt(rec.symbol, ts, rec.interval)
  } catch {
    return undefined // grading never throws on a feed outage — the retry owns it
  }
}
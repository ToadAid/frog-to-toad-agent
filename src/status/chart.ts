import { COINGECKO_IDS } from '../market/feeds.js'
import { binanceCandles, coingeckoCandles, geckoTerminalCandles } from '../tools/technicals.js'
import { isContractAddress, resolveForecastSymbol } from '../tools/tokens.js'
import {
  analyzeCandles,
  bollingerSeries,
  emaSeries,
  macdSeries,
  rsiSeries,
  type Candle,
  type TaDossier,
} from '../market/ta.js'

/**
 * GET /chart?symbol=BTC&interval=hourly — OHLCV + indicator series for the
 * Charts tab. Symbol policy matches the kronos lane: any ticker a feed can
 * serve (Binance klines → CoinGecko close-only fallback, breaker cooldowns
 * respected) or a Base ERC-20 contract address resolved to its most liquid
 * DexScreener pool (GeckoTerminal OHLCV — true OHLC, never close-only).
 * 60s in-memory cache so tab-refreshing never hammers the feeds; resolution
 * happens INSIDE the cached computation, so repeat hits cost zero resolution
 * calls.
 */

export type ChartInterval = 'hourly' | 'daily'

export type ChartView = {
  symbol: string
  interval: ChartInterval
  source: string
  closeOnly: boolean
  /** Contract charts: the exact pool the candles come from. */
  pairAddress?: string
  label?: string
  liquidityUsd?: number
  /** Desk majors (symbol-picker quick-picks on the Charts tab). */
  majors: string[]
  dossier: TaDossier
  /** Series aligned to `candles` (null before warmup) — renderer-ready. */
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>
  ema20: Array<{ time: number; value: number } | null>
  ema50: Array<{ time: number; value: number } | null>
  boll: { upper: Array<Point | null>; lower: Array<Point | null>; mid: Array<Point | null> }
  rsi: Array<Point | null>
  macd: { line: Array<Point | null>; signal: Array<Point | null>; histogram: Array<Point | null> }
}

type Point = { time: number; value: number }

export function isChartInterval(v: string): v is ChartInterval {
  return v === 'hourly' || v === 'daily'
}

/** Align a series that starts `offset` candles in (emaSeries shape) to points. */
function offsetSeries(times: number[], values: number[] | undefined, offset: number): Array<Point | null> {
  if (!values) return times.map(() => null)
  const out: Array<Point | null> = times.map(() => null)
  for (let i = 0; i < values.length; i++) {
    const idx = i + offset
    const v = values[i]!
    if (idx < times.length && Number.isFinite(v)) out[idx] = { time: times[idx]!, value: v }
  }
  return out
}

/** Full-length series (rsiSeries/bollingerSeries/macdSeries shape) → points. */
function alignedSeries(times: number[], values: number[] | undefined): Array<Point | null> {
  if (!values) return times.map(() => null)
  return times.map((t, i) => {
    const v = values[i]!
    return Number.isFinite(v) ? { time: t, value: v } : null
  })
}

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 16
type CacheEntry = { at: number; view: ChartView }
const cache = new Map<string, CacheEntry>()

export function clearChartCache(): void {
  cache.clear()
}

export async function chartView(symbolIn: string, interval: ChartInterval): Promise<ChartView> {
  // Contract addresses are case-significant identity — never uppercased.
  const raw = symbolIn.trim()
  const norm = isContractAddress(raw) ? raw : raw.toUpperCase()
  const key = `${norm}:${interval}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.view

  let candles: Candle[] = []
  let source = ''
  let closeOnly = false
  let pool: { pairAddress?: string; label?: string; liquidityUsd?: number } = {}

  if (isContractAddress(norm)) {
    // DEX lane: resolve the pool inside the cached computation.
    const resolved = await resolveForecastSymbol(norm)
    if (resolved.kind === 'refuse') throw new Error(resolved.reason)
    if (resolved.kind === 'contract') {
      candles = await geckoTerminalCandles('base', resolved.pairAddress, interval)
      source = 'geckoterminal'
      pool = { pairAddress: resolved.pairAddress, label: resolved.label, liquidityUsd: resolved.liquidityUsd }
    } else {
      // A ticker that also looks like an address can't happen; keep TS honest.
      throw new Error(`no candle feed could serve ${norm} (${interval})`)
    }
  } else {
    const symbol = norm
    try {
      candles = await binanceCandles(symbol, interval, 300)
      source = 'binance'
    } catch {
      try {
        candles = await coingeckoCandles(symbol, interval)
        source = 'coingecko'
        closeOnly = true
      } catch {
        throw new Error(`no candle feed could serve ${symbol} (${interval})`)
      }
    }
  }
  candles = candles
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time)
    .slice(-300)
  if (candles.length < 2) throw new Error(`not enough candles for ${norm} (${interval})`)

  const closes = candles.map((c) => c.close)
  const times = candles.map((c) => c.time)
  const bb = bollingerSeries(closes)
  const md = macdSeries(closes)

  const view: ChartView = {
    symbol: norm,
    interval,
    source,
    closeOnly,
    ...pool,
    majors: Object.keys(COINGECKO_IDS),
    dossier: analyzeCandles(candles, interval, source, closeOnly),
    candles: candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    ema20: offsetSeries(times, emaSeries(closes, 20), 19),
    ema50: offsetSeries(times, emaSeries(closes, 50), 49),
    boll: {
      upper: bb ? alignedSeries(times, bb.upper) : times.map(() => null),
      lower: bb ? alignedSeries(times, bb.lower) : times.map(() => null),
      mid: bb ? alignedSeries(times, bb.mid) : times.map(() => null),
    },
    rsi: alignedSeries(times, rsiSeries(closes)),
    macd: {
      line: md ? alignedSeries(times, md.line) : times.map(() => null),
      signal: md ? alignedSeries(times, md.signal) : times.map(() => null),
      histogram: md ? alignedSeries(times, md.histogram) : times.map(() => null),
    },
  }

  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]![0]
    cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), view })
  return view
}
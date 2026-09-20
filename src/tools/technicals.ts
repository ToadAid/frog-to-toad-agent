import { z } from 'zod'
import { defineTool } from './registry.js'
import { fetchJson } from '../http.js'
import { analyzeCandles, type Candle } from '../market/ta.js'
import { COINGECKO_IDS, binanceJson } from '../market/feeds.js'
import { bestPairByAddress, isContractAddress, tokenByAddress, shortAddress } from './tokens.js'

/**
 * market_technicals — OHLCV from the redundant feed chain, indicators computed
 * in code. The tool reports WHAT IS (readings + mechanical notes); the AGENT
 * makes the BUY/SELL/HOLD call and must journal it with an invalidation level.
 * Majors: Coinbase candles → Binance klines → CoinGecko (close-only fallback).
 * Long tail: any contract address, candles from GeckoTerminal's free OHLCV API
 * for its best DexScreener pair — TA everywhere the desk can trade, address-first.
 */

type Interval = 'hourly' | 'daily'

/** GeckoTerminal network slugs (differs from DexScreener chainId for a few). */
export const GT_NETWORKS: Record<string, string> = {
  ethereum: 'eth',
  base: 'base',
  solana: 'solana',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  bsc: 'bsc',
  polygon: 'polygon_pos',
  avalanche: 'avax',
  blast: 'blast',
  pulsechain: 'pulsechain',
}

/**
 * GeckoTerminal pool OHLCV — the DEX candle lane for contract addresses
 * (exchange feeds don't know a contract from a hole in the ground). USD-
 * denominated pool-candle series, `token=base` pins it to the pool's base
 * side. limit=1000 is the endpoint max (30 req/min on the free host).
 */
export async function geckoTerminalCandles(chainId: string, pairAddress: string, interval: Interval): Promise<Candle[]> {
  const network = GT_NETWORKS[chainId] ?? chainId
  const timeframe = interval === 'hourly' ? 'hour' : 'day'
  const data = await fetchJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
    `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pairAddress)}/ohlcv/${timeframe}?aggregate=1&limit=1000&currency=usd&token=base`,
  )
  // rows are [timeSec, open, high, low, close, volume], NEWEST first — flip.
  return (data.data?.attributes?.ohlcv_list ?? [])
    .map((r) => ({
      time: r[0]!,
      open: r[1]!,
      high: r[2]!,
      low: r[3]!,
      close: r[4]!,
      volume: r[5] ?? 0,
    }))
    .reverse()
}

export async function coinbaseCandles(symbol: string, interval: Interval): Promise<Candle[]> {
  const g = interval === 'hourly' ? 3600 : 86_400
  const rows = await fetchJson<number[][]>(
    `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}-USD/candles?granularity=${g}`,
  )
  return rows.map((r) => ({ time: r[0]!, low: r[1]!, high: r[2]!, open: r[3]!, close: r[4]!, volume: r[5]! }))
}

export async function binanceCandles(symbol: string, interval: Interval, limit = 300): Promise<Candle[]> {
  const iv = interval === 'hourly' ? '1h' : '1d'
  // binanceJson: .com → .us host fallback with breaker cooldowns (geo-blocks happen).
  const rows = await binanceJson<unknown[][]>(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}USDT&interval=${iv}&limit=${limit}`,
    { retries: 0, ok: Array.isArray },
  )
  return rows.map((r) => ({
    time: Math.floor(Number(r[0]) / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }))
}

/**
 * The close AT a point in time, from Binance hourly/daily klines — the grading
 * price for forecast records a Coinbase product can't price (any Binance-
 * listed ticker). Windowed query; picks the candle that straddles `ts`.
 */
export async function binanceCloseAt(symbol: string, ts: number, interval: Interval): Promise<number | undefined> {
  const iv = interval === 'hourly' ? '1h' : '1d'
  const ms = interval === 'hourly' ? 3_600_000 : 86_400_000
  const tSec = Math.floor(ts / 1000)
  const rows = await binanceJson<unknown[][]>(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}USDT&interval=${iv}` +
      `&startTime=${(tSec - ms) * 1000}&endTime=${(tSec + ms) * 1000}&limit=5`,
    { retries: 0, ok: Array.isArray },
  )
  const hit = rows.find((r) => {
    const openTime = Math.floor(Number(r[0]) / 1000)
    return openTime <= tSec && tSec < openTime + ms / 1000
  })
  const close = hit ? Number(hit[4]) : undefined
  return close !== undefined && Number.isFinite(close) && close > 0 ? close : undefined
}

export async function coingeckoCandles(symbol: string, interval: Interval, daysIn?: number): Promise<Candle[]> {
  const id = COINGECKO_IDS[symbol.toUpperCase()]
  if (!id) return []
  const days = daysIn ?? (interval === 'hourly' ? 14 : 180)
  const data = await fetchJson<{ prices?: Array<[number, number]> }>(
    `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`,
  )
  return (data.prices ?? []).map(([ts, price]) => ({
    time: Math.floor(ts / 1000),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  }))
}

export const marketTechnicalsTool = defineTool({
  name: 'market_technicals',
  description:
    'Full technical-analysis dossier: RSI(14), MACD (fresh-cross detection), EMA20/50 stack, ' +
    'Bollinger (squeeze detection), volume trend, 24h range position. Majors by ticker (e.g. "BTC"); ' +
    'ANY other token by CONTRACT ADDRESS (long-tail candles come from its best DEX pair). YOU make the ' +
    'BUY/SELL/HOLD call from this and MUST journal any signal (pattern "ta:<SYMBOL>:<SIGNAL>@<price>") ' +
    'with an invalidation price.',
  danger: 'readonly',
  input: z.object({
    symbol: z.string().describe('ticker for majors (e.g. "BTC") or contract address for everything else (0x…)'),
    interval: z.enum(['hourly', 'daily']).optional().describe('candle size (default hourly)'),
  }),
  execute: async (input) => {
    const interval: Interval = input.interval ?? 'hourly'

    // Long-tail path: contract address → best DexScreener pair → GeckoTerminal OHLCV.
    let longTailLabel = ''
    let symbol = input.symbol.toUpperCase()
    let pairAddress: string | undefined
    let chainId: string | undefined
    if (isContractAddress(input.symbol)) {
      const pair = await bestPairByAddress(input.symbol)
      if (!pair?.pairAddress) {
        return {
          text:
            `[error] no liquid DexScreener pair with candle data found for ${shortAddress(input.symbol.trim())}. ` +
            `Try market_token_search to confirm the contract, or pick a different interval.`,
        }
      }
      pairAddress = pair.pairAddress
      chainId = pair.chainId
      const token = await tokenByAddress(input.symbol)
      longTailLabel = token ? `${token.symbol} (${token.name})` : pair.baseToken.symbol
      symbol = pair.baseToken.symbol.toUpperCase()
    }

    let candles: Candle[] = []
    let source = ''
    if (pairAddress) {
      try {
        candles = await geckoTerminalCandles(chainId!, pairAddress, interval)
        if (candles.length >= 30) source = 'geckoterminal'
      } catch {
        /* fall through to the error below */
      }
    } else {
      for (const [name, fetcher] of [
        ['coinbase', coinbaseCandles],
        ['binance', binanceCandles],
      ] as const) {
        try {
          candles = await fetcher(symbol, interval)
          if (candles.length >= 30) {
            source = name
            break
          }
        } catch {
          /* fall through to the next feed */
        }
      }
    }
    let closeOnly = false
    if (!source && !pairAddress) {
      try {
        candles = await coingeckoCandles(symbol, interval)
        if (candles.length >= 30) {
          source = 'coingecko'
          closeOnly = true
        }
      } catch {
        /* all feeds down */
      }
    }
    if (!source) {
      return {
        text:
          `[error] no candle feed could serve ${symbol} (${interval}). ` +
          `For long-tail tokens pass the CONTRACT ADDRESS (long-tail candles come from its best DEX pair) — majors work by ticker.`,
      }
    }
    candles.sort((a, b) => a.time - b.time) // oldest → newest

    const d = analyzeCandles(candles, interval, source, closeOnly)
    const f = (x: number | null, fmt: (n: number) => string = (n) => n.toPrecision(5)) =>
      x === null ? '–' : fmt(x)
    const priceFmt = (n: number) => (n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toPrecision(5))

    return {
      text: [
        `📈 TECHNICALS — ${longTailLabel ? `${longTailLabel} ${shortAddress(input.symbol.trim())} — ` : ''}${symbol} (${interval}, source ${source}${closeOnly ? ', close-only' : ''}, ${d.candles} candles)`,
        ``,
        `close $${priceFmt(d.close)} · 1h ${f(d.change1hPct, (x) => x.toFixed(2) + '%')} · 24h ${f(d.change24hPct, (x) => x.toFixed(2) + '%')}`,
        `EMA20 $${f(d.ema20, priceFmt)} / EMA50 $${f(d.ema50, priceFmt)} → stack: ${d.emaStack}`,
        `RSI(14): ${d.rsi14 === null ? '–' : d.rsi14.toFixed(1)}`,
        `MACD: line ${f(d.macd?.line ?? null)} · signal ${f(d.macd?.signal ?? null)} · hist ${f(d.macd?.histogram ?? null)} · cross: ${d.macd?.cross ?? '–'}`,
        `Bollinger: %B ${d.bollinger ? d.bollinger.pctB.toFixed(2) : '–'} · bandwidth ${d.bollinger ? d.bollinger.bandwidthPct.toFixed(2) + '%' : '–'} · squeeze: ${d.bollinger?.squeeze ? 'YES' : 'no'}`,
        `24h range: $${f(d.low24h, priceFmt)} – $${f(d.high24h, priceFmt)} · position ${(d.rangePosition24h ?? 0).toFixed(2)} · volume ${d.volumeTrend}`,
        ``,
        `Readings:`,
        ...d.notes.map((n) => `• ${n}`),
        ``,
        `YOUR JOB: weigh these into a BUY / SELL / HOLD with confidence and an INVALIDATION level`,
        `(the price that proves the call wrong — a signal without one is a horoscope).`,
        `Journal the signal: journal_append pattern "ta:${symbol}:<SIGNAL>@${priceFmt(d.close)}".`,
      ].join('\n'),
    }
  },
})
/**
 * Technical analysis — pure math, zero network, zero opinions.
 * The indicators say WHAT IS; the agent says what it means. Every function
 * returns undefined/neutral when there isn't enough data rather than guessing.
 */

export type Candle = {
  time: number // epoch seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type TaDossier = {
  candles: number
  interval: string
  source: string
  closeOnly: boolean
  close: number
  change1hPct: number | null
  change24hPct: number | null
  ema20: number | null
  ema50: number | null
  emaStack: 'bullish' | 'bearish' | 'mixed' | 'insufficient'
  rsi14: number | null
  macd: { line: number; signal: number; histogram: number; cross: 'bullish' | 'bearish' | 'none' } | null
  bollinger: { upper: number; lower: number; pctB: number; bandwidthPct: number; squeeze: boolean } | null
  volumeTrend: 'rising' | 'falling' | 'flat' | 'insufficient'
  high24h: number | null
  low24h: number | null
  /** 0 = sitting on the 24h low, 1 = at the 24h high. */
  rangePosition24h: number | null
  /** Mechanical observations — no advice, just readings. */
  notes: string[]
}

// ── Indicator primitives ─────────────────────────────────────────────────────

export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!
  return sum / period
}

/** EMA seeded with the SMA of the first `period` values; returns the full series. */
export function emaSeries(values: number[], period: number): number[] | undefined {
  if (values.length < period) return undefined
  const k = 2 / (period + 1)
  const out: number[] = []
  let e = 0
  for (let i = 0; i < period; i++) e += values[i]!
  e /= period
  out.push(e)
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k)
    out.push(e)
  }
  return out
}

export function ema(values: number[], period: number): number | undefined {
  const s = emaSeries(values, period)
  return s ? s[s.length - 1] : undefined
}

/** Wilder's RSI. All-gain → 100, all-loss → 0, flat → 50. */
export function rsi(closes: number[], period = 14): number | undefined {
  const series = rsiSeries(closes, period)
  return series ? series[series.length - 1] : undefined
}

/** Wilder's RSI as a series — index i carries RSI computed from closes[0..i];
 * entries before the warmup are NaN. Backtests need the curve, not the tail. */
export function rsiSeries(closes: number[], period = 14): number[] | undefined {
  if (closes.length < period + 1) return undefined
  const out: number[] = new Array(closes.length).fill(Number.NaN)
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!
    if (d >= 0) avgGain += d
    else avgLoss -= d
  }
  avgGain /= period
  avgLoss /= period
  out[period] = rsiFrom(avgGain, avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = rsiFrom(avgGain, avgLoss)
  }
  return out
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return 50
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

export function macd(closes: number[]): { line: number; signal: number; histogram: number; cross: 'bullish' | 'bearish' | 'none' } | undefined {
  const fast = emaSeries(closes, 12)
  const slow = emaSeries(closes, 26)
  if (!fast || !slow) return undefined
  // fast[k] is EMA at closes index k+11; slow[j] at j+25. Align on slow's indices.
  const line: number[] = []
  for (let j = 0; j < slow.length; j++) line.push(fast[j + 14]! - slow[j]!)
  const sig = emaSeries(line, 9)
  if (!sig) return undefined
  const l = line[line.length - 1]!
  const s = sig[sig.length - 1]!
  const prevHist = line[line.length - 2]! - sig[sig.length - 2]!
  const hist = l - s
  const cross = prevHist <= 0 && hist > 0 ? 'bullish' : prevHist >= 0 && hist < 0 ? 'bearish' : 'none'
  return { line: l, signal: s, histogram: hist, cross }
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period)
  if (mid === undefined) return undefined
  let sq = 0
  for (let i = closes.length - period; i < closes.length; i++) sq += (values(closes, i) - mid) ** 2
  const sd = Math.sqrt(sq / period)
  const upper = mid + mult * sd
  const lower = mid - mult * sd
  const close = closes[closes.length - 1]!
  const width = upper - lower
  return {
    upper,
    lower,
    pctB: width === 0 ? 0.5 : (close - lower) / width,
    bandwidthPct: (width / mid) * 100,
    squeeze: width / mid < 0.04, // narrow bands = coiled spring
  }
}

function values(arr: number[], i: number): number {
  return arr[i]!
}

// ── Series views (dashboard Charts tab, §12.9) ───────────────────────────────
// Same math as the scalar functions above, returned as full arrays aligned to
// the input (NaN before warmup) so a chart can draw the curve, not just the
// tail. Zero opinions here — the renderer decides colors/layout.

/** SMA/center/upper/lower per index; NaN before the warmup. */
export function bollingerSeries(
  closes: number[],
  period = 20,
  mult = 2,
): { mid: number[]; upper: number[]; lower: number[] } | undefined {
  if (closes.length < period) return undefined
  const mid: number[] = new Array(closes.length).fill(Number.NaN)
  const upper: number[] = new Array(closes.length).fill(Number.NaN)
  const lower: number[] = new Array(closes.length).fill(Number.NaN)
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]!
    const m = sum / period
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j]! - m) ** 2
    const sd = Math.sqrt(sq / period)
    mid[i] = m
    upper[i] = m + mult * sd
    lower[i] = m - mult * sd
  }
  return { mid, upper, lower }
}

/** MACD as series: {line, signal, histogram} aligned to closes, NaN before warmup. */
export function macdSeries(
  closes: number[],
): { line: number[]; signal: number[]; histogram: number[] } | undefined {
  const fast = emaSeries(closes, 12)
  const slow = emaSeries(closes, 26)
  if (!fast || !slow) return undefined
  // fast[k] is EMA at closes index k+11; slow[j] at j+25. Align on slow's indices.
  const line: number[] = new Array(closes.length).fill(Number.NaN)
  for (let j = 0; j < slow.length; j++) line[j + 25] = fast[j + 14]! - slow[j]!
  const valid = line.filter((v) => Number.isFinite(v))
  const sig = emaSeries(valid, 9)
  if (!sig) return undefined
  const signal: number[] = new Array(closes.length).fill(Number.NaN)
  const histogram: number[] = new Array(closes.length).fill(Number.NaN)
  let k = 0
  for (let i = 0; i < closes.length; i++) {
    if (!Number.isFinite(line[i]!)) continue
    if (k >= 8) {
      // sig[m] is the EMA(9) ending at the (m+8)-th valid line value
      const s = sig[k - 8]!
      signal[i] = s
      histogram[i] = line[i]! - s
    }
    k++
  }
  return { line, signal, histogram }
}

// ── Dossier assembly ─────────────────────────────────────────────────────────

export function analyzeCandles(candles: Candle[], interval: string, source: string, closeOnly = false): TaDossier {
  const closes = candles.map((c) => c.close)
  const close = closes[closes.length - 1] ?? 0
  const n = closes.length
  const pct = (a: number | undefined, b: number | undefined) =>
    a !== undefined && b !== undefined && b !== 0 ? ((a - b) / b) * 100 : null

  const e20 = ema(closes, 20) ?? null
  const e50 = ema(closes, 50) ?? null
  const emaStack = e20 === null || e50 === null ? 'insufficient' : e20 > e50 * 1.001 ? 'bullish' : e20 < e50 * 0.999 ? 'bearish' : 'mixed'
  const r = rsi(closes)
  const m = macd(closes)
  const bb = bollinger(closes) ?? null

  const vols = candles.map((c) => c.volume)
  const recentVol = vols.slice(-5)
  const priorVol = vols.slice(-25, -5)
  const volAvg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const volumeTrend =
    closeOnly || recentVol.length === 0 || priorVol.length === 0
      ? 'flat'
      : recentVol.reduce((a, b) => a + b, 0) / recentVol.length >
          priorVol.reduce((a, b) => a + b, 0) / priorVol.length * 1.25
        ? 'rising'
        : recentVol.reduce((a, b) => a + b, 0) / recentVol.length <
            priorVol.reduce((a, b) => a + b, 0) / priorVol.length * 0.75
          ? 'falling'
          : 'flat'

  const last24 = candles.slice(interval === 'hourly' ? -24 : -1)
  const highs = last24.map((c) => c.high)
  const lows = last24.map((c) => c.low)
  const high24 = highs.length ? Math.max(...highs) : null
  const low24 = lows.length ? Math.min(...lows) : null
  const rangePosition24h =
    high24 !== null && low24 !== null && high24 > low24 ? (close - low24) / (high24 - low24) : null

  const notes: string[] = []
  if (r !== undefined) {
    if (r < 30) notes.push(`RSI ${r.toFixed(0)} — oversold zone (<30)`)
    else if (r > 70) notes.push(`RSI ${r.toFixed(0)} — overbought zone (>70)`)
    else notes.push(`RSI ${r.toFixed(0)} — neutral band`)
  }
  if (m) notes.push(`MACD histogram ${m.histogram >= 0 ? '+' : ''}${m.histogram.toPrecision(3)}${m.cross !== 'none' ? ` — fresh ${m.cross} cross` : ''}`)
  if (bb) {
    if (bb.squeeze) notes.push(`Bollinger squeeze (bandwidth ${bb.bandwidthPct.toFixed(1)}%) — low volatility, breakout setup`)
    if (bb.pctB > 1) notes.push(`%B ${bb.pctB.toFixed(2)} — closing ABOVE the upper band`)
    else if (bb.pctB < 0) notes.push(`%B ${bb.pctB.toFixed(2)} — closing BELOW the lower band`)
  }
  if (rangePosition24h !== null) {
    if (rangePosition24h > 0.95) notes.push('at the top of the 24h range')
    else if (rangePosition24h < 0.05) notes.push('at the bottom of the 24h range')
  }
  if (closeOnly) notes.push('⚠️ close-only data (no intraday highs/lows) — range stats degraded')

  return {
    candles: n,
    interval,
    source,
    closeOnly,
    close,
    change1hPct: pct(closes[n - 1], closes[n - 2]),
    change24hPct: pct(closes[n - 1], closes[Math.max(0, n - (interval === 'hourly' ? 24 : 1))]),
    ema20: e20,
    ema50: e50,
    emaStack,
    rsi14: r ?? null,
    macd: m ?? null,
    bollinger: bb
      ? { upper: bb.upper, lower: bb.lower, pctB: bb.pctB, bandwidthPct: bb.bandwidthPct, squeeze: bb.squeeze }
      : null,
    volumeTrend,
    high24h: high24,
    low24h: low24,
    rangePosition24h,
    notes,
  }
}
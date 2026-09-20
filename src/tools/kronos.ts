import { z } from 'zod'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { defineTool } from './registry.js'
import { deskRoot, type Config } from '../config.js'
import { fmtUsd } from '../market/feeds.js'
import { appendForecastRecord, type ForecastRecord } from '../market/forecastGrader.js'
import { binanceCandles, coingeckoCandles, geckoTerminalCandles } from './technicals.js'
import { resolveForecastSymbol, shortAddress } from './tokens.js'
import type { Candle } from '../market/ta.js'

/**
 * kronos_forecast — quantile-band forecast from the Kronos foundation model
 * (vendored MIT, see kronos-server/ATTRIBUTION.md). The runner lives in a
 * separate Python venv; the desk spawns it per call and never imports it.
 *
 * Honesty invariants:
 *  - the tool returns a DISTRIBUTION (p25/p50/p75 paths + P(up)), never a
 *    point prediction — a wide band means low conviction, and the text says so
 *  - Kronos sees only OHLCV candles: no news, no onchain flow, no order books
 *  - it is one more signal for the journal: graded vs BTC like every other,
 *    zero authority, zero veto — wide band ⇒ no trade
 * Symbol policy: ANY ticker a feed can honestly serve (Binance klines first,
 * CoinGecko fallback for majors) or a Base ERC-20 contract address, pinpointed
 * to its most liquid DexScreener pool via GeckoTerminal OHLCV. No hardcoded
 * list — the feed verdict is the gate, and every issued record stores WHERE
 * its candles came from so grading judges the same series at horizon.
 */

type Interval = 'hourly' | 'daily'

const MIN_CANDLES = 240
const MAX_CONTEXT = 512 // Kronos-small/base max context

function kronosCommand(): string {
  return process.env.KRONOS_COMMAND ?? path.join(deskRoot(), 'kronos-server', 'run.sh')
}

function kronosArgs(): string[] {
  return (process.env.KRONOS_ARGS ?? '')
    .split('||')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function kronosTimeoutMs(): number {
  const v = Number(process.env.KRONOS_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 300_000 // first run downloads weights
}

/** Binance first (full OHLCV, 1000 bars) → CoinGecko close-only fallback. */
async function kronosCandles(
  symbol: string,
  interval: Interval,
): Promise<{ candles: Candle[]; source: 'binance' | 'coingecko' } | undefined> {
  try {
    const c = await binanceCandles(symbol, interval, 1000)
    if (c.length >= MIN_CANDLES) return { candles: c, source: 'binance' }
  } catch {
    /* fall through */
  }
  try {
    const c = await coingeckoCandles(symbol, interval, interval === 'hourly' ? 30 : 365)
    if (c.length >= MIN_CANDLES) return { candles: c, source: 'coingecko' }
  } catch {
    /* both feeds down */
  }
  return undefined
}

/** Spawn the kronos runner, feed it JSON, read one JSON line back. */
function runKronos(request: object): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(kronosCommand(), kronosArgs(), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({
        ok: false,
        error:
          `kronos runner timed out after ${kronosTimeoutMs() / 1000}s ` +
          `(first run downloads model weights from HuggingFace — retry once before suspecting the lane)`,
      })
    }, kronosTimeoutMs())

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `kronos runner failed to start: ${err.message}` })
    })
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', () => {
      clearTimeout(timer)
      const text = stdout.trim()
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>
          if (obj.ok === false) resolve({ ok: false, error: String(obj.error ?? 'kronos runner reported failure') })
          else resolve({ ok: true, data: obj })
          return
        }
      } catch {
        /* fall through to the raw-output error */
      }
      const tail = (stderr || stdout || '(no output)').trim().split('\n').slice(-3).join(' | ').slice(0, 400)
      resolve({ ok: false, error: `kronos runner did not return JSON. tail: ${tail}` })
    })

    child.stdin.write(JSON.stringify(request))
    child.stdin.end()
  })
}

const priceFmt = (n: number | null | undefined) =>
  n === null || n === undefined ? '–' : n >= 1 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${n.toPrecision(4)}`

/**
 * One Kronos forecast run — validation, candles, runner, record. Shared by the
 * tool and the dashboard's Kronos tab ("run now"): ONE lane, both front doors,
 * same honesty invariants and the same forecast record for grading.
 */
export async function runForecast(
  cfg: Config,
  input: { symbol: string; interval?: 'hourly' | 'daily'; predLen?: number; sampleCount?: number },
): Promise<string> {
  const interval: Interval = input.interval ?? 'hourly'

  const resolved = await resolveForecastSymbol(input.symbol)
  if (resolved.kind === 'refuse') return `[error] ${resolved.reason}`

  let candles: Candle[] = []
  let poolNote = ''
  let idSuffix = ''
  let recordExtras: Partial<ForecastRecord> = {}

  if (resolved.kind === 'contract') {
    // DEX lane: the token's own pool, Base only. Best pair first, then the
    // runner-ups — thin/abandoned pools sometimes have no GT history.
    const symbol = resolved.symbol
    const candidates = [resolved, ...resolved.alternates.map((pairAddress) => ({ pairAddress }))]
    for (const cand of candidates) {
      const isBest = cand === resolved
      try {
        const c = await geckoTerminalCandles('base', cand.pairAddress, interval)
        if (c.length >= MIN_CANDLES) {
          candles = c
          idSuffix = `@${cand.pairAddress.slice(0, 8)}`
          const liq = isBest ? resolved.liquidityUsd : undefined
          const dex = isBest ? resolved.dexId : 'base pool'
          recordExtras = {
            source: 'geckoterminal',
            chainId: 'base',
            pairAddress: cand.pairAddress,
            baseAddress: resolved.address,
            label: resolved.label,
            liquidityUsd: liq,
          }
          poolNote =
            `DEX pool candles: ${dex} pair ${shortAddress(cand.pairAddress)} on Base` +
            (liq !== undefined ? ` ($${liq.toLocaleString()} liquidity)` : '') +
            ` — thin pools make noisy bands; the grade still judges it.`
          break
        }
        if (isBest && resolved.alternates.length === 0) {
          return (
            `[error] GeckoTerminal has only ${c.length} ${interval} bars for ${symbol} pool ${shortAddress(cand.pairAddress)} ` +
            `(needs ≥${MIN_CANDLES}) — the pool is too young or too dead for a forecast. kronos lane skipped.`
          )
        }
      } catch (err) {
        if (isBest && resolved.alternates.length === 0) {
          return (
            `[error] no DEX candle feed could serve ${symbol} pool ${shortAddress(cand.pairAddress)}: ` +
            `${err instanceof Error ? err.message : String(err)} — kronos lane skipped.`
          )
        }
      }
    }
    if (candles.length === 0) {
      // Every pool (best + alternates) came back thin or dead.
      return (
        `[error] no Base pool for ${symbol} has ≥${MIN_CANDLES} ${interval} bars on GeckoTerminal ` +
        `(best: ${shortAddress(resolved.pairAddress)}) — the pools are too young or too dead for a forecast. kronos lane skipped.`
      )
    }
  } else {
    const symbol = resolved.symbol
    const served = await kronosCandles(symbol, interval)
    if (!served) {
      return (
        `[error] no candle feed could serve ${symbol} (${interval}, need ≥${MIN_CANDLES} bars): ` +
        `Binance klines rejected it and CoinGecko has no close-only series for it — kronos lane skipped.`
      )
    }
    candles = served.candles
    recordExtras = { source: served.source }
  }

  candles.sort((a, b) => a.time - b.time)
  const trimmed = candles.slice(-MAX_CONTEXT)
  if (trimmed.length < MIN_CANDLES) {
    return `[error] only ${trimmed.length} bars available (${interval}) — below the ${MIN_CANDLES}-bar floor.`
  }
  const symbol = resolved.symbol

  const lastClose = trimmed[trimmed.length - 1]!.close
  const res = await runKronos({
    candles: trimmed.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    predLen: input.predLen ?? 12,
    T: 1.0,
    topP: 0.9,
    sampleCount: input.sampleCount ?? 8,
    maxContext: MAX_CONTEXT,
    interval,
  })
    if (!res.ok || !res.data) {
      return `[error] kronos forecast failed: ${res.error}`
    }
    const d = res.data

    const p50Path = (d.p50 as number[] | undefined) ?? []
    const horizonIdx = p50Path.length - 1
    const bandLow = typeof d.bandLow === 'number' ? d.bandLow : null
    const bandHigh = typeof d.bandHigh === 'number' ? d.bandHigh : null
    const pUp = typeof d.pUp === 'number' ? d.pUp : null
    const move = typeof d.horizonMovePct === 'number' ? d.horizonMovePct : null
    const width = typeof d.bandWidthPct === 'number' ? d.bandWidthPct : null

    const stance =
      width === null ? '' :
      width > 8 ? `\nBand width ${width.toFixed(1)}% — WIDE. The model is arguing with itself; treat as no-signal.` :
      width < 2 ? `\nBand width ${width.toFixed(1)}% — tight. Still not authority: journal it and let grading judge.` :
      `\nBand width ${width.toFixed(1)}% — moderate.`

    const pathLine =
      p50Path.length > 0
        ? `path p50 at horizon (+${p50Path.length} ${interval === 'hourly' ? 'h' : 'd'}): ${priceFmt(p50Path[horizonIdx] ?? null)}`
        : ''

    // Store the forecast at issue so grading can judge it at horizon (the
    // record starts building the hit-rate; a forecast never graded is a
    // horoscope). Storage failure never breaks the tool call.
    try {
      if (bandLow !== null && bandHigh !== null && p50Path.length > 0) {
        const predLen = input.predLen ?? 12
        const rec: ForecastRecord = {
          id: `${symbol}${idSuffix}-${interval}-${Date.now()}`,
          symbol,
          interval,
          issuedAt: Date.now(),
          issuedPrice: lastClose,
          horizonCandles: predLen,
          candleMs: interval === 'hourly' ? 3_600_000 : 86_400_000,
          bandLow,
          bandHigh,
          p50: p50Path[horizonIdx]!,
          pUp,
          movePct: typeof move === 'number' ? move : ((p50Path[horizonIdx]! - lastClose) / lastClose) * 100,
          ...recordExtras,
        }
        appendForecastRecord(cfg, rec)
      }
    } catch (err) {
      console.warn(`forecast record: ${err instanceof Error ? err.message : String(err)}`)
    }

    const provenance =
      recordExtras.source === 'geckoterminal'
        ? `geckoterminal (${resolved.kind === 'contract' ? `${resolved.dexId} · $${(resolved.liquidityUsd ?? 0).toLocaleString()} liquidity` : 'pool'})`
        : String(recordExtras.source)
    const lines = [
      `🔮 KRONOS FORECAST — ${symbol} ${interval} · ${provenance} · ${String(d.model ?? 'Kronos-small')} · ${String(d.sampleCount ?? '?')} sample paths · lookback ${String(d.lookback ?? '?')} bars`,
      `now ${priceFmt(lastClose)} → ${pathLine} (${move === null ? '–' : (move >= 0 ? '+' : '') + move.toFixed(2) + '%'} at p50)`,
      `band p25–p75 at horizon: ${priceFmt(bandLow)} – ${priceFmt(bandHigh)}${width === null ? '' : ` (width ${width.toFixed(1)}%)`}`,
      `P(up by horizon): ${pUp === null ? '–' : Math.round(pUp * 100) + '%'}`,
      stance,
    ]
    if (poolNote) lines.push(poolNote)
    lines.push(
      ``,
      `This model saw ONLY OHLCV candles — no news, no onchain flow, no order books. It is one more signal for the`,
      `journal, never a trade authority: pattern "kronos:${symbol}:${interval}", graded vs BTC with everything else.`,
    )
    return lines.join('\n')
}

export const kronosForecastTool = defineTool({
  name: 'kronos_forecast',
  description:
    'Quantile-band price forecast from the Kronos candlestick foundation model (OHLCV-only, CPU). ' +
    'Accepts a ticker (any symbol Binance or CoinGecko can serve ≥240 candles) or a Base ERC-20 CONTRACT ' +
    'ADDRESS (pinpoint — resolved to its most liquid DexScreener pool; same-ticker-different-contract is ' +
    'everywhere, the address is the asset). Returns p25/p50/p75 paths and P(up) at the horizon. This is a ' +
    'DISTRIBUTION, not a prediction: a wide band means skip. DEX pool candles are flagged — thin pools make ' +
    'noisy bands. Journal every call (pattern "kronos:<SYMBOL>:<interval>") and let signal grading decide ' +
    'whether this model earns a spot in the book.',
  danger: 'readonly',
  input: z.object({
    symbol: z.string().describe('ticker (e.g. "BTC", any Binance-listed symbol) or Base ERC-20 contract address'),
    interval: z.enum(['hourly', 'daily']).optional().describe('candle size (default hourly)'),
    predLen: z.number().int().min(1).max(120).optional().describe('bars ahead to forecast (default 12)'),
    sampleCount: z.number().int().min(2).max(32).optional().describe('forecast sample paths (default 8)'),
  }),
  execute: async (input, ctx) => ({ text: await runForecast(ctx.cfg, input) }),
})
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { priceForRecord } from './priceHistory.js'
import { log } from '../log.js'

/**
 * Forecast grading (Phase 10.3) — every Kronos forecast is stored at issue and
 * graded against reality at horizon. A forecaster that never gets graded is a
 * horoscope; this closes the loop the same way signalGrader grades TA calls.
 *
 * Grading questions per record:
 *   • inBand   — did the actual price land inside the p25–p75 band the model
 *                published at horizon? (calibration)
 *   • direction — did price move the way the p50 path said, when the model
 *                actually committed to a direction (|move| ≥ 0.1%)?
 */

export type ForecastRecord = {
  id: string
  symbol: string
  interval: 'hourly' | 'daily'
  issuedAt: number
  /** Last close at issue time — the forecast's "now". */
  issuedPrice: number
  horizonCandles: number
  candleMs: number
  /** p25–p75 band at horizon (the model's published uncertainty). */
  bandLow: number
  bandHigh: number
  /** p50 path value at horizon. */
  p50: number
  pUp: number | null
  /** p50 vs issuedPrice, %. */
  movePct: number
  /** How the candles were served — grading follows the SAME feed per record. */
  source?: 'binance' | 'coingecko' | 'geckoterminal'
  /** Contract records: the exact pool the forecast was issued on (Base). */
  chainId?: string
  pairAddress?: string
  baseAddress?: string
  label?: string
  liquidityUsd?: number
  graded?: {
    gradedAt: number
    actualPrice: number
    inBand: boolean
    directionHit: boolean | null
    actualMovePct: number
  }
}

export function forecastsPath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'forecasts.jsonl')
}

export function appendForecastRecord(cfg: Config, rec: ForecastRecord): void {
  fs.mkdirSync(path.dirname(forecastsPath(cfg)), { recursive: true })
  fs.appendFileSync(forecastsPath(cfg), `${JSON.stringify(rec)}\n`)
}

export function readForecasts(cfg: Config): ForecastRecord[] {
  try {
    const raw = fs.readFileSync(forecastsPath(cfg), 'utf8')
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as ForecastRecord)
  } catch {
    return []
  }
}

/** Records are append-only; the newest per (symbol, issuedAt) wins on rewrites. */
function rewriteGraded(cfg: Config, all: ForecastRecord[]): void {
  const tmp = `${forecastsPath(cfg)}.tmp`
  fs.writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.renameSync(tmp, forecastsPath(cfg))
}

function dueTs(r: ForecastRecord): number {
  return r.issuedAt + r.horizonCandles * r.candleMs
}

export type ForecastGradeResult = {
  graded: Array<{ id: string; symbol: string; inBand: boolean; directionHit: boolean | null; actualMovePct: number }>
  awaitingPrice: number
}

/** Direction threshold: below this the model didn't really commit. */
const NEUTRAL_MOVE_PCT = 0.1

export async function gradeDueForecasts(
  cfg: Config,
  priceFn: (rec: ForecastRecord, ts: number) => Promise<number | undefined> = priceForRecord,
): Promise<ForecastGradeResult> {
  const all = readForecasts(cfg)
  const now = Date.now()
  const graded: ForecastGradeResult['graded'] = []
  let awaitingPrice = 0
  for (const r of all) {
    if (r.graded) continue
    if (dueTs(r) > now) continue // horizon not reached yet
    const actual = await priceFn(r, dueTs(r))
    if (actual === undefined || !Number.isFinite(actual) || actual <= 0) {
      awaitingPrice++
      continue
    }
    const actualMovePct = Math.round(((actual / r.issuedPrice - 1) * 100) * 100) / 100
    const inBand = actual >= r.bandLow && actual <= r.bandHigh
    const committed = Math.abs(r.movePct) >= NEUTRAL_MOVE_PCT
    const directionHit =
      Math.abs(actualMovePct) < NEUTRAL_MOVE_PCT
        ? null
        : Math.sign(actualMovePct) === Math.sign(r.movePct)
    r.graded = { gradedAt: now, actualPrice: Math.round(actual * 100) / 100, inBand, directionHit, actualMovePct }
    graded.push({ id: r.id, symbol: r.symbol, inBand, directionHit, actualMovePct })
    log.debug(`forecast graded: ${r.id} inBand=${inBand} dir=${directionHit}`)
  }
  if (graded.length > 0) rewriteGraded(cfg, all)
  return { graded, awaitingPrice }
}

export type ForecastAccuracy = {
  issued: number
  graded: number
  inBand: number
  hits: number
  directionGraded: number
  hitRatePct: number | null
  inBandPct: number | null
}

/** Rolling accuracy across graded forecasts. */
export function forecastAccuracy(cfg: Config): ForecastAccuracy {
  const all = readForecasts(cfg).filter((r) => r.graded)
  const inBand = all.filter((r) => r.graded!.inBand).length
  const dirGraded = all.filter((r) => r.graded!.directionHit !== null)
  const hits = dirGraded.filter((r) => r.graded!.directionHit).length
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10)
  return {
    issued: readForecasts(cfg).length,
    graded: all.length,
    inBand,
    hits,
    directionGraded: dirGraded.length,
    hitRatePct: pct(hits, dirGraded.length),
    inBandPct: pct(inBand, all.length),
  }
}
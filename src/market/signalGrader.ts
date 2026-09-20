import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { readJournal } from '../tools/journal.js'
import { appendJsonl, readJsonl } from '../store/jsonl.js'
import { getUsdPrice, priceAt } from './feeds.js'
import { log } from '../log.js'
import { advanceSignal, signalState, IllegalTransitionError } from './signalLifecycle.js'

/**
 * TA signal grading — the desk audits its OWN calls.
 * Journaled signals ("ta:SOL:HOLD@98.86 …" in journal decision text) are graded
 * against the live price one interval later — and, stolen from TradingAgents,
 * against a BENCHMARK: a BUY only hits if it beat holding BTC (ETH for BTC
 * signals) over the same window. Up-but-underperforming is a miss: no alpha,
 * no reason to have traded. Hits/misses accumulate in data/grades/ta.jsonl;
 * once n >= lessonsSampleMin a rolling accuracy lesson is distilled into
 * lessons.md (replacing the previous one, so it stays current).
 * This is what turns opinions into a track record — and it's code, not prompt.
 */

export type TaSignal = {
  symbol: string
  signal: 'BUY' | 'SELL' | 'HOLD'
  entryPrice: number
}

export function parseSignal(decision: string): TaSignal | undefined {
  const m = /ta:([A-Z0-9]+):(BUY|SELL|HOLD)@([\d,.]+)/i.exec(decision)
  if (!m) return undefined
  const price = Number(m[3]!.replace(/,/g, ''))
  if (!Number.isFinite(price) || price <= 0) return undefined
  return { symbol: m[1]!.toUpperCase(), signal: m[2]!.toUpperCase() as TaSignal['signal'], entryPrice: price }
}

export type SignalGrade = {
  key: string
  symbol: string
  signal: TaSignal['signal']
  entryTs: number
  entryPrice: number
  gradedPrice: number
  movePct: number
  /** Benchmark the alpha was measured against (BTC, or ETH for BTC signals). */
  benchSymbol?: string
  /** Benchmark's move over the same window; null when history couldn't serve it. */
  benchMovePct?: number | null
  /** movePct − benchMovePct; null when benchmark unknown or signal is a HOLD. */
  alphaPct?: number | null
  /**
   * Alpha-adjusted: BUY hits when it BEAT the benchmark, SELL when the token
   * underperformed it. Falls back to raw direction when the benchmark price
   * at entry couldn't be fetched. HOLD: nothing to grade → null.
   */
  hit: boolean | null
}

export function taGradesPath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'grades', 'ta.jsonl')
}

function readGrades(cfg: Config): SignalGrade[] {
  return readJsonl<SignalGrade>(taGradesPath(cfg))
}

export type SignalAccuracy = {
  graded: number // BUY/SELL graded (HOLDs excluded)
  hits: number
  hitRatePct: number | null
  avgMovePct: number | null
  /** Average excess move vs the benchmark across grades that have one. */
  avgAlphaPct: number | null
}

/** The most recent grades, newest first — the dashboard's track-record table. */
export function recentGrades(cfg: Config, n = 10): SignalGrade[] {
  return readGrades(cfg)
    .filter((g) => g.signal !== 'HOLD')
    .slice(-n)
    .reverse()
}

/** Rolling accuracy across all graded directional signals. */
export function signalAccuracy(cfg: Config): SignalAccuracy {
  const directional = readGrades(cfg).filter((g) => g.signal !== 'HOLD')
  if (directional.length === 0) {
    return { graded: 0, hits: 0, hitRatePct: null, avgMovePct: null, avgAlphaPct: null }
  }
  const hits = directional.filter((g) => g.hit).length
  const avgMove = directional.reduce((sum, g) => sum + g.movePct, 0) / directional.length
  const alphas = directional.filter((g) => typeof g.alphaPct === 'number')
  const avgAlpha = alphas.length > 0 ? alphas.reduce((sum, g) => sum + (g.alphaPct ?? 0), 0) / alphas.length : null
  return {
    graded: directional.length,
    hits: hits,
    hitRatePct: Math.round((hits / directional.length) * 1000) / 10,
    avgMovePct: Math.round(avgMove * 100) / 100,
    avgAlphaPct: avgAlpha === null ? null : Math.round(avgAlpha * 100) / 100,
  }
}

export type GradeResult = {
  graded: SignalGrade[]
  skipped: number // not yet mature
  awaitingPrice: number // feed couldn't serve a price this round
}

/** Grade every journaled signal older than minAgeMs that hasn't been graded yet. */
export async function gradeDueSignals(
  cfg: Config,
  opts: { nowMs?: number; minAgeMs?: number } = {},
): Promise<GradeResult> {
  const now = opts.nowMs ?? Date.now()
  const minAge = opts.minAgeMs ?? 24 * 3600_000 // one day — a TA call needs room to be right or wrong

  const gradedKeys = new Set(readGrades(cfg).map((g) => g.key))
  // Same signal restated (closure/outcome entries often quote the original
  // "ta:SYM:SIGNAL@price" pattern) must not become a second grade.
  const gradedPrints = new Set(
    readGrades(cfg).map((g) => `${g.symbol}:${g.signal}:${g.entryPrice}`),
  )
  const result: GradeResult = { graded: [], skipped: 0, awaitingPrice: 0 }

  for (const entry of readJournal(cfg)) {
    const sig = parseSignal(entry.decision)
    if (!sig) continue
    const key = `${entry.ts}:${sig.symbol}:${sig.signal}`
    // The daily reviewer journals outcomes ("graded SOL BUY — closed…") that may
    // restate the pattern; those are bookkeeping, not fresh signals.
    if (/\b(closed|resolved|graded|outcome)\b/i.test(entry.decision)) continue
    if (gradedPrints.has(`${sig.symbol}:${sig.signal}:${sig.entryPrice}`)) continue
    if (gradedKeys.has(key)) continue
    // Lifecycle gate (Nautilus steal): grading idempotent BY STATE. A signal
    // already CLOSED (graded) can never be re-graded, whatever the journal says.
    const lifecycle = signalState(cfg, key)
    if (lifecycle === 'CLOSED') continue
    if (lifecycle === undefined) advanceSignal(cfg, key, 'PROPOSED', { reason: 'journaled', now })
    if (now - entry.ts < minAge) {
      result.skipped += 1
      continue
    }
    const quote = await getUsdPrice(sig.symbol)
    if (!quote) {
      result.awaitingPrice += 1
      continue
    }
    const movePct = ((quote.usd - sig.entryPrice) / sig.entryPrice) * 100

    // Alpha leg: what did the benchmark do over the SAME window? Bench is BTC
    // (ETH for BTC signals) — the "do nothing smarter" alternative.
    const benchSymbol = sig.symbol === 'BTC' ? 'ETH' : 'BTC'
    const [benchNow, benchEntry] = await Promise.all([getUsdPrice(benchSymbol), priceAt(benchSymbol, entry.ts)])
    const benchMovePct =
      benchNow && benchEntry ? ((benchNow.usd - benchEntry) / benchEntry) * 100 : null

    const alphaPct = benchMovePct === null ? null : Math.round((movePct - benchMovePct) * 100) / 100
    const hit =
      sig.signal === 'HOLD'
        ? null
        : benchMovePct === null
          ? sig.signal === 'BUY'
            ? quote.usd > sig.entryPrice // benchmark down — grade on raw direction
            : quote.usd < sig.entryPrice
          : sig.signal === 'BUY'
            ? movePct > benchMovePct // beat the benchmark, not merely rose
            : movePct < benchMovePct // underperformed it — getting out was right
    const grade: SignalGrade = {
      key,
      symbol: sig.symbol,
      signal: sig.signal,
      entryTs: entry.ts,
      entryPrice: sig.entryPrice,
      gradedPrice: quote.usd,
      movePct: Math.round(movePct * 100) / 100,
      benchSymbol,
      benchMovePct: benchMovePct === null ? null : Math.round(benchMovePct * 100) / 100,
      alphaPct,
      hit,
    }
    // Claim the CLOSED state BEFORE the grade lands — if another grader got
    // there first, the illegal transition refuses and no duplicate grade lands.
    try {
      advanceSignal(cfg, key, 'CLOSED', { reason: `graded: hit=${String(hit)}`, now })
    } catch (e) {
      if (e instanceof IllegalTransitionError) {
        log.warn(`signal lifecycle: refusing duplicate grade for ${key}: ${e.message}`)
        gradedKeys.add(key)
        continue
      }
      throw e
    }
    appendJsonl(taGradesPath(cfg), grade)
    gradedKeys.add(key)
    result.graded.push(grade)
  }

  if (result.graded.length > 0) distillTaLesson(cfg)
  return result
}

/**
 * Rolling lesson — distinct from distillLessons(): the TA accuracy lesson is
 * REWRITTEN each time (marker-replaced) because the numbers it reports move.
 */
export function distillTaLesson(cfg: Config): void {
  const acc = signalAccuracy(cfg)
  const minSamples = cfg.lessonsSampleMin
  if (acc.graded < minSamples) return
  const dir = path.join(cfg.paths.dataDir, 'lessons')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'lessons.md')
  const marker = 'lesson:ta-accuracy'
  const line =
    `- [n=${acc.graded}, conf=high] TA-signal track record (rolling, alpha vs BTC): ${acc.hits}/${acc.graded} directional calls beat their benchmark ` +
    `(${acc.hitRatePct}%), avg move ${acc.avgMovePct}%, avg alpha ${acc.avgAlphaPct ?? 'n/a'}% at grading time. ` +
    `"Up" is not a hit — only outperforming BTC counts. Weigh this before trusting new TA signals. <!-- ${marker} -->\n`
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const re = new RegExp(`^.*<!-- ${marker} -->\\n?`, 'm')
    if (re.test(existing)) {
      fs.writeFileSync(file, existing.replace(re, line))
    } else {
      fs.appendFileSync(file, line)
    }
  } catch (err) {
    log.warn(`ta lesson write failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
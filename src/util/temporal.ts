import type { Config } from '../config.js'

/**
 * Temporal awareness — the desk's north star for "what day is it".
 * LLM brains guess dates and confidently misgrade "yesterday"; every run gets
 * AUTHORITATIVE anchors in the principal's timezone instead. All math is done
 * on CIVIL dates (Y-M-D in the zone), never "+24h" arithmetic, so DST can't
 * skew yesterday/tomorrow.
 */

const DAY_MS = 86_400_000

/** Civil date (YYYY-MM-DD) of a moment in a timezone. */
function dayKeyInTz(tz: string, atMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs))
}

/** Civil date shifted by whole calendar days (DST-safe — no hour math). */
function civilShift(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** Weekday + long date of a civil date (noon UTC — weekday is zone-independent). */
function describeDay(key: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${key}T12:00:00Z`))
}

export type TemporalAnchors = {
  nowLine: string
  todayKey: string
  yesterdayKey: string
  tomorrowKey: string
  text: string
}

export function temporalAnchors(cfg: Config, atMs: number = Date.now()): TemporalAnchors {
  const tz = cfg.timezone
  const nowLine = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  }).format(new Date(atMs))
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(atMs))
      .find((p) => p.type === 'timeZoneName')?.value ?? ''

  const todayKey = dayKeyInTz(tz, atMs)
  const yesterdayKey = civilShift(todayKey, -1)
  const tomorrowKey = civilShift(todayKey, 1)
  const today = describeDay(todayKey)
  const yesterday = describeDay(yesterdayKey)
  const tomorrow = describeDay(tomorrowKey)

  const text =
    `## NOW — time anchors (authoritative; the principal's clock)\n` +
    `Current time: ${nowLine} (${tz}, UTC ${offset.replace('GMT', '')})\n` +
    `Today is ${today} (${todayKey}). Yesterday was ${yesterday} (${yesterdayKey}). Tomorrow is ${tomorrow} (${tomorrowKey}).\n` +
    `When the principal says today/yesterday/tomorrow/this week, use THESE dates — never guess, never use training-data time.\n` +
    `Journal/ledger timestamps are epoch milliseconds; read them in THIS zone. Journal dates below are shown in this zone.\n` +
    `When a plan says "in 24h" or "by tomorrow", state the concrete date+time it lands on.`

  return { nowLine, todayKey, yesterdayKey, tomorrowKey, text }
}

/** Human-readable local timestamp for journal/ledger lines: "2026-09-01 20:15 EDT". */
export function fmtLocalTs(tz: string, atMs: number): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs))
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(atMs))
  return `${date} ${time}`
}

/** Relative day tag relative to NOW: today / yesterday / n days ago / date. */
export function relDay(tz: string, atMs: number, nowMs: number): string {
  const key = dayKeyInTz(tz, atMs)
  const today = dayKeyInTz(tz, nowMs)
  const [ty, tm, td] = today.split('-').map(Number)
  const [ay, am, ad] = key.split('-').map(Number)
  const days = Math.round(
    (Date.UTC(ay!, (am ?? 1) - 1, ad ?? 1) - Date.UTC(ty!, (tm ?? 1) - 1, td ?? 1)) / DAY_MS,
  )
  if (days === 0) return 'today'
  if (days === -1) return 'yesterday'
  if (days === -2) return '2 days ago'
  if (days === 1) return 'tomorrow'
  return `${Math.abs(days)} days ${days < 0 ? 'ago' : 'ahead'}`
}
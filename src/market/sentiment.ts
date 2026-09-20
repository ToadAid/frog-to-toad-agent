import { fetchJson } from '../http.js'

/**
 * Crypto Fear & Greed Index (alternative.me) — extracted from the
 * market_sentiment tool so the morning brief and the sentinel read the same
 * numbers without re-implementing the fetch.
 */

export type FngReading = {
  value: number
  classification: string
  /** Trend context from the trailing series. */
  weekAvg: number | null
  monthAvg: number | null
  yesterday: number | null
}

type FngResponse = {
  data?: Array<{ value?: string; value_classification?: string; timestamp?: string }>
}

export async function fetchFearGreed(): Promise<FngReading | undefined> {
  const data = await fetchJson<FngResponse>('https://api.alternative.me/fng/?limit=30')
  const rows = data.data ?? []
  if (rows.length === 0) return undefined
  const value = (r: (typeof rows)[0]) => Number(r.value)
  const today = rows[0]!
  const v = value(today)
  if (!Number.isFinite(v)) return undefined
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)
  return {
    value: v,
    classification: today.value_classification ?? '?',
    weekAvg: avg(rows.slice(0, 7).map(value).filter(Number.isFinite)),
    monthAvg: avg(rows.slice(0, 30).map(value).filter(Number.isFinite)),
    yesterday: rows[1] ? value(rows[1]) || null : null,
  }
}
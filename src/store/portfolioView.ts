import { readPositions, readLedger, ledgerAssetKey } from './positions.js'
import { getUsdPrice } from '../market/feeds.js'
import type { Config } from '../config.js'
import { log } from '../log.js'

/** Cumulative realized PnL, one point per day a close landed (oldest first). */
export type PnlPoint = { day: string; realizedUsd: number }

/**
 * Shared portfolio snapshot: open positions priced LIVE from the feed chain,
 * realized PnL totals (all-time + today, bucketed in the PRINCIPAL's timezone),
 * the daily cumulative PnL series, and execution counts. One source of truth
 * for the dashboard /status endpoint AND the morning brief — the fold logic
 * lives here once, not twice.
 */

export type ViewPosition = {
  symbol: string
  tokenAddress?: string
  qty: number
  avgEntryUsd: number
  costBasisUsd: number
  markUsd: number | null
  valueUsd: number | null
  unrealizedPnlUsd: number | null
}

export type ExecSummary = {
  opens: number
  closes: number
  liveOpens: number
  avgOpenUsd: number | null
  largestOpenUsd: number | null
}

/**
 * Ledger integrity (Nautilus fail-closed PnL steal): the view REFUSES to
 * present its numbers as trustworthy without saying where the data holes are.
 * Corrupt lines skipped silently = PnL lies with a straight face; a close of
 * something never opened (or larger than held) = the ledger disagrees with
 * itself. Callers (brief, dashboard) must surface `ok: false` loudly.
 */
export type LedgerIntegrity = {
  ok: boolean
  /** Ledger lines that failed to parse (skipped — the fold never saw them). */
  corruptLines: number
  /** Closes of a position the ledger never opened. */
  orphanCloses: number
  /** Closes larger than the held position (excess qty clamped, silently lost PnL). */
  clampedCloses: number
}

export type PortfolioView = {
  positions: ViewPosition[]
  realizedPnlUsd: number
  /** Realized PnL from closes that landed TODAY (principal's calendar day). */
  realizedTodayUsd: number
  /** Cash deployed today (for the day-cap readout). */
  dailySpendUsd: number
  unrealizedPnlUsd: number | null
  /** Daily cumulative realized PnL, one point per day a close landed. */
  pnlDaily: PnlPoint[]
  exec: ExecSummary
  integrity: LedgerIntegrity
}

export async function portfolioView(cfg: Config): Promise<PortfolioView> {
  // The ledger is read with a corrupt-line counter up front — readPositions
  // folds silently, and a silently-skipped line makes every number below a lie.
  let corruptLines = 0
  readLedger(cfg, { onCorrupt: (n) => (corruptLines = n) })
  const book = readPositions(cfg)
  const marks = await Promise.all(book.positions.map((p) => getUsdPrice(p.symbol)))
  const positions: ViewPosition[] = book.positions.map((p, i) => {
    const mark = marks[i]?.usd ?? null
    return {
      symbol: p.symbol,
      tokenAddress: p.tokenAddress,
      qty: p.qty,
      avgEntryUsd: p.avgEntryUsd,
      costBasisUsd: p.costBasisUsd,
      markUsd: mark,
      valueUsd: mark === null ? null : Math.round(p.qty * mark * 100) / 100,
      unrealizedPnlUsd: mark === null ? null : Math.round((p.qty * mark - p.costBasisUsd) * 100) / 100,
    }
  })

  const ledger = readLedger(cfg)
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }) // en-CA → YYYY-MM-DD
  const today = dayFmt.format(new Date())
  const open = new Map<string, { qty: number; cost: number }>()
  let realized = 0
  let realizedAtDayStart = 0
  let sawToday = false
  let orphanCloses = 0
  let clampedCloses = 0
  const pnlHistory: PnlPoint[] = []
  for (const e of ledger) {
    const key = ledgerAssetKey(e)
    if (!key) continue
    if (e.type === 'open' && e.qty && e.entryUsd) {
      const cur = open.get(key) ?? { qty: 0, cost: 0 }
      cur.qty += e.qty
      cur.cost += e.qty * e.entryUsd
      open.set(key, cur)
    } else if (e.type === 'close' && e.qty && e.exitUsd) {
      const cur = open.get(key)
      if (!cur) {
        // A close of something never opened — the ledger disagrees with itself.
        orphanCloses++
        continue
      }
      if (e.qty > cur.qty + 1e-9) {
        // Closing more than we hold: excess is clamped below, so PnL is understated.
        clampedCloses++
      }
      const qty = Math.min(e.qty, cur.qty)
      const avg = cur.cost / cur.qty
      realized += qty * (e.exitUsd - avg) - (e.feesUsd ?? 0)
      cur.qty -= qty
      cur.cost -= qty * avg
      if (cur.qty <= 1e-12) open.delete(key)
      const closeDay = dayFmt.format(new Date(e.ts))
      if (!sawToday && closeDay === today) {
        sawToday = true
        realizedAtDayStart = realized - (qty * (e.exitUsd - avg) - (e.feesUsd ?? 0))
      }
      pnlHistory.push({ day: closeDay, realizedUsd: Math.round(realized * 100) / 100 })
    }
  }

  // Collapse to one point per day (the LAST close of each day carries the total).
  const byDay = new Map<string, number>()
  for (const p of pnlHistory) byDay.set(p.day, p.realizedUsd)
  const pnlDaily: PnlPoint[] = [...byDay.entries()].map(([day, realizedUsd]) => ({ day, realizedUsd }))

  const opens = ledger.filter((e) => e.type === 'open')
  const openSizes = opens.map((e) => (e.qty ?? 0) * (e.entryUsd ?? 0))
  const exec: ExecSummary = {
    opens: opens.length,
    closes: ledger.filter((e) => e.type === 'close').length,
    liveOpens: opens.filter((e) => !e.dryRun).length,
    avgOpenUsd: openSizes.length ? Math.round((openSizes.reduce((a, b) => a + b, 0) / openSizes.length) * 100) / 100 : null,
    largestOpenUsd: openSizes.length ? Math.round(Math.max(...openSizes) * 100) / 100 : null,
  }

  const unrealizedValues = positions.map((p) => p.unrealizedPnlUsd)
  const unrealizedPnlUsd =
    positions.length === 0
      ? 0
      : unrealizedValues.some((v) => v === null)
        ? null
        : Math.round((unrealizedValues as number[]).reduce((a, b) => a + b, 0) * 100) / 100

  const integrity: LedgerIntegrity = {
    ok: corruptLines === 0 && orphanCloses === 0 && clampedCloses === 0,
    corruptLines,
    orphanCloses,
    clampedCloses,
  }
  if (!integrity.ok) {
    log.warn(
      `[portfolioView] LEDGER INTEGRITY: ${corruptLines} corrupt line(s), ${orphanCloses} orphan close(s), ` +
        `${clampedCloses} over-close(s) — the numbers below may be wrong and the brief/dashboard will say so`,
    )
  }

  return {
    positions,
    realizedPnlUsd: Math.round(realized * 100) / 100,
    realizedTodayUsd: sawToday ? Math.round((realized - realizedAtDayStart) * 100) / 100 : 0,
    dailySpendUsd: Math.round(book.dailySpendUsd * 100) / 100,
    unrealizedPnlUsd,
    pnlDaily,
    exec,
    integrity,
  }
}
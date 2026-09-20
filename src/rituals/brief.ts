import type { Config } from '../config.js'
import { portfolioView } from '../store/portfolioView.js'
import { fetchFearGreed } from '../market/sentiment.js'
import { fetchNews, type NewsItem } from '../market/news.js'
import { forecastAccuracy } from '../market/forecastGrader.js'
import { log } from '../log.js'

/**
 * Morning brief (Phase 10.1) — the desk talks FIRST. A deterministic,
 * code-composed digest sent to the admin chat every morning: no LLM in the
 * loop (cheap, reliable, never hallucinates your PnL). Sections degrade
 * gracefully — a dead feed removes its line, it never blocks the brief.
 */

export type BriefDeps = {
  portfolio?: () => ReturnType<typeof portfolioView>
  fearGreed?: typeof fetchFearGreed
  news?: typeof fetchNews
  forecasts?: (cfg: Config) => ReturnType<typeof forecastAccuracy> | Promise<ReturnType<typeof forecastAccuracy>>
}

export type BriefData = {
  day: string
  portfolio: Awaited<ReturnType<typeof portfolioView>> | undefined
  dailyMaxUsd: number
  fng: Awaited<ReturnType<typeof fetchFearGreed>> | undefined
  news: NewsItem[]
  forecasts: Awaited<ReturnType<typeof forecastAccuracy>> | undefined
}

export async function gatherBriefData(cfg: Config, deps: BriefDeps = {}): Promise<BriefData> {
  const safe = async <T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (err) {
      log.debug(`brief: ${label} unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }
  const portfolio = await safe('portfolio', deps.portfolio ?? (() => portfolioView(cfg)))
  const fng = await safe('fear&greed', deps.fearGreed ?? fetchFearGreed)
  const news = await safe('news', deps.news ?? (() => fetchNews(6)))
  const forecasts = await safe('forecast accuracy', () => (deps.forecasts ?? forecastAccuracy)(cfg))

  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, weekday: 'long', day: 'numeric', month: 'long' })
  return {
    day: dayFmt.format(new Date()),
    portfolio,
    dailyMaxUsd: cfg.limits.dailyUsdMax,
    fng,
    news: news ?? [],
    forecasts,
  }
}

export function formatBrief(d: BriefData): string {
  const lines: string[] = []
  lines.push(`☀️ MORNING BRIEF — ${d.day}`, '')

  // Positions + PnL
  const p = d.portfolio
  if (p) {
    const posLines = p.positions.map((pos) => {
      const pnl =
        pos.unrealizedPnlUsd === null
          ? `${pos.symbol}: mark unavailable`
          : `${pos.symbol}: ${pos.unrealizedPnlUsd >= 0 ? '+' : ''}$${pos.unrealizedPnlUsd.toFixed(2)} unrealized @ $${pos.markUsd}`
      return `  ${pnl}`
    })
    const realizedToday =
      p.realizedTodayUsd !== 0 ? ` · today ${p.realizedTodayUsd >= 0 ? '+' : ''}$${p.realizedTodayUsd.toFixed(2)}` : ''
    const unreal =
      p.unrealizedPnlUsd === null ? '' : ` · unrealized ${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)}`
    lines.push(
      `💼 ${p.positions.length} open position(s) · realized ${p.realizedPnlUsd >= 0 ? '+' : ''}$${p.realizedPnlUsd.toFixed(2)} all-time${realizedToday}${unreal}`,
      `   day cap $${p.dailySpendUsd.toFixed(2)} / $${d.dailyMaxUsd}`,
      ...posLines,
    )
    // Fail-closed PnL (Nautilus steal): the brief never presents ledger numbers
    // as trustworthy while the ledger has holes it silently skipped.
    if (!p.integrity.ok) {
      const holes: string[] = []
      if (p.integrity.corruptLines > 0) holes.push(`${p.integrity.corruptLines} unreadable ledger line(s)`)
      if (p.integrity.orphanCloses > 0) holes.push(`${p.integrity.orphanCloses} close(s) of never-opened positions`)
      if (p.integrity.clampedCloses > 0) holes.push(`${p.integrity.clampedCloses} close(s) larger than the held position`)
      lines.push(`   ⚠️ LEDGER INTEGRITY: ${holes.join(', ')} — PnL above may be wrong.`, '')
    } else {
      lines.push('')
    }
  } else {
    lines.push('💼 portfolio snapshot unavailable right now', '')
  }

  // Mood
  if (d.fng) {
    const trend = d.fng.weekAvg !== null ? ` (7d avg ${d.fng.weekAvg})` : ''
    let note = ''
    if (d.fng.value <= 25) note = ' — extreme fear zone, historically where opportunity knocks'
    else if (d.fng.value >= 75) note = ' — extreme greed zone, historically where discipline pays'
    lines.push(`😱 Fear & Greed ${d.fng.value}/100 (${d.fng.classification})${trend}${note}`, '')
  }

  // News
  if (d.news.length > 0) {
    lines.push('📰 Headlines')
    for (const n of d.news.slice(0, 3)) lines.push(`  • ${n.title} (${n.source})`)
    lines.push('')
  }

  // Kronos honesty
  const f = d.forecasts
  if (f && f.graded > 0) {
    lines.push(
      `🔮 Kronos forecast record: ${f.inBand}/${f.graded} landed inside its published band` +
        (f.directionGraded > 0 ? `, direction ${f.hits}/${f.directionGraded}` : ''),
    )
  } else {
    lines.push('🔮 Kronos: no forecasts graded yet — the record starts building from today')
  }

  return lines.join('\n').trimEnd()
}

export async function composeMorningBrief(cfg: Config, deps: BriefDeps = {}): Promise<string> {
  return formatBrief(await gatherBriefData(cfg, deps))
}
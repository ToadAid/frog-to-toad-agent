import { fetchJson } from '../http.js'
import { log } from '../log.js'

/**
 * Market news — RSS/Atom provider chain, no keys, no JSON APIs (CoinGecko news
 * is PRO-only; CryptoPanic needs auth). Probed live 2026-09-02: Cointelegraph,
 * Decrypt, CoinDesk and The Block all serve RSS 2.0; Blockworks serves Atom.
 *
 * Follows the feed-chain incident rules: retries: 0 (the chain IS the retry)
 * and the shared circuit breaker (src/market/feeds.ts) so a dead outlet is
 * skipped for the cooldown instead of stalling every news call.
 */

export type NewsItem = {
  title: string
  link: string
  source: string
  publishedAt: number | undefined
  summary?: string
}

export type NewsProvider = {
  name: string
  url: string
  /** RSS 2.0 (<item>) or Atom (<entry>). */
  format: 'rss' | 'atom'
}

export const NEWS_PROVIDERS: NewsProvider[] = [
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', format: 'rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', format: 'rss' },
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', format: 'rss' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml', format: 'rss' },
  // Blockworks serves Atom and parses fine, but its feed was serving January-dated
  // entries in September — every item fails the freshness filter. Re-add if they fix it.
]

// ── Minimal RSS/Atom parsing (no XML dependency — hand-rolled like config) ──

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Strip tags + collapse whitespace → readable one-line summary. */
function textOf(block: string): string {
  return decodeEntities(
    block
      .replace(/<\!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim()
}

function firstTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m?.[1]
}

export function parseFeed(
  xml: string,
  source: string,
  format: 'rss' | 'atom',
): NewsItem[] {
  const items =
    format === 'rss'
      ? [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1] ?? '')
      : [...xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1] ?? '')
  const out: NewsItem[] = []
  for (const item of items) {
    const title = textOf(firstTag(item, 'title') ?? '')
    const linkBlock =
      format === 'rss'
        ? (firstTag(item, 'link') ?? '')
        : (firstTag(item, 'link') ?? item.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '')
    // RSS link bodies are plain text; Atom link tags carry href= (no body).
    const hrefMatch = linkBlock.match(/href="([^"]+)"/i)?.[1]
    const link = (hrefMatch ?? textOf(linkBlock) ?? '').trim()
    const dateRaw = textOf(firstTag(item, 'pubDate') ?? firstTag(item, 'updated') ?? firstTag(item, 'published') ?? '')
    const publishedAt = dateRaw ? Date.parse(dateRaw) || undefined : undefined
    const summary = textOf(
      firstTag(item, 'description') ?? firstTag(item, 'summary') ?? firstTag(item, 'content:encoded') ?? '',
    )
    if (!title) continue
    out.push({
      title,
      link: link || source,
      source,
      publishedAt,
      summary: summary === title ? undefined : summary.slice(0, 300) || undefined,
    })
  }
  return out
}

// ── Provider chain (breaker-shared with the price feeds) ─────────────────────

/** Reuse the price-feed breaker: same cooldown, same reset seam. */
import { feedBreakerOnCooldown, tripFeedBreaker } from './feeds.js'

type FetchTextLike = (url: string) => Promise<string>

async function fetchTextDefault(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (frog-to-toad-agent news)' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

let fetchText: FetchTextLike = fetchTextDefault

/** Test seam — swap the raw text fetcher for a scripted fake. */
export function setNewsFetcher(fn: FetchTextLike | undefined): void {
  fetchText = fn ?? fetchTextDefault
}

/** A source older than this isn't "news" anymore (default 48h; test seam below). */
let maxAgeMs = 48 * 3_600_000

export function setNewsMaxAge(ms: number): void {
  maxAgeMs = ms
}

/**
 * Fetch headlines from every healthy outlet. Sources that fail or go stale
 * trip the shared breaker and are skipped on the next walk. Dedupes by
 * title (case/whitespace-insensitive — outlets cross-post), newest first.
 */
export async function fetchNews(maxPerSource = 12): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    NEWS_PROVIDERS.map(async (p) => {
      if (feedBreakerOnCooldown(`news:${p.name}`)) {
        throw new Error(`${p.name}: on cooldown`)
      }
      const xml = await fetchText(p.url)
      const items = parseFeed(xml, p.name, p.format)
      if (items.length === 0) throw new Error(`${p.name}: no items parsed`)
      return { p, items }
    }),
  )
  const seen = new Set<string>()
  const out: NewsItem[] = []
  const cutoff = Date.now() - maxAgeMs
  for (const r of results) {
    if (r.status === 'rejected') {
      const p = NEWS_PROVIDERS[results.indexOf(r)]
      if (p) tripFeedBreaker(`news:${p.name}`)
      log.debug(`news: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
      continue
    }
    for (const item of r.value.items.slice(0, maxPerSource)) {
      // Freshness: stale feeds don't get to look like news. An outlet with a
      // completely undateable feed still passes (dates optional in RSS).
      if (item.publishedAt !== undefined && item.publishedAt < cutoff) continue
      const key = item.title.toLowerCase().replace(/\s+/g, ' ').trim()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  out.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  return out
}

/** Case-insensitive symbol/keyword match on title + summary. */
export function isRelevant(item: NewsItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = `${item.title} ${item.summary ?? ''}`.toLowerCase()
  return hay.includes(q)
}

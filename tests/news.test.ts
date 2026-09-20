import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  parseFeed,
  fetchNews,
  isRelevant,
  setNewsFetcher,
  setNewsMaxAge,
  NEWS_PROVIDERS,
  type NewsProvider,
} from '../src/market/news.js'
import { resetFeedBreakers } from '../src/market/feeds.js'
import { marketNewsTool } from '../src/tools/news.js'

const RFC = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toUTCString()

const freshRss = () => `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title><![CDATA[Bitcoin ETF sees record inflows]]></title><link>https://example.com/a</link><pubDate>${RFC(1.5)}</pubDate><description><![CDATA[&amp; the &lt;flow&gt; was big. <b>bold</b> gone]]></description></item>
<item><title>Plain title item</title><link>https://example.com/b</link><pubDate>${RFC(2)}</pubDate></item>
<item><title>Stale headline from last week</title><link>https://example.com/c</link><pubDate>${RFC(72)}</pubDate></item>
</channel></rss>`

const freshAtom = () => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Ether futures open interest jumps</title><link href="https://example.com/x"/><updated>${RFC(2.5)}</updated><summary>Solana named too</summary></entry>
</feed>`

const RSS = freshRss()
const ATOM = freshAtom()

beforeEach(() => {
  resetFeedBreakers()
})

afterAll(() => {
  setNewsFetcher(undefined)
})

describe('parseFeed', () => {
  it('parses RSS items with CDATA, entities and dates', () => {
    const items = parseFeed(RSS, 'Test', 'rss')
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      title: 'Bitcoin ETF sees record inflows',
      link: 'https://example.com/a',
      source: 'Test',
    })
    expect(items[0]?.publishedAt).toBe(Date.parse(RSS.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ?? ''))
    expect(items[0]?.summary).toContain('the <flow> was big')
    expect(items[0]?.summary).not.toContain('<b>')
  })

  it('parses Atom entries with href links and updated dates', () => {
    const items = parseFeed(ATOM, 'Blockworks', 'atom')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: 'Ether futures open interest jumps', link: 'https://example.com/x' })
    expect(Number.isFinite(items[0]?.publishedAt)).toBe(true)
  })
})

describe('fetchNews', () => {
  it('walks the chain, dedupes cross-posted titles, newest first', async () => {
    // Blockworks slot was dropped (stale upstream feed) — borrow its position
    // to prove Atom sources flow through the same chain.
    const atomProvider: NewsProvider = { name: 'Blockworks', url: 'https://blockworks.com/feed', format: 'atom' }
    NEWS_PROVIDERS.push(atomProvider)
    try {
      setNewsFetcher(async (url) => {
        if (url === NEWS_PROVIDERS[0]!.url) return RSS
        if (url === NEWS_PROVIDERS[1]!.url) return RSS // same titles → dedupe
        if (url === atomProvider.url) return ATOM
        throw new Error('HTTP 503')
      })
      const items = await fetchNews()
      const titles = items.map((i) => i.title)
      // Cross-posted RSS items appear once; stale item filtered; atom item present.
      expect(titles.filter((t) => t === 'Bitcoin ETF sees record inflows')).toHaveLength(1)
      expect(titles).not.toContain('Stale headline from last week')
      expect(titles).toContain('Ether futures open interest jumps')
      // Newest first: ETF (1.5h) before plain (2h) before ether (2.5h)
      expect(items[0]?.title).toBe('Bitcoin ETF sees record inflows')
      expect(items.at(-1)?.title).toBe('Ether futures open interest jumps')
    } finally {
      NEWS_PROVIDERS.pop()
    }
  })

  it('stale outlets trip the shared breaker and are skipped on the next walk', async () => {
    let deadCalls = 0
    setNewsFetcher(async (url) => {
      if (url === NEWS_PROVIDERS[2]!.url) {
        deadCalls++
        throw new Error('HTTP 500')
      }
      return RSS
    })
    await fetchNews()
    await fetchNews()
    // CoinDesk failed on walk 1, was on cooldown for walk 2 → fetched once.
    expect(deadCalls).toBe(1)
  })

  it('respects a custom max-age window (freshness seam)', async () => {
    setNewsMaxAge(3 * 3_600_000) // 3h — the 2h-old item passes, the 72h one stays out
    setNewsFetcher(async () => RSS)
    const items = await fetchNews()
    expect(items.map((i) => i.title)).toContain('Plain title item')
    setNewsMaxAge(48 * 3_600_000)
  })
})

describe('isRelevant', () => {
  const item = { title: 'Ethereum ETF approved', link: 'x', source: 's', publishedAt: Date.now(), summary: 'Solana also mentioned' }
  it('matches title and summary case-insensitively', () => {
    expect(isRelevant(item, 'ethereum')).toBe(true)
    expect(isRelevant(item, 'SOLANA')).toBe(true)
    expect(isRelevant(item, 'cardano')).toBe(false)
    expect(isRelevant(item, '')).toBe(true)
  })
})

describe('market_news tool', () => {
  it('formats headlines with source, age and links', async () => {
    setNewsFetcher(async () => RSS)
    const res = await marketNewsTool.execute({}, toolCtx())
    expect(res.text).toContain('📰 MARKET NEWS')
    expect(res.text).toMatch(/Bitcoin ETF sees record inflows — Cointelegraph · \d+[mhd] ago/)
    expect(res.text).toContain('https://example.com/a')
    expect(res.text).toContain('Catalyst context, not advice')
  })

  it('filters by keyword and says so', async () => {
    setNewsFetcher(async () => RSS)
    const res = await marketNewsTool.execute({ query: 'etf' }, toolCtx())
    expect(res.text).toContain('Bitcoin ETF sees record inflows')
    expect(res.text).not.toContain('Plain title item')
    expect(res.text).toMatch(/\(1\/\d+ headlines match "etf"\)/)
  })

  it('reports misses as a search hint, not an error', async () => {
    setNewsFetcher(async () => RSS)
    const res = await marketNewsTool.execute({ query: 'cardano' }, toolCtx())
    expect(res.text).toContain('no headlines in the last 48h mention')
  })
})

function toolCtx() {
  // news tool never touches ctx — narrow cast keeps the call site honest.
  return undefined as unknown as Parameters<typeof marketNewsTool.execute>[1]
}
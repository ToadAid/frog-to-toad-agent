import { z } from 'zod'
import { defineTool } from './registry.js'
import { fetchNews, isRelevant, type NewsItem } from '../market/news.js'

/**
 * market_news — latest crypto headlines from no-key RSS/Atom outlets
 * (Cointelegraph, Decrypt, CoinDesk, The Block, Blockworks). Readonly signal:
 * news is CATALYST context, never a standalone trade trigger.
 */

function ago(publishedAt: number | undefined): string {
  if (publishedAt === undefined || !Number.isFinite(publishedAt)) return 'time unknown'
  const mins = Math.round((Date.now() - publishedAt) / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export const marketNewsTool = defineTool({
  name: 'market_news',
  description:
    'Latest crypto market headlines (Cointelegraph, Decrypt, CoinDesk, The Block, Blockworks — no keys). ' +
    'Optionally filter by a symbol or keyword (e.g. "ETH", "ETF", "regulation"). News is CATALYST context: ' +
    'read it BEFORE sizing a trade, especially for events (listings, hacks, ETF flows, regulatory moves) ' +
    'that technicals cannot see. Pair with market_sentiment and technicals — never trade on a headline alone.',
  danger: 'readonly',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('optional symbol or keyword filter, e.g. "BTC", "ETF", "solana"'),
    limit: z.number().int().min(1).max(20).optional().describe('max headlines to return (default 8)'),
  }),
  execute: async (input) => {
    const items = await fetchNews()
    const relevant = items.filter((i: NewsItem) => isRelevant(i, input.query ?? ''))
    if (relevant.length === 0) {
      return {
        text: input.query
          ? `no headlines in the last 48h mention "${input.query}" — try a broader keyword (ticker, category like "ETF", "hack", "listing")`
          : 'no fresh headlines right now (all outlets empty or on cooldown — try again shortly)',
      }
    }
    const take = relevant.slice(0, input.limit ?? 8)
    const lines = take.map((i) => {
      const summary = i.summary && i.summary !== i.title ? `\n    ${i.summary}` : ''
      return `• ${i.title} — ${i.source} · ${ago(i.publishedAt)}\n    ${i.link}${summary}`
    })
    const filteredNote =
      input.query && items.length > relevant.length
        ? ` (${relevant.length}/${items.length} headlines match "${input.query}")`
        : ''
    return {
      text: [
        `📰 MARKET NEWS${filteredNote}`,
        '',
        ...lines,
        '',
        `Catalyst context, not advice: one headline is noise — check for corroboration across sources, ` +
          `and remember the feed is 48h-max by design. The call is yours.`,
      ].join('\n'),
    }
  },
})
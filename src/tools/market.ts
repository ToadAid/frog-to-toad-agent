import { z } from 'zod'
import { defineTool } from './registry.js'
import { fetchJson } from '../http.js'
import { searchTokenPairs, bestPairByAddress, isContractAddress, shortAddress } from './tokens.js'
import { getUsdPrice, fmtUsd } from '../market/feeds.js'

/**
 * Read-only market data tools. Public APIs, no keys.
 *  - CoinGecko simple price + search
 *  - DexScreener token/pool data (pairs, liquidity, volume)
 */

// ── market_price ─────────────────────────────────────────────────────────────

export const marketPriceTool = defineTool({
  name: 'market_price',
  description:
    'Get current USD prices and 24h change for one or more coins (by symbol or coingecko id). ' +
    'Symbols use the redundant feed chain (CoinGecko → Binance → Coinbase). ' +
    'Example: {"symbols": "btc,eth,sol"}.',
  danger: 'readonly',
  input: z.object({
    ids: z.string().optional().describe('comma-separated coingecko ids, e.g. "bitcoin,ethereum" (CoinGecko only)'),
    symbols: z.string().optional().describe('comma-separated symbols, e.g. "btc,eth"'),
  }),
  execute: async (input) => {
    if (!input.ids && !input.symbols) {
      return { text: '[error] provide ids or symbols' }
    }

    if (input.symbols) {
      const quotes = (await Promise.all(input.symbols.split(',').map((s) => getUsdPrice(s.trim())))).filter(
        (q): q is NonNullable<typeof q> => q !== undefined,
      )
      const lines = quotes.map((q) => {
        const arrow = q.change24hPct === undefined ? '' : q.change24hPct >= 0 ? ' 🟢' : ' 🔴'
        const pct =
          q.change24hPct !== undefined ? ` (${q.change24hPct >= 0 ? '+' : ''}${q.change24hPct.toFixed(2)}% 24h)` : ''
        return `${q.symbol}: $${fmtUsd(q.usd)}${pct}${arrow}`
      })
      return { text: lines.length > 0 ? lines.join('\n') : 'no results — check the symbols' }
    }

    type PriceRow = Record<string, { usd?: number; usd_24h_change?: number }>
    const params = new URLSearchParams({ vs_currencies: 'usd', include_24hr_change: 'true' })
    params.set('ids', input.ids!)
    const data = await fetchJson<PriceRow>(
      `https://api.coingecko.com/api/v3/simple/price?${params.toString()}`,
    )
    const lines = Object.entries(data).map(([id, row]) => {
      const change = row.usd_24h_change
      const arrow = change === undefined ? '' : change >= 0 ? ' 🟢' : ' 🔴'
      const price = row.usd !== undefined ? `$${row.usd.toLocaleString()}` : '?'
      const pct = change !== undefined ? ` (${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h)` : ''
      return `${id}: ${price}${pct}${arrow}`
    })
    return { text: lines.length > 0 ? lines.join('\n') : 'no results — check the id/symbol' }
  },
})

// ── market_trending ──────────────────────────────────────────────────────────

type TrendingResponse = {
  coins: Array<{ item: { id: string; name: string; symbol: string; market_cap_rank?: number; data?: { price_change_percentage_24h?: { usd?: number } } } }>
}

export const marketTrendingTool = defineTool({
  name: 'market_trending',
  description: 'Currently trending coins on CoinGecko (community attention proxy).',
  danger: 'readonly',
  input: z.object({}),
  execute: async () => {
    const data = await fetchJson<TrendingResponse>('https://api.coingecko.com/api/v3/search/trending')
    const lines = data.coins.slice(0, 10).map((c, i) => {
      const change = c.item.data?.price_change_percentage_24h?.usd
      const pct = change !== undefined ? ` (${change >= 0 ? '+' : ''}${change.toFixed(1)}% 24h)` : ''
      return `${i + 1}. ${c.item.name} (${c.item.symbol})${pct}`
    })
    return { text: `Trending on CoinGecko:\n${lines.join('\n')}` }
  },
})

// ── market_sentiment ─────────────────────────────────────────────────────────

type FngResponse = {
  data?: Array<{ value?: string; value_classification?: string; timestamp?: string }>
}

export const marketSentimentTool = defineTool({
  name: 'market_sentiment',
  description:
    'Crypto Fear & Greed Index (alternative.me, 0=extreme fear, 100=extreme greed): today plus the ' +
    '7-day and 30-day trend. Use it as a MARKET MOOD context read — contrarian at the extremes — ' +
    'alongside technicals and research, never as a standalone signal.',
  danger: 'readonly',
  input: z.object({}),
  execute: async () => {
    const data = await fetchJson<FngResponse>('https://api.alternative.me/fng/?limit=30')
    const rows = data.data ?? []
    if (rows.length === 0) return { text: '[error] Fear & Greed feed returned nothing' }
    const value = (r: (typeof rows)[0]) => Number(r.value)
    const today = rows[0]!
    const week = rows.slice(0, 7).map(value).filter(Number.isFinite)
    const month = rows.slice(0, 30).map(value).filter(Number.isFinite)
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)
    const yesterday = rows[1] ? value(rows[1]) : null

    const notes: string[] = []
    const v = value(today)
    if (Number.isFinite(v)) {
      if (v <= 25) notes.push('EXTREME FEAR — historically a contrarian accumulation zone; fear is loudest near bottoms')
      else if (v >= 75) notes.push('EXTREME GREED — historically a contrarian caution zone; euphoria clusters near tops')
      else if (yesterday !== null && Number.isFinite(yesterday)) {
        const d = v - yesterday
        if (d >= 10) notes.push(`mood swinging fast: +${d} in a day — whippy conditions`)
        else if (d <= -10) notes.push(`mood swinging fast: ${d} in a day — whippy conditions`)
      }
      if (avg(month) !== null && Math.abs((avg(month) ?? 0) - v) <= 5) {
        notes.push(`mood stuck near its 30d average (${avg(month)}) — regime, not an event`)
      }
    }

    return {
      text: [
        `😱 CRYPTO FEAR & GREED — ${v} / 100 (${today.value_classification ?? '?'})`,
        `7d avg ${avg(week) ?? '?'} · 30d avg ${avg(month) ?? '?'}` +
          (yesterday !== null && Number.isFinite(yesterday) ? ` · yesterday ${yesterday}` : ''),
        '',
        ...notes.map((n) => `• ${n}`),
        '',
        `Readings, not advice: extremes are historically contrarian, mid-range mood is noise.` +
          ` Weigh this WITH technicals and research — the call is yours.`,
      ].join('\n'),
    }
  },
})

// ── market_token_search ──────────────────────────────────────────────────────

export const marketTokenSearchTool = defineTool({
  name: 'market_token_search',
  description:
    'Resolve a token identity in EITHER direction: ticker → contract address(es), or contract ' +
    'address → ticker (exact). A ticker can map to many contracts — always show the human the ' +
    'addresses before trading. Returns price, liquidity, volume, age per pair.',
  danger: 'readonly',
  input: z.object({
    query: z.string().describe('token symbol (e.g. "MOG"), token name, or contract address (0x…)'),
  }),
  execute: async (input) => {
    // Address → EXACT identity (the tokens endpoint is authoritative; the fuzzy
    // search endpoint would return ambiguous lookalikes).
    if (isContractAddress(input.query)) {
      const p = await bestPairByAddress(input.query)
      if (!p) return { text: `no liquid DexScreener pair found for contract ${input.query}` }
      const ageDays = p.pairCreatedAt ? Math.floor((Date.now() - p.pairCreatedAt) / 86_400_000) : null
      return {
        text: [
          `IDENTITY (resolved from contract ${shortAddress(input.query.trim())} — exact):`,
          `  ${p.baseToken.symbol} — ${p.baseToken.name} (${p.chainId}/${p.dexId})`,
          `  price $${p.priceUsd ?? '?'} · liquidity $${Math.round(p.liquidity?.usd ?? 0).toLocaleString()} · vol24h $${Math.round(p.volume?.h24 ?? 0).toLocaleString()}`,
          `  fdv $${p.fdv !== undefined ? Math.round(p.fdv).toLocaleString() : '?'}${ageDays !== null ? ` · pair age ${ageDays}d` : ''}`,
          `  ${p.url}`,
        ].join('\n'),
      }
    }
    const top = await searchTokenPairs(input.query, 5)
    if (top.length === 0) return { text: `no DexScreener pairs found for '${input.query}'` }
    const lines = top.map((p, i) => {
      const ageDays = p.pairCreatedAt ? Math.floor((Date.now() - p.pairCreatedAt) / 86_400_000) : null
      return [
        `${i + 1}. ${p.baseToken.symbol} — ${p.baseToken.name} (${p.chainId}/${p.dexId}): $${p.priceUsd ?? '?'}`,
        `   contract: ${p.baseToken.address}`,
        `   liquidity $${Math.round(p.liquidity?.usd ?? 0).toLocaleString()} · vol24h $${Math.round(p.volume?.h24 ?? 0).toLocaleString()} · 24h ${p.priceChange?.h24?.toFixed(1) ?? '?'}%`,
        `   fdv $${p.fdv !== undefined ? Math.round(p.fdv).toLocaleString() : '?'}${ageDays !== null ? ` · pair age ${ageDays}d` : ''}`,
        `   ${p.url}`,
      ].join('\n')
    })
    return {
      text:
        `${lines.join('\n\n')}\n\n` +
        `⚠️ A ticker can map to many contracts. Confirm the EXACT contract address with the human before quoting or trading.`,
    }
  },
})
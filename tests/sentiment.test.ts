import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marketSentimentTool } from '../src/tools/market.js'

const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  sleep: async () => {},
}))

/** alternative.me rows are NEWEST first: 30 days, walking from `start` downward. */
function fngFeed(values: number[]): unknown {
  return {
    name: 'Fear and Greed Index',
    data: values.map((v, i) => ({
      value: String(v),
      value_classification: v >= 75 ? 'Extreme Greed' : v >= 55 ? 'Greed' : v >= 45 ? 'Neutral' : v >= 26 ? 'Fear' : 'Extreme Fear',
      timestamp: String(1_700_000_000 - i * 86_400),
    })),
  }
}

describe('market_sentiment — mood is a reading, not an order', () => {
  beforeEach(() => fetchJsonMock.mockReset())

  it('renders today, 7d/30d averages and yesterday', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {} // vitest's hook re-touches the mock — ignore
      if (url.includes('alternative.me')) return fngFeed(Array.from({ length: 30 }, (_, i) => 50 + (i % 5)))
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketSentimentTool.execute({}, null as never)
    expect(r.text).toContain('/ 100')
    expect(r.text).toContain('7d avg')
    expect(r.text).toContain('30d avg')
    expect(r.text).toContain('yesterday')
  })

  it('flags extreme fear as a contrarian zone', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      if (url.includes('alternative.me')) return fngFeed([18, ...Array.from({ length: 29 }, () => 40)])
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketSentimentTool.execute({}, null as never)
    expect(r.text).toContain('EXTREME FEAR')
    expect(r.text).toContain('contrarian')
    // never tells the agent what to do
    expect(r.text).not.toContain('BUY')
    expect(r.text).not.toContain('SELL')
  })

  it('flags extreme greed', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      if (url.includes('alternative.me')) return fngFeed([90, ...Array.from({ length: 29 }, () => 70)])
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketSentimentTool.execute({}, null as never)
    expect(r.text).toContain('EXTREME GREED')
    expect(r.text).toContain('contrarian')
  })

  it('flags a fast one-day mood swing at mid-range', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      if (url.includes('alternative.me')) return fngFeed([60, 45, ...Array.from({ length: 28 }, () => 52)])
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketSentimentTool.execute({}, null as never)
    expect(r.text).toContain('swinging fast') // 60 vs 45 = +15 in a day
  })

  it('admits it when the feed is empty', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      if (url.includes('alternative.me')) return { data: [] }
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketSentimentTool.execute({}, null as never)
    expect(r.text).toContain('[error] Fear & Greed feed returned nothing')
  })
})
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getUsdPrice, clearPriceCache, resetFeedBreakers } from '../src/market/feeds.js'

// Mock the HTTP layer so the fallback chain is testable with no network.
const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  sleep: async () => {},
}))

function urlOf(call: number): string {
  const args = fetchJsonMock.mock.calls[call] ?? []
  return String(args[0])
}

describe('redundant price feed', () => {
  beforeEach(() => {
    clearPriceCache()
    resetFeedBreakers()
    fetchJsonMock.mockReset()
  })

  it('returns a coingecko quote when the first provider works', async () => {
    fetchJsonMock.mockResolvedValueOnce({ bitcoin: { usd: 1234.5, usd_24h_change: -1.2 } })
    const q = await getUsdPrice('btc')
    expect(q?.source).toBe('coingecko')
    expect(q?.usd).toBe(1234.5)
    expect(q?.change24hPct).toBe(-1.2)
    expect(urlOf(0)).toContain('coingecko')
  })

  it('falls through to coinbase when coingecko dies', async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error('HTTP 429 rate limited'))
    fetchJsonMock.mockResolvedValueOnce({ price: '77000.5' }) // coinbase ticker
    const q = await getUsdPrice('BTC')
    expect(q?.source).toBe('coinbase')
    expect(q?.usd).toBe(77000.5)
  })

  it('falls through to binance as the last resort', async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error('HTTP 503'))
    fetchJsonMock.mockRejectedValueOnce(new Error('HTTP 503')) // coinbase also down
    fetchJsonMock.mockResolvedValueOnce({ lastPrice: '77001.0', priceChangePercent: '-0.5' })
    const q = await getUsdPrice('BTC')
    expect(q?.source).toBe('binance')
    expect(q?.usd).toBe(77001.0)
    expect(q?.change24hPct).toBe(-0.5)
  })

  it('falls back to the Chainlink oracle when every web feed dies', async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error('down')) // coingecko
    fetchJsonMock.mockRejectedValueOnce(new Error('down')) // coinbase
    fetchJsonMock.mockRejectedValueOnce(new Error('down')) // binance
    const nowSec = BigInt(Math.floor(Date.now() / 1000) - 300)
    const w = (n: bigint) => n.toString(16).padStart(64, '0')
    const round = '0x' + w(1n) + w(5000000000000n) + w(0n) + w(nowSec) + w(1n) // 50_000.00 @ 8dp
    fetchJsonMock.mockImplementation(async (url: string, o?: { body?: { params?: [{ data?: string }] } }) => {
      if (url.includes('base.org') || url.includes('publicnode')) {
        const sel = o?.body?.params?.[0]?.data
        if (sel === '0xfeaf968c') return { result: round }
        if (sel === '0x313ce567') return { result: '0x' + '0'.repeat(63) + '8' }
      }
      throw new Error('down')
    })
    const q = await getUsdPrice('BTC')
    expect(q?.source).toBe('chainlink')
    expect(q?.usd).toBe(50000)
  })

  it('returns undefined when every provider fails', async () => {
    fetchJsonMock.mockRejectedValue(new Error('down'))
    const q = await getUsdPrice('BTC')
    expect(q).toBeUndefined()
    expect(fetchJsonMock.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('serves repeat calls from the 30s cache without refetching', async () => {
    fetchJsonMock.mockResolvedValue({ bitcoin: { usd: 100 } })
    await getUsdPrice('BTC')
    await getUsdPrice('BTC')
    expect(fetchJsonMock.mock.calls.length).toBe(1)
  })

  it('never treats a sub-cent price as zero', async () => {
    fetchJsonMock.mockResolvedValueOnce({ pepe: { usd: 0.0000034, usd_24h_change: 3.09 } })
    const q = await getUsdPrice('PEPE')
    expect(q?.usd).toBeCloseTo(0.0000034, 10)
  })

  // ── 2026-09-02 feed incident ───────────────────────────────────────────────

  it('a 429 falls through instantly — no backoff retries inside the chain', async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error('HTTP 429 rate limited'))
    fetchJsonMock.mockResolvedValueOnce({ price: '77000.5' })
    await getUsdPrice('BTC')
    // coingecko attempted exactly ONCE (retries: 0 — the chain is the retry)
    const cgCalls = fetchJsonMock.mock.calls.filter((c) => String(c[0]).includes('coingecko'))
    expect(cgCalls.length).toBe(1)
    expect(cgCalls[0]![1]).toMatchObject({ retries: 0 })
  })

  it('circuit breaker: a failed provider is skipped for the cooldown window', async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error('HTTP 429 rate limited'))
    fetchJsonMock.mockResolvedValue({ price: '77000.5' }) // coinbase serves from now on
    await getUsdPrice('BTC')
    clearPriceCache()
    fetchJsonMock.mockClear()
    await getUsdPrice('BTC')
    // coingecko on cooldown — not re-attempted; coinbase answers again
    expect(fetchJsonMock.mock.calls.some((c) => String(c[0]).includes('coingecko'))).toBe(false)
    expect(fetchJsonMock.mock.calls.some((c) => String(c[0]).includes('coinbase'))).toBe(true)
  })

  it('binance.com answering 200 with an error body falls through to binance.us', async () => {
    // coingecko + coinbase down; binance.com answers "200" with the silent-block
    // body (no lastPrice → unusable → breaker trips) → binance.us serves.
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {} // phantom vitest hook
      if (String(url).includes('binance.com')) {
        return { code: 0, msg: 'Service unavailable from a restricted location' }
      }
      if (String(url).includes('binance.us')) {
        return { lastPrice: '77001.0', priceChangePercent: '-0.5' }
      }
      throw new Error('down')
    })
    const q = await getUsdPrice('BTC')
    expect(q?.source).toBe('binance')
    expect(q?.usd).toBe(77001.0)
    const binanceCalls = fetchJsonMock.mock.calls.filter((c) => String(c[0]).includes('binance'))
    expect(String(binanceCalls[0]![0])).toContain('binance.com')
    expect(String(binanceCalls[1]![0])).toContain('binance.us')
  })
})
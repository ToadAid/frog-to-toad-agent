import { describe, it, expect, vi, beforeEach } from 'vitest'
import { priceAtOnPool, priceForRecord } from '../src/market/priceHistory.js'
import type { ForecastRecord } from '../src/market/forecastGrader.js'

// Grading prices must come from the SAME feed the forecast was issued on:
// contract records → their own pool; ticker records → Coinbase → Binance.
const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))

const POOL = `0x${'cd'.repeat(20)}`

function rec(over: Partial<ForecastRecord> = {}): ForecastRecord {
  return {
    id: 'test-1',
    symbol: 'BTC',
    interval: 'hourly',
    issuedAt: Date.now(),
    issuedPrice: 100,
    horizonCandles: 12,
    candleMs: 3_600_000,
    bandLow: 98,
    bandHigh: 105,
    p50: 102,
    pUp: 0.6,
    movePct: 2,
    ...over,
  }
}

/** Newest-first GeckoTerminal ohlcv_list rows, hourly. */
function gtRows(closes: number[], endTsSec = Math.floor(Date.now() / 1000)): number[][] {
  return closes
    .map((c, i) => [endTsSec - (closes.length - 1 - i) * 3600, c * 0.999, c * 1.001, c * 0.998, c, 10])
    .reverse()
}

beforeEach(() => {
  fetchJsonMock.mockReset()
})

describe('priceAtOnPool — the pool is the price', () => {
  it('returns the close of the candle straddling ts', async () => {
    const t0 = Math.floor(Date.now() / 1000) - 3 * 3600
    fetchJsonMock.mockResolvedValue({ data: { attributes: { ohlcv_list: gtRows([10, 11, 12, 13], t0 + 3 * 3600) } } })
    await expect(priceAtOnPool('base', POOL, (t0 + 1.5 * 3600) * 1000, 'hourly')).resolves.toBe(11)
  })

  it('no candle covers ts → undefined (never guessed)', async () => {
    fetchJsonMock.mockResolvedValue({ data: { attributes: { ohlcv_list: gtRows([10, 11]) } } })
    const ancient = Math.floor(Date.now() / 1000) - 90 * 24 * 3600
    await expect(priceAtOnPool('base', POOL, ancient * 1000, 'hourly')).resolves.toBeUndefined()
  })
})

describe('priceForRecord — grading follows the record', () => {
  it('a contract record is priced from ITS pool only — no Coinbase/Binance lookup', async () => {
    const t0 = Math.floor(Date.now() / 1000) - 2 * 3600
    fetchJsonMock.mockResolvedValue({ data: { attributes: { ohlcv_list: gtRows([10, 11, 12], t0 + 2 * 3600) } } })
    const p = await priceForRecord(rec({ pairAddress: POOL, chainId: 'base' }), (t0 + 1.5 * 3600) * 1000)
    expect(p).toBe(11)
    // the ONLY fetch was the pool's OHLCV
    const urls = fetchJsonMock.mock.calls.map((c) => String(c[0]))
    expect(urls.length).toBe(1)
    expect(urls[0]).toContain('geckoterminal.com')
    expect(urls.some((u) => u.includes('coinbase') || u.includes('binance'))).toBe(false)
  })

  it('a ticker record uses Coinbase first (existing records keep grading)', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      const u = typeof url === 'string' ? url : ''
      if (u.includes('api.exchange.coinbase.com')) {
        const tSec = Math.floor(Date.now() / 1000) - 3600
        return [[tSec, 99, 101, 100, 100.5, 1], [tSec - 3600, 98, 100, 99, 99.5, 1]]
      }
      throw new Error(`unexpected url: ${u}`)
    })
    await expect(priceForRecord(rec(), Date.now())).resolves.toBe(100.5)
    const urls = fetchJsonMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('binance'))).toBe(false) // Binance never asked
  })

  it('Coinbase miss → Binance klines close at ts', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      const u = typeof url === 'string' ? url : ''
      if (u.includes('api.exchange.coinbase.com')) throw new Error('not a product')
      if (u.includes('binance.com')) {
        const openSec = Math.floor(Date.now() / 1000 / 3600) * 3600 // current hourly candle
        return [[openSec * 1000, 70, 78, 69, 77, 10]]
      }
      throw new Error(`unexpected url: ${u}`)
    })
    await expect(priceForRecord(rec(), Date.now())).resolves.toBe(77)
  })

  it('both feeds miss → undefined (awaitingPrice, retried tomorrow)', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      throw new Error('all feeds down')
    })
    await expect(priceForRecord(rec(), Date.now())).resolves.toBeUndefined()
  })
})
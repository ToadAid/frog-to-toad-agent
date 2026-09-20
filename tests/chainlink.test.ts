import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chainlinkPrice, chainlinkFeedAddress } from '../src/market/chainlink.js'

const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  sleep: async () => {},
}))

// latestRoundData() → (roundId, answer, startedAt, updatedAt, answeredInRound)
function roundData(answerBase: bigint, updatedAtSec: number): string {
  const w = (n: bigint) => n.toString(16).padStart(64, '0')
  return '0x' + w(123n) + w(answerBase) + w(0n) + w(BigInt(updatedAtSec)) + w(123n)
}

const FRESH = Math.floor(Date.now() / 1000) - 600 // 10 min old
const BTC_ANSWER = 7725534n * 10n ** 6n // 8 decimals → 77,255.34

function serve(opts?: { answer?: bigint; updatedAtSec?: number }): void {
  fetchJsonMock.mockImplementation(async (url?: string, o?: { body?: { params?: [{ data?: string }] } }) => {
    if (url === undefined) return {} // vitest's hook re-touches the mock — ignore
    if (url.includes('base.org') || url.includes('publicnode')) {
      const sel = o?.body?.params?.[0]?.data
      if (sel === '0xfeaf968c') return { result: roundData(opts?.answer ?? BTC_ANSWER, opts?.updatedAtSec ?? FRESH) }
      if (sel === '0x313ce567') return { result: '0x' + '0'.repeat(63) + '8' } // decimals() = 8
    }
    throw new Error(`unexpected url: ${url}`)
  })
}

describe('chainlink feed — the staple onchain oracle', () => {
  beforeEach(() => fetchJsonMock.mockReset())

  it('decodes latestRoundData into a USD quote', async () => {
    serve()
    const q = await chainlinkPrice('btc')
    expect(q?.source).toBe('chainlink')
    expect(q?.usd).toBe(77255.34)
    expect(q?.change24hPct).toBeUndefined() // oracles don't do 24h change — honest gap
  })

  it('refuses a stale feed instead of quoting a dead price', async () => {
    serve({ updatedAtSec: Math.floor(Date.now() / 1000) - 3 * 3600 }) // 3h old
    expect(await chainlinkPrice('BTC')).toBeUndefined()
  })

  it('refuses empty/zero answers (bad address, paused feed)', async () => {
    serve({ answer: 0n })
    expect(await chainlinkPrice('BTC')).toBeUndefined()
    fetchJsonMock.mockReset()
    fetchJsonMock.mockImplementation(async () => ({ result: '0x' }))
    expect(await chainlinkPrice('BTC')).toBeUndefined()
  })

  it('has nothing to say about non-majors (no feed, no call)', async () => {
    expect(await chainlinkPrice('PEPE')).toBeUndefined()
    expect(fetchJsonMock).not.toHaveBeenCalled()
  })

  it('exposes feed addresses for reporting', () => {
    expect(chainlinkFeedAddress('ETH')).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(chainlinkFeedAddress('MOG')).toBeUndefined()
  })
})
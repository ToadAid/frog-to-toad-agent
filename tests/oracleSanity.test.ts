import { describe, it, expect, vi, beforeEach } from 'vitest'
import { oracleSanityCheck } from '../src/market/oracleSanity.js'

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

const FRESH = Math.floor(Date.now() / 1000) - 600

function serveEth(answerBase: bigint, updatedAtSec: number = FRESH): void {
  fetchJsonMock.mockImplementation(async (url?: string, o?: { body?: { params?: [{ data?: string }] } }) => {
    if (url === undefined) return {} // vitest's hook re-touches the mock — ignore
    const sel = o?.body?.params?.[0]?.data
    if (sel === '0xfeaf968c') return { result: roundData(answerBase, updatedAtSec) }
    if (sel === '0x313ce567') return { result: '0x' + '0'.repeat(63) + '8' } // decimals() = 8
    throw new Error(`unexpected selector: ${sel}`)
  })
}

describe('oracle sanity — no trade when web and oracle disagree', () => {
  beforeEach(() => fetchJsonMock.mockReset())

  it('passes when the web price is within threshold of Chainlink', async () => {
    // Chainlink says 2000.00 (answer 2000e8 at 8 decimals); web says 2010 → 0.5% off.
    serveEth(2000n * 10n ** 8n)
    const r = await oracleSanityCheck('ETH', 2010, 2)
    expect(r.checked).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.divergencePct).toBeCloseTo(0.5, 5)
  })

  it('refuses a trade when divergence exceeds the threshold', async () => {
    serveEth(2000n * 10n ** 8n)
    const r = await oracleSanityCheck('ETH', 1900, 2) // 5% low — manipulated feed or bad source
    expect(r.ok).toBe(false)
    expect(r.divergencePct).toBeCloseTo(5, 5)
    expect(r.reason).toContain('do not trade')
    expect(r.oracleUsd).toBe(2000)
  })

  it('skips tokens with no Chainlink feed — nothing to compare', async () => {
    const r = await oracleSanityCheck('MOG', 0.0000012)
    expect(r.checked).toBe(false)
    expect(r.ok).toBe(true)
  })

  it('skips when the feed is stale/unavailable — fails open, visibly', async () => {
    serveEth(2000n * 10n ** 8n, Math.floor(Date.now() / 1000) - 3 * 3600) // 3h stale
    const r = await oracleSanityCheck('ETH', 2010, 2)
    expect(r.checked).toBe(false)
    expect(r.ok).toBe(true)
  })
})
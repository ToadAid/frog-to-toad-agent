import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lpSpreadTool } from '../src/tools/spread.js'

const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  sleep: async () => {},
}))

const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'

function pair(chain: string, dex: string, price: string, liq: number) {
  return {
    chainId: chain,
    dexId: dex,
    url: `https://dexscreener.com/${chain}/${dex}`,
    baseToken: { address: PEPE, name: 'Pepe', symbol: 'PEPE' },
    priceUsd: price,
    liquidity: { usd: liq },
  }
}

describe('LP spread hunter — paper trades only', () => {
  beforeEach(() => fetchJsonMock.mockReset())

  function mockTokenPairs(pairs: unknown[]) {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      // vitest's own hooks re-touch the mock with no args — tolerate, never match.
      if (url === undefined) return { pairs: [] }
      if (url.includes('/latest/dex/search?')) {
        return {
          pairs: [pair('ethereum', 'uniswap', '0.00000300', 26_000_000)],
        }
      }
      if (url.includes('/latest/dex/tokens/')) return { pairs }
      throw new Error(`unexpected url: ${url}`)
    })
  }

  it('resolves a TICKER to its dominant contract first — never compares different tokens', async () => {
    // Two LPs for the canonical contract: a real, cost-surviving spread.
    mockTokenPairs([
      pair('ethereum', 'uniswap', '0.00000300', 10_000_000),
      pair('ethereum', 'sushiswap', '0.00000309', 2_000_000),
    ])
    const r = await lpSpreadTool.execute({ query: 'PEPE', sizeUsd: 100 }, null as never)
    expect(r.text).toContain("ticker 'PEPE' → PEPE")
    expect(r.text).toContain('excluded on purpose')
    expect(r.text).toContain('ethereum (2 LPs)')
    expect(r.text).toContain('BUY  uniswap')
    expect(r.text).toContain('SELL sushiswap')
    expect(r.text).toContain('gross spread 3.00%')
    expect(r.text).toContain('fees 0.6%')
    expect(r.text).toContain('NET')
    expect(r.text).toMatch(/NET [+\-0-9.]+% [✅🟡❌]/)
  })

  it('finds an LP gap by ADDRESS and does the net-of-costs math honestly', async () => {
    mockTokenPairs([
      pair('ethereum', 'uniswap', '0.00000300', 10_000_000),
      pair('ethereum', 'sushiswap', '0.00000309', 2_000_000),
    ])
    // $5k size makes ethereum gas negligible: 3% − 0.6% fees − 0.001% gas − ~0.1% slip > 0
    const r = await lpSpreadTool.execute({ query: PEPE, sizeUsd: 5000 }, null as never)
    expect(r.text).toContain('exact')
    expect(r.text).toContain('gross spread 3.00%')
    expect(r.text).toMatch(/NET [1-9]/) // net is positive — edge survives costs
    expect(r.text).toContain('edge after costs')
  })

  it('calls no-edge when the spread is smaller than the round-trip tax', async () => {
    fetchJsonMock.mockResolvedValue({
      pairs: [
        pair('ethereum', 'uniswap', '0.00000300', 10_000_000),
        pair('ethereum', 'sushiswap', '0.00000302', 2_000_000),
      ],
    })
    const r = await lpSpreadTool.execute({ query: PEPE }, null as never)
    expect(r.text).toContain('no edge after costs')
  })

  it('flags cross-chain gaps as NOT tradable (bridge risk)', async () => {
    // same contract address deployed on two chains, 2+ LPs each
    fetchJsonMock.mockResolvedValue({
      pairs: [
        pair('ethereum', 'uniswap', '0.00000300', 10_000_000),
        pair('ethereum', 'sushiswap', '0.00000301', 2_000_000),
        pair('solana', 'raydium', '0.00000360', 4_000_000),
        pair('solana', 'orca', '0.00000361', 3_000_000),
      ],
    })
    const r = await lpSpreadTool.execute({ query: PEPE }, null as never)
    expect(r.text).toContain('CROSS-CHAIN')
    expect(r.text).toContain('BRIDGE')
  })

  it('ignores dust pools that would fake a huge spread', async () => {
    fetchJsonMock.mockResolvedValue({
      pairs: [
        pair('ethereum', 'uniswap', '0.00000300', 10_000_000),
        pair('ethereum', 'some-scam-pool', '0.00001000', 3_000), // below $5k floor
      ],
    })
    const r = await lpSpreadTool.execute({ query: PEPE }, null as never)
    expect(r.text).toContain('No spread to hunt')
    expect(r.text).not.toContain('some-scam-pool')
  })

  it('never pretends a paper signal is executable — inventory-risk + journal warnings always shown', async () => {
    fetchJsonMock.mockResolvedValue({
      pairs: [
        pair('ethereum', 'uniswap', '0.00000300', 10_000_000),
        pair('ethereum', 'sushiswap', '0.00000309', 2_000_000),
      ],
    })
    const r = await lpSpreadTool.execute({ query: PEPE }, null as never)
    expect(r.text).toContain('inventory risk')
    expect(r.text).toContain('journal_append')
  })
})
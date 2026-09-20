import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { guard } from '../src/safety/guard.js'
import { shortAddress, isContractAddress, isMajor } from '../src/tools/tokens.js'
import { formatTradeCard } from '../src/telegram/render.js'

const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  sleep: async () => {},
}))

let dir = ''
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-tokenid-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(path.join(dir, 'data', 'ledger.jsonl'), { force: true })
})

describe('token identity — address first', () => {
  it('shortens contract addresses for cards', () => {
    expect(shortAddress('0x6982508145454ce325ddbe47a25d4ec3d2311933')).toBe('0x6982…1933')
    expect(shortAddress('0xdeadbeef')).toBe('0xdeadbeef') // too short to shorten
  })

  it('recognizes contract addresses vs tickers', () => {
    expect(isContractAddress('0x6982508145454ce325ddbe47a25d4ec3d2311933')).toBe(true)
    expect(isContractAddress('PEPE')).toBe(false)
    expect(isContractAddress('0xNOTHEX')).toBe(false)
  })

  it('majors keep symbol-only privileges, long-tail tokens do not', () => {
    expect(isMajor('ETH')).toBe(true)
    expect(isMajor('usdc')).toBe(true)
    expect(isMajor('PEPE')).toBe(false)
  })

  it('guard blocks a lookalike contract even when its ticker is allowed', () => {
    const g = guard(cfg)
    const ok = g.precheckTrade({
      from: 'USDC',
      to: 'PEPE',
      toAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      notionalUsd: 10,
    })
    expect(ok.ok).toBe(true)

    const blocked = guard({
      ...cfg,
      limits: { ...cfg.limits, blockedAddresses: ['0x6982508145454ce325ddbe47a25d4ec3d2311933'] },
    })
    const r = blocked.precheckTrade({
      from: 'USDC',
      to: 'PEPE',
      toAddress: '0x6982508145454CE325DDBE47A25D4EC3D2311933', // different case — must still match
      notionalUsd: 10,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('blocked-address')
  })

  it('trade cards show the contract so the human confirms the ASSET, not the label', () => {
    const card = formatTradeCard({
      simulated: true,
      fromToken: 'USDC',
      toToken: 'PEPE on 0x6982…1933',
      toTokenAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      fromAmount: '25',
      toAmount: '1234.5',
    })
    expect(card).toContain('Contract:')
    expect(card).toContain('0x6982…1933')
    // full address never in the HTML card (tap-to-see comes later); short form only
    expect(card).not.toContain('0x6982508145454ce325ddbe47a25d4ec3d2311933')
  })

  it('market_token_search by ADDRESS gives the exact identity, not a fuzzy candidate list', async () => {
    const { marketTokenSearchTool } = await import('../src/tools/market.js')
    // The exact tokens endpoint answers; if the tool reaches for the fuzzy
    // search endpoint on an address, this test fails by construction.
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes('/latest/dex/tokens/')) {
        return {
          pairs: [
            {
              chainId: 'ethereum',
              dexId: 'uniswap',
              url: 'https://dexscreener.com/ethereum/x',
              baseToken: { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', name: 'Pepe', symbol: 'PEPE' },
              priceUsd: '0.00000341',
              liquidity: { usd: 26_400_000 },
              volume: { h24: 5_000_000 },
              pairCreatedAt: Date.now() - 3 * 86_400_000,
              fdv: 1_410_000_000,
            },
          ],
        }
      }
      throw new Error(`search endpoint must not be used for addresses: ${url}`)
    })
    const r = await marketTokenSearchTool.execute(
      { query: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' },
      null as never,
    )
    expect(r.text).toContain('IDENTITY')
    expect(r.text).toContain('PEPE — Pepe')
    expect(r.text).toContain('ethereum')
  })

  it('market_token_search by TICKER still uses the fuzzy search (many contracts expected)', async () => {
    const { marketTokenSearchTool } = await import('../src/tools/market.js')
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes('/latest/dex/search?')) {
        return {
          pairs: [
            {
              chainId: 'ethereum',
              dexId: 'uniswap',
              url: 'u1',
              baseToken: { address: '0xaaa1', name: 'Pepe', symbol: 'PEPE' },
              liquidity: { usd: 26_000_000 },
            },
            {
              chainId: 'solana',
              dexId: 'raydium',
              url: 'u2',
              baseToken: { address: 'SoLanaLookalike', name: 'Pepe Clone', symbol: 'PEPE' },
              liquidity: { usd: 4_000_000 },
            },
          ],
        }
      }
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketTokenSearchTool.execute({ query: 'PEPE' }, null as never)
    expect(r.text).toContain('0xaaa1')
    expect(r.text).toContain('Confirm the EXACT contract')
  })
})
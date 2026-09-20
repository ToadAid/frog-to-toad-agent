import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { appendLedger } from '../src/store/positions.js'
import { checkPositions, formatGuardianReport } from '../src/safety/positionGuardian.js'
import { marketTechnicalsTool } from '../src/tools/technicals.js'

const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  sleep: async () => {},
}))

let dir = ''
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-guardian-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true })
  fetchJsonMock.mockReset()
})

describe('position guardian — thresholds are code, not prompt', () => {
  function openPosition(symbol: string, entryUsd: number): void {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol,
      qty: 1,
      entryUsd,
      dryRun: true,
      rationale: 'guardian test',
    })
  }

  it('stays quiet above thresholds, alerts once at −10%, escalates at −25%', async () => {
    openPosition('ETH', 100)
    const price = { current: 95 }

    const r1 = await checkPositions(cfg, async () => price.current)
    expect(r1.alerts).toEqual([]) // −5%: under watch, nothing to say

    price.current = 89 // −11%
    const r2 = await checkPositions(cfg, async () => price.current)
    expect(r2.alerts).toHaveLength(1)
    expect(r2.alerts[0]).toMatchObject({ kind: 'breach', symbol: 'ETH', level: 'watch' })

    const r3 = await checkPositions(cfg, async () => price.current) // still −11%: silent
    expect(r3.alerts).toEqual([])

    price.current = 70 // −30%: deepens to critical
    const r4 = await checkPositions(cfg, async () => price.current)
    expect(r4.alerts).toHaveLength(1)
    expect(r4.alerts[0]).toMatchObject({ kind: 'breach', level: 'critical' })

    price.current = 99 // recovered
    const r5 = await checkPositions(cfg, async () => price.current)
    expect(r5.alerts[0]).toMatchObject({ kind: 'recovered' })

    price.current = 85 // −15% again: re-alerts because the watch was cleared
    const r6 = await checkPositions(cfg, async () => price.current)
    expect(r6.alerts).toHaveLength(1)
    expect(r6.alerts[0]).toMatchObject({ kind: 'breach', level: 'watch' })
  })

  it('renders breach and recovery lines for Telegram', async () => {
    openPosition('SOL', 100)
    let price = 70 // −30%: critical
    const check = await checkPositions(cfg, async () => price)
    const report = formatGuardianReport(check)
    expect(report).toContain('CRITICAL SOL')
    expect(report).toContain('−30% from entry')

    price = 98
    expect(formatGuardianReport(await checkPositions(cfg, async () => price))).toContain('RECOVERED SOL')
    expect(formatGuardianReport(await checkPositions(cfg, async () => price))).toBe('') // quiet when nothing happened
  })

  it('reports unpriced positions without alerting on them', async () => {
    openPosition('MOG', 0.5)
    const r = await checkPositions(cfg, async () => undefined)
    expect(r.checked).toBe(1)
    expect(r.unpriced).toEqual(['MOG'])
    expect(r.alerts).toEqual([])
  })
})

describe('market_technicals — long-tail path by contract address', () => {
  const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'

  function gtOhlcv(): unknown {
    return {
      data: {
        attributes: {
          // [timeSec, open, high, low, close, volume] — NEWEST first per the API
          ohlcv_list: Array.from({ length: 60 }, (_, i) => {
            const idx = 59 - i
            const c = 100 + idx * 0.5
            return [1_700_000_000 + idx * 3600, c - 0.1, c + 0.2, c - 0.2, c, 1000]
          }),
        },
      },
    }
  }

  it('resolves the address → best pair → candles, and labels the identity', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      if (url.includes('/latest/dex/tokens/')) {
        return {
          pairs: [
            {
              chainId: 'ethereum',
              dexId: 'uniswap',
              pairAddress: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
              url: 'u',
              baseToken: { address: PEPE, name: 'Pepe', symbol: 'PEPE' },
              priceUsd: '0.0000034',
              liquidity: { usd: 26_000_000 },
            },
          ],
        }
      }
      if (url.includes('geckoterminal.com')) return gtOhlcv()
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketTechnicalsTool.execute({ symbol: PEPE }, null as never)
    expect(r.text).toContain('geckoterminal')
    expect(r.text).toContain('PEPE')
    expect(r.text).toContain('0x6982…1933')
  })

  it('errors honestly when the contract has no liquid pair for candles', async () => {
    fetchJsonMock.mockImplementation(async (url?: string) => {
      if (url === undefined) return {}
      if (url.includes('/latest/dex/tokens/')) return { pairs: [] }
      throw new Error(`unexpected url: ${url}`)
    })
    const r = await marketTechnicalsTool.execute({ symbol: PEPE }, null as never)
    expect(r.text).toContain('[error] no liquid DexScreener pair')
  })
})
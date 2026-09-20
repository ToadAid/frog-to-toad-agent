import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setBlockscoutFetcher,
  setRpcReader,
  setStorageReader,
  fetchTokenMeta,
  fetchContractInfo,
  readBalanceOfRaw,
  readTotalSupplyRaw,
  readOwner,
  readProxyImplementation,
  toDecimalUnits,
} from '../src/market/tokenAudit.js'
import { selectorWithAddress, SELECTORS, wordToAddress, ZERO_ADDRESS, DEAD_ADDRESS } from '../src/market/rpc.js'
import { renderAudit } from '../src/tools/audit.js'
import type { DexPair } from '../src/tools/tokens.js'

// Seams swap the network out entirely — no live calls in tests.
const blockscout = vi.fn()
const rpc = vi.fn()
const storage = vi.fn()

const TOKEN = '0x' + 'aa'.repeat(20)
const LP = '0x' + 'bb'.repeat(20)
const LOCKER = '0x' + 'cc'.repeat(20)

/** 1000 tokens at 18 decimals, as a raw BigInt string. */
const SUPPLY_RAW = (1000n * 10n ** 18n).toString()
const LP_SUPPLY_RAW = (100n * 10n ** 18n).toString()

function pairFixture(overrides: Partial<DexPair> = {}): DexPair {
  return {
    chainId: 'base',
    dexId: 'uniswap',
    url: 'https://dexscreener.com/base/x',
    baseToken: { address: TOKEN, name: 'Test Token', symbol: 'TEST' },
    pairAddress: LP,
    liquidity: { usd: 250_000 },
    ...overrides,
  }
}

beforeEach(() => {
  blockscout.mockReset()
  rpc.mockReset()
  storage.mockReset()
  setBlockscoutFetcher(async (url) => blockscout(url))
  setRpcReader(async (to, data) => rpc(to, data))
  setStorageReader(async (addr, slot) => storage(addr, slot))
})

afterEach(() => {
  setBlockscoutFetcher(undefined)
  setRpcReader(undefined)
  setStorageReader(undefined)
})

describe('rpc decode helpers', () => {
  it('selectorWithAddress pads the address to 32 bytes, lowercased', () => {
    const call = selectorWithAddress(SELECTORS.balanceOf, '0xAbC0000000000000000000000000000000000001')
    expect(call).toBe('0x70a08231000000000000000000000000abc0000000000000000000000000000000000001')
  })

  it('wordToAddress takes the LAST 20 bytes (left-padded words)', () => {
    expect(wordToAddress('0x' + '0'.repeat(24) + 'abcdef0000000000000000000000000000000001')).toBe('0xabcdef0000000000000000000000000000000001')
  })

  it('toDecimalUnits divides by 10^decimals', () => {
    expect(toDecimalUnits(10n ** 18n, 18)).toBe(1)
    expect(toDecimalUnits(1_000_000n, 6)).toBe(1)
  })
})

describe('blockscout reads', () => {
  it('parses token meta (string decimals, raw supply)', async () => {
    blockscout.mockImplementation(async (url: string) => {
      if (url.includes('/tokens/')) {
        return { name: 'Test Token', symbol: 'TEST', decimals: '18', total_supply: SUPPLY_RAW, holders_count: 42 }
      }
      throw new Error('unexpected url ' + url)
    })
    const meta = await fetchTokenMeta(TOKEN)
    expect(meta?.symbol).toBe('TEST')
    expect(meta?.decimals).toBe(18)
    expect(meta?.totalSupplyRaw).toBe(SUPPLY_RAW)
  })

  it('a failed token meta read is undefined — INCONCLUSIVE, never fabricated', async () => {
    blockscout.mockImplementation(async () => {
      throw new Error('HTTP 500 from explorer')
    })
    expect(await fetchTokenMeta(TOKEN)).toBeUndefined()
  })

  it('classifies explorer 404 as not_found vs transient 500 as error', async () => {
    blockscout.mockImplementation(async () => {
      throw new Error('HTTP 404 from explorer: not found')
    })
    expect((await fetchContractInfo(TOKEN))?.status).toBe('not_found')
    blockscout.mockImplementation(async () => {
      throw new Error('HTTP 500 from explorer')
    })
    expect((await fetchContractInfo(TOKEN))?.status).toBe('error')
  })
})

describe('rpc reads', () => {
  it('balanceOf decodes the 32-byte word to a BigInt', async () => {
    rpc.mockResolvedValue('0x' + (25n * 10n ** 18n).toString(16).padStart(64, '0'))
    const raw = await readBalanceOfRaw(TOKEN, DEAD_ADDRESS)
    expect(raw).toBe(25n * 10n ** 18n)
    expect(rpc).toHaveBeenCalledWith(TOKEN, selectorWithAddress(SELECTORS.balanceOf, DEAD_ADDRESS))
  })

  it('a failed balanceOf read is undefined — never treated as zero', async () => {
    rpc.mockRejectedValue(new Error('all RPCs down'))
    expect(await readBalanceOfRaw(TOKEN, DEAD_ADDRESS)).toBeUndefined()
  })

  it('totalSupply decodes to a BigInt', async () => {
    rpc.mockResolvedValue('0x' + (100n * 10n ** 18n).toString(16).padStart(64, '0'))
    expect(await readTotalSupplyRaw(TOKEN)).toBe(100n * 10n ** 18n)
  })

  it('owner() = 0x0 decodes to the zero address (renounced)', async () => {
    rpc.mockResolvedValue('0x' + '0'.repeat(64))
    expect(await readOwner(TOKEN)).toBe(ZERO_ADDRESS)
  })

  it('owner() revert / no owner() function → undefined (unknown, not renounced)', async () => {
    rpc.mockRejectedValue(new Error('execution reverted'))
    expect(await readOwner(TOKEN)).toBeUndefined()
  })

  it('proxy detection: zero EIP-1967 slot → undefined; populated slot → implementation address', async () => {
    storage.mockResolvedValue('0x' + '0'.repeat(64))
    expect(await readProxyImplementation(TOKEN)).toBeUndefined()
    storage.mockResolvedValue('0x' + '0'.repeat(24) + '1234abcd00000000000000000000000000009999')
    const impl = await readProxyImplementation(TOKEN)
    expect(impl).toBe('0x1234abcd00000000000000000000000000009999')
  })
})

describe('renderAudit — the report is honest by construction', () => {
  /** Wire the seams into a full happy-ish fixture. */
  function mockHappyWorld(overrides: {
    deadBal?: bigint
    zeroBal?: bigint
    owner?: string
    implSlot?: string
    /** string = verified source; null = explorer HTTP 500; false = entry without source (unverified); undefined = clean default. */
    source?: string | null | false
    top10Sum?: bigint
    meta?: boolean
  } = {}): void {
    blockscout.mockImplementation(async (url: string) => {
      if (url.includes('/tokens/') && !url.includes('/holders')) {
        return { name: 'Test Token', symbol: 'TEST', decimals: '18', total_supply: SUPPLY_RAW, holders_count: 42 }
      }
      if (url.includes('/holders')) {
        // 10 holders summing to `top10Sum` (default 20% of supply).
        const sum = overrides.top10Sum ?? 200n * 10n ** 18n
        const each = sum / 10n
        return {
          items: Array.from({ length: 10 }, (_, i) => ({
            address: { hash: `0x${String(i).padStart(40, '0')}`, is_contract: i === 0 },
            value: each.toString(),
          })),
        }
      }
      if (url.includes('/smart-contracts/')) {
        if (overrides.source === null) throw new Error('HTTP 500 from explorer')
        if (overrides.source === false) return { name: 'TestToken', creation_status: 'success' } // entry without source_code
        return { name: 'TestToken', source_code: overrides.source ?? '// no mint', creation_status: 'success' }
      }
      throw new Error('unexpected url ' + url)
    })
    rpc.mockImplementation(async (to: string, data: string) => {
      if (data.startsWith(SELECTORS.totalSupply)) return '0x' + (100n * 10n ** 18n).toString(16).padStart(64, '0')
      if (data === selectorWithAddress(SELECTORS.balanceOf, DEAD_ADDRESS)) return '0x' + (overrides.deadBal ?? 95n * 10n ** 18n).toString(16).padStart(64, '0')
      if (data === selectorWithAddress(SELECTORS.balanceOf, ZERO_ADDRESS)) return '0x' + (overrides.zeroBal ?? 4n * 10n ** 18n).toString(16).padStart(64, '0')
      if (data === SELECTORS.owner) {
        const owner = overrides.owner
        if (owner === undefined) throw new Error('execution reverted')
        return '0x' + owner.replace(/^0x/, '').padStart(64, '0')
      }
      throw new Error('unexpected eth_call ' + data)
    })
    storage.mockImplementation(async () => overrides.implSlot ?? '0x' + '0'.repeat(64))
  }

  it('clean token: LP burned, renounced owner, no mint, spread holders → GO', async () => {
    mockHappyWorld({ source: '// no mint here', owner: ZERO_ADDRESS })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('VERDICT: GO')
    expect(report).toContain('LP 99.0% burned/locked')
    expect(report).toContain('ownership renounced')
    expect(report).toContain('no mint function in verified source')
    expect(report).toContain('top-10 holders control 20.0%')
    expect(report).toContain(`applies to ${TOKEN} only`)
  })

  it('unlocked LP is a red flag with the LP token address named', async () => {
    mockHappyWorld({ deadBal: 10n * 10n ** 18n, zeroBal: 5n * 10n ** 18n })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('only 15.0% of LP burned')
    expect(report).toContain(LP)
    expect(report).toContain('VERDICT: CAUTION')
  })

  it('unverifiable LP read is a flag, not a pass', async () => {
    mockHappyWorld({ deadBal: undefined as unknown as bigint })
    rpc.mockImplementation(async (to: string, data: string) => {
      if (data === SELECTORS.owner) throw new Error('revert')
      throw new Error('RPC down')
    })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('LP burn % unknown')
  })

  it('live owner is named in a red flag; owner-less contract lands in notes', async () => {
    mockHappyWorld({ owner: LOCKER, source: '// no mint' })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain(`owner is live: ${LOCKER}`)
    // With a source that has no owner() read failure... owner() succeeded here.
    expect(report).not.toContain('renounce status unknown')
    expect(report).toContain('VERDICT: CAUTION')
  })

  it('mint behind a live owner is a red flag even when owner-gated', async () => {
    mockHappyWorld({ owner: LOCKER, source: 'function mint(address to, uint256 amount) public onlyOwner {}' })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('mint capability in source (1 site(s), onlyOwner-gated) with owner live')
  })

  it('mint behind a RENOUNCED owner is the one mint shape that stays green', async () => {
    mockHappyWorld({ owner: ZERO_ADDRESS, source: 'function mint(address to, uint256 amount) public onlyOwner {}' })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('owner is renounced — cannot mint again')
    expect(report).toContain('VERDICT: GO')
  })

  it('unverified source and unverifiable source are DIFFERENT flags', async () => {
    mockHappyWorld({ source: false }) // entry without source_code
    let report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('source code NOT verified')
    mockHappyWorld({ source: null }) // HTTP 500
    report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('explorer read FAILED')
    expect(report).toContain('re-run before trusting a clean verdict')
  })

  it('upgradeable proxy is a red flag with the implementation address', async () => {
    mockHappyWorld({ implSlot: '0x' + '0'.repeat(24) + LOCKER.replace(/^0x/, '') })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('upgradeable proxy')
    expect(report).toContain(LOCKER)
  })

  it('holder concentration > 30% is a red flag with the real number', async () => {
    mockHappyWorld({ top10Sum: 500n * 10n ** 18n })
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('top-10 holders control 50.0% of supply (> 30% dump risk)')
  })

  it('no pair at all → LP unknown flag (NO-GO territory with the source flag)', async () => {
    mockHappyWorld({ source: false })
    const report = await renderAudit(TOKEN, undefined, '')
    expect(report).toContain('no DexScreener pair')
    expect(report).toContain('VERDICT: NO-GO')
  })

  it('failed holder read is a flag — concentration is never assumed clean', async () => {
    blockscout.mockImplementation(async (url: string) => {
      if (url.includes('/tokens/') && !url.includes('/holders')) {
        return { name: 'Test Token', symbol: 'TEST', decimals: '18', total_supply: SUPPLY_RAW }
      }
      if (url.includes('/smart-contracts/')) return { name: 'TestToken', source_code: '// ok', creation_status: 'success' }
      throw new Error('holders endpoint down')
    })
    rpc.mockImplementation(async (to: string, data: string) => {
      if (data === SELECTORS.owner) throw new Error('revert')
      if (data.startsWith(SELECTORS.totalSupply)) return '0x' + (100n * 10n ** 18n).toString(16).padStart(64, '0')
      if (data === selectorWithAddress(SELECTORS.balanceOf, DEAD_ADDRESS)) return '0x' + (95n * 10n ** 18n).toString(16).padStart(64, '0')
      if (data === selectorWithAddress(SELECTORS.balanceOf, ZERO_ADDRESS)) return '0x' + (4n * 10n ** 18n).toString(16).padStart(64, '0')
      throw new Error('unexpected eth_call ' + data)
    })
    storage.mockResolvedValue('0x' + '0'.repeat(64))
    const report = await renderAudit(TOKEN, pairFixture(), '')
    expect(report).toContain('holder concentration unknown')
    expect(report).toContain('VERDICT: CAUTION')
  })
})
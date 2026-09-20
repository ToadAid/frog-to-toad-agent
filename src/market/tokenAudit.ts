import { fetchJson } from '../http.js'
import {
  SELECTORS,
  selectorWithAddress,
  tryEthCall,
  tryGetStorageAt,
  wordToAddress,
  ZERO_ADDRESS,
  DEAD_ADDRESS,
  EIP1967_IMPLEMENTATION_SLOT,
} from './rpc.js'

/**
 * token_audit lane (principal's AUDIT TOOL BUILD SPEC, 2026-09-02) — the
 * onchain security reads the market-data lanes CANNOT see. Keyless:
 *  - Blockscout's public Base API (base.blockscout.com/api/v2): token meta,
 *    top holders, verified source code.
 *  - The shared keyless Base RPC (rpc.ts): owner(), balanceOf, totalSupply,
 *    EIP-1967 proxy detection.
 *
 * Checks (spec priority order):
 *  1. LP lock/burn  — balanceOf(dead + zero) on the pair's LP token (V2-style;
 *     concentrated-liquidity pools are NFT positions → honestly unavailable).
 *  2. owner()/mint  — live owner() read (renounced?) + mint in verified source.
 *     Proxy contract (EIP-1967 slot occupied) = upgradeable = flagged.
 *  3. Top-10 holders — % of total supply, contract holders marked.
 *  Tax + honeypot sim is deliberately NOT here (spec: can wait).
 *
 * Desk honesty rule holds: a read that fails is INCONCLUSIVE — reported as a
 * flag ("missing data IS a red flag"), never silently treated as clean/zero.
 */

export const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2'

// ── Test seam ────────────────────────────────────────────────────────────────

type FetchFn = (url: string, opts?: { retries?: number }) => Promise<unknown>
const realFetch: FetchFn = (url, opts) => fetchJson(url, opts)
let blockscoutJson: FetchFn = realFetch
/** Test seam — swap the Blockscout JSON fetcher (set undefined to restore the real one). */
export function setBlockscoutFetcher(fn: FetchFn | undefined): void {
  blockscoutJson = fn ?? realFetch
}

export type RpcRead = (to: string, data: string) => Promise<string | undefined>
let rpcRead: RpcRead = tryEthCall
/** Test seam — swap the eth_call reader (set undefined to restore the real one). */
export function setRpcReader(fn: RpcRead | undefined): void {
  rpcRead = fn ?? tryEthCall
}

export type StorageRead = (address: string, slot: string) => Promise<string | undefined>
let storageRead: StorageRead = tryGetStorageAt
/** Test seam — swap the storage-slot reader (set undefined to restore the real one). */
export function setStorageReader(fn: StorageRead | undefined): void {
  storageRead = fn ?? tryGetStorageAt
}

// ── Blockscout reads ─────────────────────────────────────────────────────────

export type TokenMeta = {
  address: string
  name?: string
  symbol?: string
  decimals?: number
  /** Raw units as a string (BigInt-sized). */
  totalSupplyRaw?: string
  holdersCount?: number
}

type BlockscoutToken = {
  address_hash?: string
  name?: string
  symbol?: string
  decimals?: string
  total_supply?: string
  holders_count?: number
}

export async function fetchTokenMeta(address: string): Promise<TokenMeta | undefined> {
  try {
    const t = (await blockscoutJson(`${BLOCKSCOUT_BASE}/tokens/${address.toLowerCase()}`, { retries: 1 })) as BlockscoutToken
    return {
      address: address.toLowerCase(),
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals !== undefined ? Number(t.decimals) : undefined,
      totalSupplyRaw: t.total_supply,
      holdersCount: t.holders_count,
    }
  } catch {
    return undefined // INCONCLUSIVE — flagged by the caller
  }
}

export type Holder = { address: string; valueRaw: string; isContract: boolean }

type BlockscoutHolders = {
  items?: Array<{ address?: { hash?: string; is_contract?: boolean }; value?: string }>
  /** Pagination path (e.g. "/api/v2/tokens/0x…/holders?block_number=…") when more pages exist. */
  next?: string
}

export async function fetchTopHolders(address: string, pages = 1): Promise<Holder[]> {
  const holders: Holder[] = []
  let next: string | undefined
  for (let i = 0; i < pages; i++) {
    let body: BlockscoutHolders
    try {
      const url = next ?? `${BLOCKSCOUT_BASE}/tokens/${address.toLowerCase()}/holders`
      body = (await blockscoutJson(url, { retries: 1 })) as BlockscoutHolders
    } catch {
      break // partial data is still data — caller decides if it's enough
    }
    for (const item of body.items ?? []) {
      if (item.address?.hash && typeof item.value === 'string') {
        holders.push({ address: item.address.hash.toLowerCase(), valueRaw: item.value, isContract: item.address.is_contract === true })
      }
    }
    next = typeof body.next === 'string' ? `${BLOCKSCOUT_BASE}${body.next}` : undefined
    if (!next) break
  }
  return holders
}

export type ContractInfo = {
  verified: boolean
  name?: string
  sourceCode?: string
  /** ok = entry read; not_found = 404 (EOA or no verified contract entry); error = explorer read failed (transient). */
  status: 'ok' | 'not_found' | 'error'
}

type BlockscoutContract = {
  source_code?: string
  name?: string
  creation_status?: string
}

export async function fetchContractInfo(address: string): Promise<ContractInfo | undefined> {
  try {
    const c = (await blockscoutJson(`${BLOCKSCOUT_BASE}/smart-contracts/${address.toLowerCase()}`, { retries: 1 })) as BlockscoutContract
    if (!c || typeof c !== 'object') return undefined
    const sourceCode = typeof c.source_code === 'string' && c.source_code.trim() !== '' ? c.source_code : undefined
    return { name: c.name, sourceCode, verified: sourceCode !== undefined, status: 'ok' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 404 → the explorer has no verified contract entry (or it's an EOA).
    // 429/5xx → transient explorer failure: INCONCLUSIVE, distinct from unverified.
    if (msg.startsWith('HTTP 404')) return { verified: false, status: 'not_found' }
    return { verified: false, status: 'error' }
  }
}

// ── Direct RPC reads ─────────────────────────────────────────────────────────

export async function readBalanceOfRaw(token: string, holder: string): Promise<bigint | undefined> {
  let result: string | undefined
  try {
    result = await rpcRead(token, selectorWithAddress(SELECTORS.balanceOf, holder))
  } catch {
    return undefined
  }
  if (result === undefined) return undefined
  try {
    return BigInt(result)
  } catch {
    return undefined
  }
}

export async function readTotalSupplyRaw(token: string): Promise<bigint | undefined> {
  let result: string | undefined
  try {
    result = await rpcRead(token, SELECTORS.totalSupply)
  } catch {
    return undefined
  }
  if (result === undefined) return undefined
  try {
    return BigInt(result)
  } catch {
    return undefined
  }
}

export async function readOwner(token: string): Promise<string | undefined> {
  let result: string | undefined
  try {
    result = await rpcRead(token, SELECTORS.owner)
  } catch {
    return undefined // revert = no owner() function; read failure = unknown
  }
  if (result === undefined || result === '0x') return undefined // no owner() or read failed
  return wordToAddress(result)
}

/** EIP-1967 implementation slot via eth_getStorageAt — proxy detected when non-zero. */
export async function readProxyImplementation(token: string): Promise<string | undefined> {
  const result = await storageRead(token, EIP1967_IMPLEMENTATION_SLOT)
  if (result === undefined) return undefined
  const asBigInt = BigInt(result)
  if (asBigInt === 0n) return undefined
  return wordToAddress(result)
}

export function toDecimalUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals
}
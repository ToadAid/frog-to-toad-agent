import { fetchJson } from '../http.js'

/**
 * Keyless Base RPC lane — plain `eth_call` against public Base endpoints.
 * No API key, no payment, no registration. Shared by the Chainlink oracle
 * reads and the token_audit onchain security reads.
 */

export const BASE_RPCS = ['https://mainnet.base.org', 'https://base.publicnode.com']

type EthCallResult = { result?: string; error?: { message?: string } }

export async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetchJson<EthCallResult>(rpc, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] },
  })
  if (res.error) throw new Error(`eth_call reverted: ${res.error.message}`)
  if (typeof res.result !== 'string') throw new Error('eth_call returned no result')
  return res.result
}

/** eth_call against the first RPC that answers; undefined when all fail (INCONCLUSIVE, never zero). */
export async function tryEthCall(to: string, data: string): Promise<string | undefined> {
  for (const rpc of BASE_RPCS) {
    try {
      return await ethCall(rpc, to, data)
    } catch {
      // next RPC
    }
  }
  return undefined
}

type StorageResult = { result?: string; error?: { message?: string } }

/**
 * Storage slots are read with eth_getStorageAt — NOT eth_call: sending the slot
 * as calldata invokes the contract's fallback, which usually reverts (caught
 * live on the token_audit maiden run).
 */
export async function tryGetStorageAt(address: string, slot: string): Promise<string | undefined> {
  for (const rpc of BASE_RPCS) {
    try {
      const res = await fetchJson<StorageResult>(rpc, {
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [address, slot, 'latest'] },
      })
      if (typeof res.result === 'string') return res.result
    } catch {
      // next RPC
    }
  }
  return undefined
}

// ── Standard ABI selectors (no ethers dependency — the desk hand-rolls eth_call) ──

export const SELECTORS = {
  balanceOf: '0x70a08231', // balanceOf(address)
  totalSupply: '0x18160ddd', // totalSupply()
  decimals: '0x313ce567', // decimals()
  owner: '0x8da5cb6b', // owner()
  symbol: '0x95d89b41', // symbol()
} as const

/** `0x70a08231` + 32-byte-padded address for a zero-arg-with-address call. */
export function selectorWithAddress(selector: string, address: string): string {
  return selector + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

/** Last 20 bytes of a 32-byte word → address (EVM returns values left-padded). */
export function wordToAddress(word: string): string {
  return ('0x' + word.replace(/^0x/, '').slice(-40).toLowerCase()) as `0x${string}`
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD'

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1 (verified against EIP-1967 + js-sha3). */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
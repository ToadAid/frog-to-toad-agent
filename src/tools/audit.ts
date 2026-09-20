import { z } from 'zod'
import { defineTool } from './registry.js'
import { bestPairByAddress, isContractAddress, searchTokenPairs, type DexPair } from './tokens.js'
import {
  fetchTokenMeta,
  fetchTopHolders,
  fetchContractInfo,
  readBalanceOfRaw,
  readTotalSupplyRaw,
  readOwner,
  readProxyImplementation,
} from '../market/tokenAudit.js'
import { ZERO_ADDRESS, DEAD_ADDRESS } from '../market/rpc.js'

/**
 * token_audit — the principal's AUDIT TOOL BUILD SPEC cut in code (2026-09-03).
 * Onchain security reads over keyless Blockscout Base API + the keyless Base RPC:
 *   1. LP lock/burn — balanceOf(dead + zero) on the pair's LP token
 *   2. owner()/mint — live owner() read + mint in verified source + proxy detection
 *   3. Top-10 holder concentration
 * Missing data IS a red flag (NO-GO default), same as token_safety_scan.
 * Verdict applies to the exact address only.
 */

/** V2-style AMMs where the pair contract IS a burnable ERC20 LP token. */
const SAFE_LP_DEXES = new Set(['uniswap', 'pancakeswap', 'sushiswap'])

const MINT_PATTERNS = [/\bfunction\s+mint\s*\(/g, /\bfunction\s+_mint\b/g, /_mint\s*\(\s*[^,)]+,\s*[^,)]+\s*\)/g]

export const tokenAuditTool = defineTool({
  name: 'token_audit',
  description:
    'ONCHAIN security audit of a token on Base (keyless): LP burn % on the pair LP token, live owner() read ' +
    '(renounced?), mint functions in verified source, upgradeable-proxy detection, top-10 holder concentration. ' +
    'Pass the CONTRACT ADDRESS when known (preferred); symbol alone resolves by search and is flagged. ' +
    'Missing data is reported as a red flag — never assumed clean.',
  danger: 'readonly',
  input: z.object({
    address: z.string().optional().describe('contract address (preferred) — the exact asset to audit'),
    symbol: z.string().optional().describe('ticker only if no address is known — result is flagged as search-resolved'),
  }),
  execute: async (input) => {
    if (!input.address && !input.symbol) {
      return { text: '[error] provide a contract address (preferred) or a symbol' }
    }

    let address = ''
    let resolvedBy = ''

    if (input.address && isContractAddress(input.address)) {
      address = input.address.toLowerCase()
    } else if (input.symbol) {
      const pairs = await searchTokenPairs(input.symbol, 3)
      const basePair = pairs.find((p) => p.chainId?.toLowerCase().includes('base'))
      if (!basePair) {
        const any = pairs[0]
        if (any) {
          return { text: `[error] token_audit reads Base mainnet only — '${input.symbol}' best pair is on '${any.chainId}'. No onchain audit performed.` }
        }
        return { text: `🚨 NO DATA for '${input.symbol}' — no DexScreener pair found. VERDICT: NO-GO (missing data is a red flag).` }
      }
      address = basePair.baseToken.address.toLowerCase()
      resolvedBy = '⚠️ resolved by SYMBOL SEARCH — confirm this is the contract you mean before trading'
    } else {
      return { text: `[error] '${input.address}' is not a valid contract address (expected 0x… 40 hex chars)` }
    }

    const pair = await bestPairByAddress(address)
    return { text: await renderAudit(address, pair, resolvedBy) }
  },
})

/** Compose the full audit report. Each check degrades to a flag, never to "clean". */
export async function renderAudit(address: string, pair: DexPair | undefined, resolvedBy: string): Promise<string> {
  const flags: string[] = []
  const greens: string[] = []
  const notes: string[] = []

  const meta = await fetchTokenMeta(address)
  const decimals = meta?.decimals
  const totalSupplyRaw = meta?.totalSupplyRaw !== undefined ? BigInt(meta.totalSupplyRaw) : undefined

  const tokenName = meta?.name ?? pair?.baseToken.name ?? address
  const tokenSymbol = meta?.symbol ?? pair?.baseToken.symbol ?? '?'

  // ── 1. LP lock/burn (spec priority 1) ──────────────────────────────────────
  const lpToken = pair?.pairAddress
  if (!pair) {
    flags.push('no DexScreener pair — LP status unknown (untradeable or too new)')
  } else if (!lpToken) {
    flags.push('pair has no LP token address — LP lock/burn check unavailable')
  } else if (!SAFE_LP_DEXES.has(pair.dexId.toLowerCase())) {
    notes.push(`LP burn check skipped: '${pair.dexId}' pool is concentrated-liquidity (NFT positions), not a burnable ERC20 LP`)
  } else {
    const [lpSupply, deadBal, zeroBal] = await Promise.all([
      readTotalSupplyRaw(lpToken),
      readBalanceOfRaw(lpToken, DEAD_ADDRESS),
      readBalanceOfRaw(lpToken, ZERO_ADDRESS),
    ])
    if (lpSupply === undefined || lpSupply <= 0n || deadBal === undefined || zeroBal === undefined) {
      flags.push('LP burn % unknown (LP token read failed — missing data is a red flag)')
    } else {
      const burnedPct = (Number(deadBal + zeroBal) / Number(lpSupply)) * 100
      if (burnedPct >= 90) greens.push(`LP ${burnedPct.toFixed(1)}% burned/locked (dead+zero addresses)`)
      else flags.push(`only ${burnedPct.toFixed(1)}% of LP burned to dead/zero — ${lpToken} LP can be pulled (rug vector)`)
    }
  }

  // ── 2. owner()/mint/proxy (spec priority 2) ────────────────────────────────
  const [owner, impl] = await Promise.all([readOwner(address), readProxyImplementation(address)])
  if (owner === ZERO_ADDRESS) greens.push('ownership renounced (owner() = 0x0)')
  else if (owner !== undefined) flags.push(`owner is live: ${owner} — admin/mint authority in human or contract hands`)
  else notes.push('owner() read unavailable (no owner() function or RPC failed) — renounce status unknown')

  if (impl !== undefined && impl !== ZERO_ADDRESS) {
    flags.push(`upgradeable proxy: implementation at ${impl} — the owner can change the code`)
  }

  const contract = await fetchContractInfo(address)
  if (contract === undefined) {
    flags.push('verified-source read returned nothing — mint/permission scan impossible; missing data is a red flag')
  } else if (contract.status === 'error') {
    flags.push('explorer read FAILED (transient Blockscout error) — mint/permission scan INCONCLUSIVE; re-run before trusting a clean verdict')
  } else if (!contract.verified) {
    flags.push('source code NOT verified on Base explorer — what the token does cannot be checked')
  } else {
    const mintCount = (MINT_PATTERNS.map((re) => contract.sourceCode?.match(re)).filter((m): m is RegExpMatchArray => m !== null)).reduce(
      (a, m) => a + m.length,
      0,
    )
    const hasOnlyOwner = /onlyOwner/.test(contract.sourceCode ?? '')
    if (mintCount > 0) {
      if (hasOnlyOwner && owner === ZERO_ADDRESS) {
        greens.push(`mint exists (${mintCount} site(s)) but is owner-gated and owner is renounced — cannot mint again`)
      } else {
        flags.push(
          `mint capability in source (${mintCount} site(s)${hasOnlyOwner ? ', onlyOwner-gated' : ', NOT owner-gated'})` +
            (owner !== undefined && owner !== ZERO_ADDRESS ? ' with owner live' : ''),
        )
      }
    } else {
      greens.push('no mint function in verified source')
    }
  }

  // ── 3. Top-10 holders (spec priority 3) ────────────────────────────────────
  const holders = await fetchTopHolders(address)
  if (holders.length === 0 || totalSupplyRaw === undefined || totalSupplyRaw <= 0n) {
    flags.push('holder concentration unknown (holder list or token meta failed)')
  } else {
    const top10 = holders.slice(0, 10)
    const sum = top10.reduce((acc, h) => {
      try {
        return acc + BigInt(h.valueRaw)
      } catch {
        return acc
      }
    }, 0n)
    const pct = (Number(sum) / Number(totalSupplyRaw)) * 100
    if (pct > 30) flags.push(`top-10 holders control ${pct.toFixed(1)}% of supply (> 30% dump risk)`)
    else greens.push(`top-10 holders control ${pct.toFixed(1)}% of supply (≤ 30%)`)
    const contractHolders = top10.filter((h) => h.isContract).length
    if (contractHolders > 0) notes.push(`${contractHolders} of the top-10 are contracts (pair/locker/staking — check which)`)
  }

  const verdict = flags.length === 0 ? 'GO' : flags.length <= 1 ? 'CAUTION' : 'NO-GO'
  const lines = [
    `🧬 Onchain audit — ${tokenName} (${tokenSymbol}) on Base`,
    `Contract: ${address}`,
    ...(meta?.holdersCount !== undefined && decimals !== undefined
      ? [`Holders: ${meta.holdersCount.toLocaleString()} · Decimals: ${decimals}`]
      : []),
    ...(resolvedBy ? ['', resolvedBy] : []),
    ...(notes.length > 0 ? ['', 'Notes:', ...notes.map((n) => `  ℹ️ ${n}`)] : []),
    '',
    `Red flags (${flags.length}):`,
    ...(flags.length > 0 ? flags.map((f) => `  🚩 ${f}`) : ['  none found in available data']),
    `Green flags (${greens.length}):`,
    ...(greens.length > 0 ? greens.map((g) => `  ✅ ${g}`) : ['  none']),
    '',
    `VERDICT: ${verdict} — applies to ${address} only.`,
  ]
  return lines.join('\n')
}
import { z } from 'zod'
import fs from 'node:fs'
import { McpClient } from './client.js'
import { log } from '../log.js'
import type { Config } from '../config.js'
import type { ToolRegistry, AnyToolSpec } from '../tools/registry.js'

/** Parse a KEY=VALUE env file (no quotes-processing beyond trimming surrounding quotes). */
export function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2]!.replace(/^["']|["']$/g, '')
    if (value !== '') out[m[1]!] = value
  }
  return out
}

/**
 * MCP → ToolRegistry bridge for the wallet lane. The external server (e.g.
 * Coinbase's CDP MCP server) holds the signer; this process holds none. The
 * bridge is deny-by-default: ONLY tools named in MCP_ALLOWED_TOOLS get
 * registered, under an `mcp_` prefix so they can never shadow desk tools.
 */

/** Names that touch money or wallet state — always mapped to danger 'trade'. */
const DANGEROUS_NAME_RE =
  /swap|trade|send|transfer|withdraw|deposit|wrap|approve|bridge|mint|burn|create|delete|deploy|sign|revoke/i

export function isDangerousMcpName(name: string): boolean {
  return DANGEROUS_NAME_RE.test(name)
}

export type McpBridge = {
  client: McpClient
  /** Tool names registered into the registry (mcp_-prefixed). */
  registered: string[]
  /** Server tools the allowlist rejected — visible for audit. */
  skipped: string[]
  specs: AnyToolSpec[]
  /** Env vars injected into the wallet-server process from MCP_ENV_FILE (names only, never values). */
  envKeys: string[]
}

let singleton: Promise<McpBridge> | undefined

/** Lazily start (once) the MCP server process for this process lifetime. */
export function getMcpBridge(cfg: Config): Promise<McpBridge> {
  singleton ??= startBridge(cfg)
  return singleton
}

/** Tests / shutdown. */
export async function closeMcpBridge(): Promise<void> {
  const pending = singleton
  singleton = undefined
  if (pending) {
    try {
      const bridge = await pending
      await bridge.client.stop()
    } catch {
      // never started successfully — nothing to stop
    }
  }
}

async function startBridge(cfg: Config): Promise<McpBridge> {
  // Belt and suspenders: the wallet server has no reason to exist in dry-run.
  // (Dry-run never routes swap_execute to MCP either — see swap.ts.)
  if (cfg.dryRun) throw new Error('refusing to start MCP wallet server in dry-run mode')
  if (cfg.mcp.command === undefined) {
    throw new Error('MCP_COMMAND is required for the wallet lane (e.g. npx -y @coinbase/cdp-mcp-server)')
  }
  if (cfg.mcp.allowedTools.length === 0) {
    throw new Error(
      'MCP_ALLOWED_TOOLS is required and deny-by-default: name the exact server tools the desk may use ' +
        '(e.g. get_balance,get_wallet_address,swap). Nothing is registered without an explicit allowlist.',
    )
  }

  // Keys reach the wallet server through MCP_ENV_FILE, merged OVER process.env —
  // the desk process's own .env never needs to contain them.
  const env = cfg.mcp.envFile ? parseEnvFile(cfg.mcp.envFile) : {}
  const envKeys = Object.keys(env)
  const client = new McpClient({ command: cfg.mcp.command, args: cfg.mcp.args, env })
  await client.start()
  const tools = await client.listTools()

  const allow = new Set(cfg.mcp.allowedTools)
  const registered: string[] = []
  const skipped: string[] = []
  const specs: McpBridge['specs'] = []
  for (const t of tools) {
    if (!allow.has(t.name)) {
      skipped.push(t.name)
      continue
    }
    const danger = isDangerousMcpName(t.name) ? 'trade' : 'readonly'
    const name = `mcp_${t.name}`
    registered.push(name)
    specs.push({
      name,
      description: `[via MCP wallet server] ${t.description ?? t.name}. Arguments are passed to the server verbatim.`,
      // The server owns validation against its own JSON Schema; the desk only
      // requires *some* object so the LLM can't smuggle non-object payloads.
      input: z.record(z.string(), z.unknown()),
      danger,
      execute: async (input, _ctx) => {
        // Tool errors (server-reported or transport) become [error] tool
        // results the LLM can react to — never a thrown crash mid-run.
        try {
          const res = await client.callTool(t.name, input)
          if (res.isError) return { text: `[error] mcp_${t.name} failed: ${res.text || 'server reported error'}` }
          return { text: res.text }
        } catch (e) {
          return { text: `[error] mcp_${t.name} failed: ${e instanceof Error ? e.message : String(e)}` }
        }
      },
    })
  }
  log.info(`mcp bridge: ${registered.length} allowed tool(s) registered, ${skipped.length} skipped`)
  return { client, registered, skipped, specs, envKeys }
}

export async function registerMcpTools(registry: ToolRegistry, cfg: Config): Promise<McpBridge> {
  const bridge = await getMcpBridge(cfg)
  registry.register(...bridge.specs)
  return bridge
}

/**
 * Parse AgentKit's get_balance reply: `Balance of <name> (<addr>) at address
 * <addr> is <formatted>` — the balance is the number AFTER the `is`, which
 * anchors it against the wallet/token addresses and the desk's own `[units]`
 * metadata note (whose example "6" = 6 USDC otherwise parses as the balance —
 * caught by the reconciler's first live run, 2026-09-03).
 * Errors ("Error: Could not fetch…") and unparseable text → undefined.
 */
export function parseBalanceText(text: string): number | undefined {
  if (/^Error:/i.test(text.trim())) return undefined
  const anchored = [...text.matchAll(/\bis\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|$)/g)]
  const last = anchored.at(-1)?.[1]
  if (last === undefined) {
    // Fallback for a reply shape that drifts from the `is <balance>` format:
    // last number OUTSIDE bracketed metadata lines.
    const stripped = text.replace(/\[[^\]]*\][^\n]*/g, '')
    const fallback = [...stripped.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].at(-1)?.[0]
    if (fallback === undefined) return undefined
    const n = Number(fallback)
    return Number.isFinite(n) ? n : undefined
  }
  const n = Number(last)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Read a token balance through the wallet server (FORMATTED human units —
 * the same units-note discipline the LLM tools get). Returns undefined when
 * the balance tool isn't allowlisted or the server can't answer — callers
 * must treat that as inconclusive, never as zero.
 */
export async function mcpReadTokenBalance(cfg: Config, tokenAddress: string): Promise<number | undefined> {
  try {
    const bridge = await getMcpBridge(cfg)
    const name = bridge.registered.find((r) => r === 'mcp_ERC20ActionProvider_get_balance')
    if (name === undefined) {
      log.warn('wallet lane balance read unavailable — ERC20ActionProvider_get_balance not allowlisted')
      return undefined
    }
    const res = await bridge.client.callTool('ERC20ActionProvider_get_balance', { tokenAddress })
    if (res.isError) return undefined
    return parseBalanceText(res.text)
  } catch (e) {
    log.warn(`wallet lane balance read failed: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

export type McpSwapOk = {
  success: true
  transactionHash?: string
  approvalTxHash?: string
  /** Server-side quoted output, formatted human units — closer to the truth than our reference-price estimate. */
  toAmount?: string
  /** Guaranteed minimum output (quote minus slippage) — the honest floor. */
  minToAmount?: string
  fromAmount?: string
  network?: string
}

/** Parse a successful AgentKit swap payload; anything else → undefined. */
export function parseSwapOk(text: string): McpSwapOk | undefined {
  try {
    const parsed = JSON.parse(text) as McpSwapOk
    return parsed.success === true ? parsed : undefined
  } catch {
    return undefined
  }
}

export type McpSwapInput = {
  fromAmount: number
  fromSymbol: string
  toSymbol: string
  fromTokenAddress?: string
  toTokenAddress?: string
  expectedToAmount: number
  slippageBps?: number
  rationale: string
}

/**
 * Verified onchain (eth_call name()) on Base — the ONLY symbols mcpExecuteSwap
 * will resolve from a ticker. Anything else must come with its contract
 * address; the desk never guesses an asset. ETH is deliberately absent: CDP
 * swaps are ERC-20→ERC-20, and silently substituting WETH for ETH would lie
 * to the ledger — the caller must supply the WETH address explicitly.
 */
export const BASE_TOKENS: Record<string, string> = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USD Coin
  WETH: '0x4200000000000000000000000000000000000006', // Wrapped Ether
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // Coinbase Wrapped BTC
}

/**
 * swap_execute backend 'mcp': call the server's swap tool. Argument schema is
 * AgentKit's verified SwapSchema: { fromToken: address, toToken: address,
 * fromAmount: string (whole units), slippageBps?: int (default 100 = 1%) }.
 */
export async function mcpExecuteSwap(
  cfg: Config,
  input: McpSwapInput,
): Promise<{ ok: true; text: string; parsed?: McpSwapOk } | { ok: false; error: string }> {
  // The Cobo lane has no native swap tool — onchain swaps there mean
  // contract_call to a DEX router, and that surface is deliberately NOT
  // exposed on the desk lane yet (no router wired, no calldata encoder).
  // Swaps stay on the coinbase-mcp lane; Cobo handles transfer/observe/pacts.
  if (cfg.executionMode === 'cobo-mcp') {
    return {
      ok: false,
      error:
        'cobo lane: no native swap tool. Onchain swaps there go through contract_call to a DEX router, ' +
        'which is not wired into the desk lane yet. Use transfer_tokens for moving funds; swaps stay on the coinbase-mcp lane.',
    }
  }
  const resolveToken = (symbol: string, address: string | undefined, side: string): string | { error: string } => {
    if (address && address.startsWith('0x')) return address
    const known = BASE_TOKENS[symbol.toUpperCase()]
    if (known) return known
    return {
      error:
        `cannot execute swap: ${side} '${symbol}' has no contract address and is not a verified desk major ` +
        `(USDC/WETH/CBBTC). Resolve it first and supply its address — the desk never guesses an asset.`,
    }
  }
  const from = resolveToken(input.fromSymbol, input.fromTokenAddress, 'fromToken')
  if (typeof from !== 'string') return { ok: false, error: from.error }
  const to = resolveToken(input.toSymbol, input.toTokenAddress, 'toToken')
  if (typeof to !== 'string') return { ok: false, error: to.error }
  if (from.toLowerCase() === to.toLowerCase()) return { ok: false, error: 'refusing: fromToken === toToken' }

  const args = {
    fromToken: from,
    toToken: to,
    fromAmount: String(input.fromAmount),
    slippageBps: input.slippageBps ?? 100,
  }

  const bridge = await getMcpBridge(cfg)
  try {
    const res = await bridge.client.callTool(cfg.mcp.swapTool, args)
    if (res.isError) return { ok: false, error: res.text || 'server reported error' }
    // AgentKit actions return SOME failures as plain content, not isError —
    // the swap action's network gate answers {"success":false,"error":…} with
    // no error flag. Reading that as success booked a PHANTOM ledger entry
    // live (2026-09-03): no funds moved, ledger said WETH open @ $2,403.85.
    // Trust the payload, not just the transport flag.
    try {
      const parsed = JSON.parse(res.text) as { success?: boolean; error?: string }
      if (parsed.success === false) return { ok: false, error: parsed.error ?? res.text }
    } catch {
      // not JSON — plain-text result path
    }
    return { ok: true, text: res.text, parsed: parseSwapOk(res.text) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
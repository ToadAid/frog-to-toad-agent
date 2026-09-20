import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'node:path'
import { registerMcpTools, closeMcpBridge, isDangerousMcpName, mcpExecuteSwap, parseEnvFile, BASE_TOKENS } from '../src/mcp/bridge.js'
import { McpClient } from '../src/mcp/client.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { Config } from '../src/config.js'

const SERVER = join(import.meta.dirname, 'helpers', 'mockMcpServer.mjs')

function cfg(overrides: Partial<Pick<Config, 'dryRun'> & { mcp: Partial<Config['mcp']> }> = {}): Config {
  return {
    dryRun: overrides.dryRun ?? false,
    mcp: {
      command: process.execPath,
      args: [SERVER],
      allowedTools: ['echo', 'swap'],
      swapTool: 'swap',
      ...overrides.mcp,
    },
  } as unknown as Config
}

const noopCtx = { cfg: {} } as never

/** Start the bridge with the mock server, but intercept callTool to capture exact args. */
async function swapCalls(): Promise<{ mockCalls: () => Array<{ name: string; arguments: unknown }> }> {
  const calls: Array<{ name: string; arguments: unknown }> = []
  vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    calls.push({ name, arguments: args })
    return { isError: false, text: `traded:${JSON.stringify(args)}` }
  })
  await registerMcpTools(new ToolRegistry(), cfg())
  return { mockCalls: () => calls }
}

/** Assert a refusal and return its error text. */
function expectFail(res: { ok: true; text: string } | { ok: false; error: string }): string {
  if (res.ok) throw new Error('expected refusal, got ok')
  return res.error
}

afterEach(async () => {
  vi.restoreAllMocks()
  await closeMcpBridge()
})

describe('MCP bridge — deny-by-default wallet lane', () => {
  it('refuses to spawn a wallet server in dry-run', async () => {
    await expect(registerMcpTools(new ToolRegistry(), cfg({ dryRun: true }))).rejects.toThrow(/dry-run/)
  })

  it('refuses an empty allowlist — nothing registers without an explicit list', async () => {
    await expect(
      registerMcpTools(new ToolRegistry(), cfg({ mcp: { allowedTools: [] } })),
    ).rejects.toThrow(/MCP_ALLOWED_TOOLS/)
  })

  it('registers ONLY allowlisted tools, mcp_-prefixed, danger-mapped', async () => {
    const registry = new ToolRegistry()
    const bridge = await registerMcpTools(registry, cfg())
    // Mock server has echo, slow_echo, fling, swap — only echo+swap allowed.
    expect(bridge.registered.sort()).toEqual(['mcp_echo', 'mcp_swap'])
    expect(bridge.skipped.sort()).toEqual(['fling', 'slow_echo'])

    expect(registry.get('mcp_echo')?.danger).toBe('readonly')
    expect(registry.get('mcp_swap')?.danger).toBe('trade')
    // Never shadows a desk tool name.
    expect(registry.get('echo')).toBeUndefined()
  })

  it('routes execute through the server and flattens text', async () => {
    const registry = new ToolRegistry()
    await registerMcpTools(registry, cfg())
    const res = await registry.get('mcp_echo')!.execute({ hello: 'desk' }, noopCtx)
    expect(res.text).toBe('echo:{"hello":"desk"}')
    const swap = await registry.get('mcp_swap')!.execute({ x: 1 }, noopCtx)
    expect(swap.text).toBe('traded:{"x":1}')
  })

  it('surfaces a server tool error as [error] text, not a crash', async () => {
    const registry = new ToolRegistry()
    await registerMcpTools(registry, cfg({ mcp: { allowedTools: ['fling'] } }))
    const res = await registry.get('mcp_fling')!.execute({}, noopCtx)
    expect(res.text).toContain('[error] mcp_fling failed')
    expect(res.text).toContain('flung')
  })
})

describe('mcpExecuteSwap — exact AgentKit SwapSchema mapping', () => {
  const base = {
    fromAmount: 10,
    toSymbol: 'WETH',
    expectedToAmount: 0.004,
    rationale: 'test',
  }

  it('maps to {fromToken, toToken, fromAmount: string, slippageBps} with verified majors', async () => {
    const { mockCalls } = await swapCalls()
    await mcpExecuteSwap(cfg(), { ...base, fromSymbol: 'USDC', slippageBps: 50 })
    expect(mockCalls()).toEqual([
      {
        name: 'swap',
        arguments: {
          fromToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          toToken: '0x4200000000000000000000000000000000000006',
          fromAmount: '10',
          slippageBps: 50,
        },
      },
    ])
  })

  it('defaults slippageBps to 100 (1%)', async () => {
    const { mockCalls } = await swapCalls()
    await mcpExecuteSwap(cfg(), { ...base, fromSymbol: 'USDC' })
    expect(mockCalls()[0]?.arguments).toMatchObject({ slippageBps: 100 })
  })

  it('refuses an unknown ticker with no address — never guesses an asset', async () => {
    const { mockCalls } = await swapCalls()
    const res = await mcpExecuteSwap(cfg(), { ...base, fromSymbol: 'PEPE' })
    expect(expectFail(res)).toContain('no contract address')
    expect(mockCalls()).toEqual([])
  })

  it('accepts an explicit address for a non-major', async () => {
    const { mockCalls } = await swapCalls()
    const res = await mcpExecuteSwap(cfg(), {
      ...base,
      fromSymbol: 'USDC',
      toSymbol: 'MOG',
      toTokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(res.ok).toBe(true)
    expect(mockCalls()[0]?.arguments).toMatchObject({
      toToken: '0x1234567890abcdef1234567890abcdef12345678',
    })
  })

  it('refuses ETH without an address — never silently substitutes WETH', async () => {
    const { mockCalls } = await swapCalls()
    const res = await mcpExecuteSwap(cfg(), { ...base, fromSymbol: 'USDC', toSymbol: 'ETH' })
    expect(expectFail(res)).toContain('verified desk major')
    expect(mockCalls()).toEqual([])
  })

  it('refuses fromToken === toToken', async () => {
    const { mockCalls } = await swapCalls()
    const res = await mcpExecuteSwap(cfg(), { ...base, fromSymbol: 'USDC', toSymbol: 'USDC' })
    expect(expectFail(res)).toContain('fromToken === toToken')
    expect(mockCalls()).toEqual([])
  })

  it('reads AgentKit plain-content failures as failures (the phantom-ledger fix)', async () => {
    // The swap action's network gate returns {"success":false,"error":…} as
    // NORMAL content with no MCP isError flag. Trusting the transport flag
    // alone booked a phantom ledger entry live (2026-09-03): no funds moved,
    // ledger said WETH open @ $2,403.85. The payload, not the flag, decides.
    vi.spyOn(McpClient.prototype, 'callTool').mockResolvedValue({
      isError: false,
      text: JSON.stringify({
        success: false,
        error: "CDP Swap API is currently only supported on 'base-mainnet' or 'ethereum-mainnet'.",
      }),
    })
    await registerMcpTools(new ToolRegistry(), cfg())
    const res = await mcpExecuteSwap(cfg(), { ...base, fromSymbol: 'USDC' })
    expect(expectFail(res)).toContain('base-mainnet')
  })

  it('keeps the verified Base majors honest', () => {
    expect(BASE_TOKENS.USDC).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
    expect(BASE_TOKENS.WETH).toBe('0x4200000000000000000000000000000000000006')
    expect(BASE_TOKENS.CBBTC).toBe('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf')
    expect(BASE_TOKENS.ETH).toBeUndefined()
  })
})

describe('MCP danger classification', () => {
  it('maps money-touching names to trade, everything else to readonly', () => {
    for (const n of ['swap', 'trade', 'send_token', 'deposit', 'wrap_eth', 'approve', 'create_wallet']) {
      expect(isDangerousMcpName(n)).toBe(true)
    }
    for (const n of ['get_balance', 'list_wallets', 'echo', 'get_price', 'health']) {
      expect(isDangerousMcpName(n)).toBe(false)
    }
  })
})

describe('MCP env file — keys reach the wallet server without entering desk .env', () => {
  it('parses KEY=VALUE lines, skips comments/blank/quote-wrapped values', () => {
    const file = join(import.meta.dirname, 'helpers', 'envFileFixture.env')
    const env = parseEnvFile(file)
    expect(env).toEqual({ AGENT_WALLET_API_KEY: 'secret-value', PLAIN: '1.5' })
  })

  it('injects env-file vars into the wallet-server spawn (names visible, values never)', async () => {
    const file = join(import.meta.dirname, 'helpers', 'envFileFixture.env')
    const registry = new ToolRegistry()
    const bridge = await registerMcpTools(registry, cfg({ mcp: { envFile: file } }))
    expect(bridge.envKeys.sort()).toEqual(['AGENT_WALLET_API_KEY', 'PLAIN'])
  })
})

describe('cobo-mcp backend', () => {
  const coboCfg = (): Config =>
    ({
      dryRun: false,
      executionMode: 'cobo-mcp',
      mcp: { command: process.execPath, args: [SERVER], allowedTools: ['get_balance'], swapTool: 'swap' },
    }) as unknown as Config

  it('refuses swap_execute honestly — no native swap tool, no router wired', async () => {
    const res = await mcpExecuteSwap(coboCfg(), {
      fromAmount: 10,
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      expectedToAmount: 0.004,
      rationale: 'test',
    })
    expect(expectFail(res)).toContain('no native swap tool')
  })
})
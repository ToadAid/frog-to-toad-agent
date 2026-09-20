import { describe, it, expect, afterEach } from 'vitest'
import { deskRoot, loadConfig, WALLET_BACKENDS } from '../src/config.js'

function withEnv(env: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const realMode = {
  DRY_RUN: 'false',
  SELFTEST: '1', // skip token/API-key checks — this test is about the gate only
  MCP_COMMAND: 'echo',
  MCP_ALLOWED_TOOLS: 'get_balance',
  TRADING_DESK_DIR: import.meta.dirname,
}

describe('the wallet gate — real mode requires an MCP backend', () => {
  afterEach(() => {
    delete process.env.DRY_RUN
    delete process.env.EXECUTION_MODE
    delete process.env.SELFTEST
    delete process.env.MCP_COMMAND
    delete process.env.MCP_ALLOWED_TOOLS
    delete process.env.FROG_TO_TOAD_DIR
    delete process.env.TRADING_DESK_DIR
  })

  it('prefers the public root override while retaining the donor alias', () => {
    withEnv({ FROG_TO_TOAD_DIR: '/public/root', TRADING_DESK_DIR: '/legacy/root' }, () => {
      expect(deskRoot()).toBe('/public/root')
    })
    withEnv({ TRADING_DESK_DIR: '/legacy/root' }, () => {
      delete process.env.FROG_TO_TOAD_DIR
      expect(deskRoot()).toBe('/legacy/root')
    })
  })

  it('accepts coinbase-mcp and cobo-mcp as real-mode backends', () => {
    expect(WALLET_BACKENDS).toContain('coinbase-mcp')
    expect(WALLET_BACKENDS).toContain('cobo-mcp')
    for (const mode of WALLET_BACKENDS) {
      withEnv({ ...realMode, EXECUTION_MODE: mode }, () => {
        expect(() => loadConfig()).not.toThrow()
      })
    }
  })

  it('refuses real mode with no backend', () => {
    withEnv({ ...realMode, EXECUTION_MODE: 'none' }, () => {
      expect(() => loadConfig()).toThrow(/requires EXECUTION_MODE=coinbase-mcp or cobo-mcp/)
    })
  })

  it('refuses real mode without MCP_COMMAND or an allowlist', () => {
    withEnv({ DRY_RUN: 'false', SELFTEST: '1', EXECUTION_MODE: 'cobo-mcp', MCP_ALLOWED_TOOLS: 'get_balance' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_COMMAND/)
    })
    withEnv({ DRY_RUN: 'false', SELFTEST: '1', EXECUTION_MODE: 'cobo-mcp', MCP_COMMAND: 'x' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_ALLOWED_TOOLS/)
    })
  })

  it('dry-run boots with any execution mode — the wallet server is never spawned', () => {
    withEnv({ DRY_RUN: 'true', SELFTEST: '1', EXECUTION_MODE: 'cobo-mcp' }, () => {
      const cfg = loadConfig()
      expect(cfg.dryRun).toBe(true)
    })
  })

  it('GUARDED_TOOLS (.env) overrides config.json — the full-hands operational gate lives in .env', () => {
    withEnv({ DRY_RUN: 'true', SELFTEST: '1', GUARDED_TOOLS: 'swap_execute, mcp_ERC20ActionProvider_transfer' }, () => {
      expect(loadConfig().guardedTools).toEqual(['swap_execute', 'mcp_ERC20ActionProvider_transfer'])
    })
    withEnv({ DRY_RUN: 'true', SELFTEST: '1', GUARDED_TOOLS: '  ,  ' }, () => {
      // empty/whitespace = unset → the config.json default stands
      expect(loadConfig().guardedTools).toEqual(['swap_execute'])
    })
  })
})

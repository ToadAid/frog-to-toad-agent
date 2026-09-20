import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { loadConfig, type Config } from '../src/config.js'
import { allowsAutonomousDryRunTrade } from '../src/safety/autonomousDryRun.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { createMockLlmClient } from '../src/llm/mock.js'
import { startRun } from '../src/loop/agentLoop.js'
import { createNullSender } from '../src/telegram/bot.js'
import { defineTool, ToolRegistry } from '../src/tools/registry.js'
import type { ApprovalDecision, RunEvent } from '../src/types.js'

const ENV_KEYS = [
  'TRADING_DESK_DIR',
  'SELFTEST',
  'DRY_RUN',
  'AUTONOMOUS_DRY_RUN',
  'APPRENTICESHIP_SEED_USD',
  'EXECUTION_MODE',
] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

afterEach(() => {
  for (const k of ENV_KEYS) {
    const value = saved[k]
    if (value === undefined) delete process.env[k]
    else process.env[k] = value
  }
})

describe('Frog-to-Toad A0 autonomous apprenticeship boundary', () => {
  it('requires every condition: opt-in + dry-run + exact swap_execute + trade danger', () => {
    const cfg = { autonomousDryRun: true, dryRun: true } as unknown as Config
    expect(allowsAutonomousDryRunTrade(cfg, { name: 'swap_execute', danger: 'trade' })).toBe(true)
    expect(allowsAutonomousDryRunTrade({ ...cfg, autonomousDryRun: false }, { name: 'swap_execute', danger: 'trade' })).toBe(false)
    expect(allowsAutonomousDryRunTrade({ ...cfg, dryRun: false }, { name: 'swap_execute', danger: 'trade' })).toBe(false)
    expect(allowsAutonomousDryRunTrade(cfg, { name: 'wallet_transfer', danger: 'trade' })).toBe(false)
    expect(allowsAutonomousDryRunTrade(cfg, { name: 'swap_execute', danger: 'write' })).toBe(false)
  })

  it('defaults autonomous mode OFF', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a0-'))
    try {
      process.env['TRADING_DESK_DIR'] = dir
      process.env['SELFTEST'] = '1'
      process.env['DRY_RUN'] = 'true'
      delete process.env['AUTONOMOUS_DRY_RUN']
      const cfg = loadConfig()
      expect(cfg.autonomousDryRun).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requires an explicit principal-granted seed before autonomous dry-run may boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a1-seed-'))
    try {
      process.env['TRADING_DESK_DIR'] = dir
      process.env['SELFTEST'] = '1'
      process.env['DRY_RUN'] = 'true'
      process.env['AUTONOMOUS_DRY_RUN'] = 'true'
      delete process.env['APPRENTICESHIP_SEED_USD']
      expect(() => loadConfig()).toThrow(/requires APPRENTICESHIP_SEED_USD/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a positive finite apprenticeship seed and carries it into Config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a1-seed-ok-'))
    try {
      process.env['TRADING_DESK_DIR'] = dir
      process.env['SELFTEST'] = '1'
      process.env['DRY_RUN'] = 'true'
      process.env['AUTONOMOUS_DRY_RUN'] = 'true'
      process.env['APPRENTICESHIP_SEED_USD'] = '150'
      expect(loadConfig().apprenticeshipSeedUsd).toBe(150)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses malformed, zero, or negative apprenticeship seed grants', () => {
    for (const raw of ['nope', '0', '-1', 'Infinity']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a1-seed-bad-'))
      try {
        process.env['TRADING_DESK_DIR'] = dir
        process.env['SELFTEST'] = '1'
        process.env['DRY_RUN'] = 'true'
        process.env['AUTONOMOUS_DRY_RUN'] = 'true'
        process.env['APPRENTICESHIP_SEED_USD'] = raw
        expect(() => loadConfig()).toThrow(/APPRENTICESHIP_SEED_USD must be a positive finite/)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('refuses to boot if autonomous approval is combined with live mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a0-live-'))
    try {
      process.env['TRADING_DESK_DIR'] = dir
      process.env['SELFTEST'] = '1'
      process.env['DRY_RUN'] = 'false'
      process.env['AUTONOMOUS_DRY_RUN'] = 'true'
      process.env['EXECUTION_MODE'] = 'none'
      expect(() => loadConfig()).toThrow(/AUTONOMOUS_DRY_RUN=true requires DRY_RUN=true/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips only the human card for autonomous DRY_RUN swap_execute while preserving approval audit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a0-loop-'))
    try {
      process.env['TRADING_DESK_DIR'] = dir
      process.env['SELFTEST'] = '1'
      process.env['DRY_RUN'] = 'true'
      process.env['AUTONOMOUS_DRY_RUN'] = 'true'
      process.env['APPRENTICESHIP_SEED_USD'] = '150'
      const cfg = loadConfig()
      const decisions: ApprovalDecision[] = []
      let cards = 0
      let executions = 0
      const toolRegistry = new ToolRegistry()
      toolRegistry.register(defineTool({
        name: 'swap_execute',
        description: 'test simulated swap executor',
        danger: 'trade',
        input: z.object({}),
        onApprovalDecision: async (_input, decision) => {
          decisions.push(decision)
        },
        execute: async () => {
          executions++
          return { text: 'simulated swap complete' }
        },
      }))
      const agentRegistry = new AgentRegistry(new Map([
        ['orchestrator', { name: 'orchestrator', emoji: '🎯', description: 'test', maxTurns: 2, systemPrompt: 'x' }],
      ]))
      const handle = startRun({
        cfg,
        agentRegistry,
        toolRegistry,
        llm: createMockLlmClient([
          { toolCalls: [{ id: 'swap-1', name: 'swap_execute', arguments: '{}' }] },
          { text: 'done' },
        ]),
        send: createNullSender(),
        chatId: 246980001,
        agentName: 'orchestrator',
        userText: 'run one simulation',
        actor: { source: 'principal_operator', displayName: 'Principal operator' },
        approvalGate: async () => {
          cards++
          return 'deny'
        },
      })

      await handle.done
      expect(cards).toBe(0)
      expect(decisions).toEqual(['allow'])
      expect(executions).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when the autonomous approval audit hook fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a0-audit-'))
    try {
      process.env['TRADING_DESK_DIR'] = dir
      process.env['SELFTEST'] = '1'
      process.env['DRY_RUN'] = 'true'
      process.env['AUTONOMOUS_DRY_RUN'] = 'true'
      process.env['APPRENTICESHIP_SEED_USD'] = '150'
      const cfg = loadConfig()
      let executions = 0
      const events: RunEvent[] = []
      const toolRegistry = new ToolRegistry()
      toolRegistry.register(defineTool({
        name: 'swap_execute',
        description: 'test simulated swap executor',
        danger: 'trade',
        input: z.object({}),
        onApprovalDecision: async () => {
          throw new Error('audit store unavailable')
        },
        execute: async () => {
          executions++
          return { text: 'must not execute' }
        },
      }))
      const agentRegistry = new AgentRegistry(new Map([
        ['orchestrator', { name: 'orchestrator', emoji: '🎯', description: 'test', maxTurns: 2, systemPrompt: 'x' }],
      ]))
      const handle = startRun({
        cfg,
        agentRegistry,
        toolRegistry,
        llm: createMockLlmClient([
          { toolCalls: [{ id: 'swap-2', name: 'swap_execute', arguments: '{}' }] },
          { text: 'stopped' },
        ]),
        send: createNullSender(),
        chatId: 246980002,
        agentName: 'orchestrator',
        userText: 'run one simulation',
        actor: { source: 'principal_operator', displayName: 'Principal operator' },
        approvalGate: async () => 'allow',
        onEvent: (event) => events.push(event),
      })

      await handle.done
      expect(executions).toBe(0)
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', tool: 'swap_execute', ok: false }))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

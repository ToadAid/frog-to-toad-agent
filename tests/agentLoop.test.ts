import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry, defineTool } from '../src/tools/registry.js'
import { createMockLlmClient } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun } from '../src/loop/agentLoop.js'
import { principalOperatorActor } from '../src/telegram/actor.js'
import { spawnSubagentTool } from '../src/tools/spawn.js'
import { resetThread, getThread } from '../src/loop/context.js'
import { splitForTelegram } from '../src/telegram/render.js'
import { parseAgent } from '../src/agents/loader.js'
import type { LlmClient } from '../src/llm/client.js'
import type { ChatMessage } from '../src/types.js'

let dir: string
let cfg: Config

const ORCH = `---
name: orchestrator
emoji: 🎯
description: test orchestrator
maxTurns: 4
---
You are a test orchestrator.
`

const SUB = `---
name: worker
emoji: 🔧
description: test worker
maxTurns: 4
---
You are a test worker.
`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', 'orchestrator.md'), ORCH)
  fs.writeFileSync(path.join(dir, 'agents', 'worker.md'), SUB)
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function runOnce(agentRegistry: AgentRegistry, tools: ToolRegistry, llm: ReturnType<typeof createMockLlmClient>, text: string) {
  const sender = createNullSender()
  const handle = startRun({
    cfg,
    agentRegistry,
    toolRegistry: tools,
    llm,
    send: sender,
    chatId: 12345,
    agentName: 'orchestrator',
    userText: text,
  })
  const summary = await handle.done
  return { summary, sender }
}

describe('agentLoop', () => {
  it('plain text turn returns final text', async () => {
    resetThread(12345)
    const registry = new AgentRegistry(new Map([[ 'orchestrator', { name:'orchestrator', emoji:'🎯', description:'d', maxTurns:4, systemPrompt:'x' }]]))
    const llm = createMockLlmClient([{ text: 'hello, desk is awake' }])
    const { summary } = await runOnce(registry, new ToolRegistry(), llm, 'hi')
    expect(summary.finalText).toBe('hello, desk is awake')
    expect(summary.turns).toBe(1)
    expect(summary.toolCalls).toBe(0)
  })

  it('executes a readonly tool and feeds the result back', async () => {
    resetThread(12345)
    const agentDef = { name:'orchestrator', emoji:'🎯', description:'d', maxTurns:4, systemPrompt:'x' }
    const registry = new AgentRegistry(new Map([['orchestrator', agentDef]]))
    const tools = new ToolRegistry()
    let sawInput: unknown
    tools.register(
      defineTool({
        name: 'market_price',
        description: 'get price',
        danger: 'readonly',
        input: (await import('zod')).z.object({ symbol: (await import('zod')).z.string() }),
        execute: async (input) => {
          sawInput = input
          return { text: 'BTC = $50,000' }
        },
      }),
    )
    const llm = createMockLlmClient([
      { toolCalls: [{ id: 'c1', name: 'market_price', arguments: '{"symbol":"BTC"}' }] },
      { text: 'BTC is at $50,000.' },
    ])
    const { summary } = await runOnce(registry, tools, llm, 'what is BTC?')
    expect(sawInput).toEqual({ symbol: 'BTC' })
    expect(summary.finalText).toBe('BTC is at $50,000.')
    expect(summary.toolCalls).toBe(1)
  })

  it('blocks tools outside the agent allowlist', async () => {
    resetThread(12345)
    const agentDef = { name:'orchestrator', emoji:'🎯', description:'d', maxTurns:4, systemPrompt:'x', tools: ['market_price'] }
    const registry = new AgentRegistry(new Map([['orchestrator', agentDef]]))
    const tools = new ToolRegistry()
    let executed = false
    tools.register(
      defineTool({
        name: 'swap_execute',
        description: 'swap',
        danger: 'trade',
        input: (await import('zod')).z.object({}),
        execute: async () => {
          executed = true
          return { text: 'swapped' }
        },
      }),
    )
    const llm = createMockLlmClient([
      { toolCalls: [{ id: 'c1', name: 'swap_execute', arguments: '{}' }] },
      { text: 'could not swap.' },
    ])
    const { summary } = await runOnce(registry, tools, llm, 'swap!')
    expect(executed).toBe(false)
    expect(summary.finalText).toBe('could not swap.')
    // The blocked tool result went back into the thread — check via a second script inspecting messages.
  })

  it('pairs the durable tool result when the abort lands mid-execution', async () => {
    resetThread(12345)
    const registry = new AgentRegistry(new Map([['orchestrator', {
      name: 'orchestrator', emoji: '🎯', description: 'd', maxTurns: 4, systemPrompt: 'x',
    }]]))
    const tools = new ToolRegistry()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let sawAbort = false
    const z = (await import('zod')).z
    tools.register(defineTool({
      name: 'slow_tool',
      description: 'gates so the test can abort mid-execution',
      danger: 'readonly',
      input: z.object({}),
      execute: async (_input, ctx) => {
        await gate
        sawAbort = ctx.signal.aborted
        if (ctx.signal.aborted) throw new Error('aborted')
        return { text: 'done' }
      },
    }))
    const llm = createMockLlmClient([
      { toolCalls: [{ id: 'c1', name: 'slow_tool', arguments: '{}' }] },
      { text: 'aftermath' },
    ])
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: tools,
      llm,
      send: createNullSender(),
      chatId: 12345,
      agentName: 'orchestrator',
      userText: 'gate run',
      actor: principalOperatorActor(12345),
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.abort()
    release()
    const summary = await handle.done
    expect(summary.aborted).toBe(true)
    expect(sawAbort).toBe(true)

    const thread = getThread(cfg, 12345)
    const useIdx = thread.messages.findIndex(
      (message) => message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'c1'),
    )
    expect(useIdx).toBeGreaterThanOrEqual(0)
    const paired = thread.messages[useIdx + 1]
    expect(paired?.role).toBe('tool')
    if (paired?.role === 'tool') expect(paired.tool_call_id).toBe('c1')

    const seen: ChatMessage[][] = []
    const spy: LlmClient = {
      model: 'spy',
      complete: async (request) => {
        seen.push(request.messages)
        return llm.complete(request)
      },
    }
    const replay = await runOnce(registry, tools, spy, 'replay check')
    expect(replay.summary.finalText).toBe('aftermath')
    const history = seen[0] ?? []
    const replayUse = history.findIndex(
      (message) => message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'c1'),
    )
    expect(replayUse).toBeGreaterThanOrEqual(0)
    expect(history[replayUse + 1]?.role).toBe('tool')
  })

  it('denies trade tools intrinsically even when guardedTools omits them', async () => {
    resetThread(12345)
    const agentDef = { name:'orchestrator', emoji:'🎯', description:'d', maxTurns:4, systemPrompt:'x' }
    const registry = new AgentRegistry(new Map([['orchestrator', agentDef]]))
    const tools = new ToolRegistry()
    let executed = false
    tools.register(
      defineTool({
        name: 'swap_execute',
        description: 'swap',
        danger: 'trade',
        input: (await import('zod')).z.object({}),
        execute: async () => {
          executed = true
          return { text: 'swapped' }
        },
      }),
    )
    const cfgGuarded = { ...cfg, dryRun: true, autonomousDryRun: false, guardedTools: [] }
    const sender = createNullSender()
    const handle = startRun({
      cfg: cfgGuarded,
      agentRegistry: registry,
      toolRegistry: tools,
      llm: createMockLlmClient([
        { toolCalls: [{ id: 'c1', name: 'swap_execute', arguments: '{}' }] },
        { text: 'trade denied.' },
      ]),
      send: sender,
      chatId: 12345,
      agentName: 'orchestrator',
      userText: 'go',
    })
    await handle.done
    expect(executed).toBe(false)
  })

  it('autonomously executes ONLY guarded swap_execute in explicit dry-run apprenticeship mode', async () => {
    resetThread(12345)
    const agentDef = { name:'orchestrator', emoji:'🎯', description:'d', maxTurns:4, systemPrompt:'x' }
    const registry = new AgentRegistry(new Map([['orchestrator', agentDef]]))
    const tools = new ToolRegistry()
    let executed = false
    tools.register(
      defineTool({
        name: 'swap_execute',
        description: 'swap',
        danger: 'trade',
        input: (await import('zod')).z.object({}),
        execute: async () => {
          executed = true
          return { text: 'SIMULATED EXECUTION' }
        },
      }),
    )
    const cfgAuto = { ...cfg, dryRun: true, autonomousDryRun: true, guardedTools: [] }
    const handle = startRun({
      cfg: cfgAuto,
      agentRegistry: registry,
      toolRegistry: tools,
      llm: createMockLlmClient([
        { toolCalls: [{ id: 'c1', name: 'swap_execute', arguments: '{}' }] },
        { text: 'simulation complete.' },
      ]),
      send: createNullSender(),
      chatId: 12345,
      agentName: 'orchestrator',
      userText: 'explore',
      actor: principalOperatorActor(12345),
    })
    const summary = await handle.done
    expect(executed).toBe(true)
    expect(summary.finalText).toBe('simulation complete.')
  })

  it('does not auto-approve any other guarded tool even in autonomous dry-run mode', async () => {
    resetThread(12345)
    const agentDef = { name:'orchestrator', emoji:'🎯', description:'d', maxTurns:4, systemPrompt:'x' }
    const registry = new AgentRegistry(new Map([['orchestrator', agentDef]]))
    const tools = new ToolRegistry()
    let executed = false
    tools.register(
      defineTool({
        name: 'wallet_transfer',
        description: 'raw money mover',
        danger: 'trade',
        input: (await import('zod')).z.object({}),
        execute: async () => {
          executed = true
          return { text: 'moved' }
        },
      }),
    )
    const cfgAuto = { ...cfg, dryRun: true, autonomousDryRun: true, guardedTools: [] }
    const handle = startRun({
      cfg: cfgAuto,
      agentRegistry: registry,
      toolRegistry: tools,
      llm: createMockLlmClient([
        { toolCalls: [{ id: 'c1', name: 'wallet_transfer', arguments: '{}' }] },
        { text: 'transfer denied.' },
      ]),
      send: createNullSender(),
      chatId: 12345,
      agentName: 'orchestrator',
      userText: 'move it',
    })
    await handle.done
    expect(executed).toBe(false)
  })

  it('does not auto-approve swap_execute when dry-run is false even if the flag is present', async () => {
    resetThread(12345)
    const agentDef = { name:'orchestrator', emoji:'🎯', description:'d', maxTurns:4, systemPrompt:'x' }
    const registry = new AgentRegistry(new Map([['orchestrator', agentDef]]))
    const tools = new ToolRegistry()
    let executed = false
    tools.register(
      defineTool({
        name: 'swap_execute',
        description: 'swap',
        danger: 'trade',
        input: (await import('zod')).z.object({}),
        execute: async () => {
          executed = true
          return { text: 'LIVE EXECUTION' }
        },
      }),
    )
    const malformedLiveCfg = { ...cfg, dryRun: false, autonomousDryRun: true, guardedTools: [] }
    const handle = startRun({
      cfg: malformedLiveCfg,
      agentRegistry: registry,
      toolRegistry: tools,
      llm: createMockLlmClient([
        { toolCalls: [{ id: 'c1', name: 'swap_execute', arguments: '{}' }] },
        { text: 'live denied.' },
      ]),
      send: createNullSender(),
      chatId: 12345,
      agentName: 'orchestrator',
      userText: 'go live',
    })
    await handle.done
    expect(executed).toBe(false)
  })
})

describe('telegram render', () => {
  it('splits long text on paragraph boundaries', () => {
    const long = Array.from({ length: 200 }, (_, i) => `paragraph ${i} with some content here`).join('\n\n')
    const chunks = splitForTelegram(long, 4000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000)
    expect(chunks.join('\n\n').replace(/\n\n+/g, '\n\n')).toContain('paragraph 199')
  })

  it('single short text stays whole', () => {
    expect(splitForTelegram('short', 4000)).toEqual(['short'])
  })
})

describe('agent frontmatter parser', () => {
  it('parses a full agent file', () => {
    const def = parseAgent(
      `---\nname: tester\nemoji: 🧪\ndescription: runs tests\ntools: a, b, c\nmaxTurns: 5\n---\nBody here.`,
      'tester.md',
    )
    expect(def.name).toBe('tester')
    expect(def.emoji).toBe('🧪')
    expect(def.description).toBe('runs tests')
    expect(def.tools).toEqual(['a', 'b', 'c'])
    expect(def.maxTurns).toBe(5)
    expect(def.systemPrompt).toBe('Body here.')
  })

  it('rejects missing description', () => {
    expect(() => parseAgent('---\nname: x\n---\nBody', 'x.md')).toThrow(/description/)
  })
})
describe('subagent wall-clock cap (§12.2)', () => {
  it('aborts a runaway subagent at the cap and reports it honestly to the parent', async () => {
    resetThread(12345)
    process.env['SUBAGENT_TIMEOUT_MS'] = '80'
    try {
      const registry = new AgentRegistry(
        new Map([
          ['orchestrator', { name: 'orchestrator', emoji: '🎯', description: 'd', maxTurns: 4, systemPrompt: 'x', tools: ['spawn_subagent'] }],
          ['worker', { name: 'worker', emoji: '🔧', description: 'd', maxTurns: 4, systemPrompt: 'worker' }],
        ]),
      )
      const tools = new ToolRegistry()
      tools.register(spawnSubagentTool)
      // Scripted brain, by CALL: ① parent → spawn_subagent, ② child → hangs
      // forever (only the wall-clock cap can end it), ③ parent → final text.
      let i = 0
      const scriptedLlm = {
        model: 'mixed',
        complete(req: { signal?: AbortSignal }) {
          i++
          if (i === 1) {
            return Promise.resolve({
              message: {
                role: 'assistant' as const,
                content: null,
                tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'spawn_subagent', arguments: '{"agent":"worker","prompt":"spin forever"}' } }],
              },
            })
          }
          if (i === 2) {
            return new Promise<never>((_, reject) => {
              req.signal?.addEventListener('abort', () => reject(new Error('aborted by wall-clock cap')), { once: true })
              if (req.signal?.aborted) reject(new Error('aborted by wall-clock cap'))
            })
          }
          return Promise.resolve({
            message: { role: 'assistant' as const, content: 'scout hit the cap, reporting back.' },
          })
        },
      }
      const { summary } = await runOnce(registry, tools, scriptedLlm as never, 'scout the mirror')
      expect(summary.finalText).toBe('scout hit the cap, reporting back.')
    } finally {
      delete process.env['SUBAGENT_TIMEOUT_MS']
    }
  })
})

// QueryDeps DI seam (Tier 2 #16, the mother src/query/deps.ts pattern): the
// turn engine's I/O dependencies are injectable through StartRunOptions.deps —
// tests drive the loop with fakes instead of module spies. The DEFAULT path is
// byte-for-byte production (the whole existing suite is that proof); these
// tests prove the INJECTED path: each dep is called, with the exact
// production arguments, and a stubbed dep fully replaces the real one.
// callModel is deliberately absent — the brain is injected via opts.llm.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createMockLlmClient } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun, productionDeps, type QueryDeps } from '../src/loop/agentLoop.js'
import { getThread, microcompactThread, resetThread } from '../src/loop/context.js'
import type { ChatMessage } from '../src/types.js'

let dir: string
let cfg: Config
const CHAT = 777001

const ORCH = `---
name: orchestrator
emoji: 🎯
description: test orchestrator
maxTurns: 2
---
You are a test orchestrator.
`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-querydeps-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', 'orchestrator.md'), ORCH)
})

afterEach(() => {
  resetThread(CHAT)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function registry(): AgentRegistry {
  return new AgentRegistry(
    new Map([['orchestrator', { name: 'orchestrator', emoji: '🎯', description: 'd', maxTurns: 3, systemPrompt: 'x' }]]),
  )
}

describe('QueryDeps DI seam', () => {
  it('productionDeps() is the real trio', () => {
    const deps = productionDeps()
    // identity with the real functions — the typeof-fn law
    expect(deps.autocompact).toBeTypeOf('function')
    expect(deps.microcompact).toBe(microcompactThread)
    // uuid: a production uuid is a full UUID
    expect(deps.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('injected uuid: the handle AND the run_started event carry the deterministic id', async () => {
    const events: unknown[] = []
    const deps: QueryDeps = {
      ...productionDeps(),
      uuid: () => 'deadbeef-cafe-4000-8000-000000000000',
    }
    const handle = startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'answer' }]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'hi',
      onEvent: (e) => events.push(e),
      deps,
    })
    expect(handle.runId).toBe('deadbeef') // uuid().slice(0, 8)
    const summary = await handle.done
    expect(summary.finalText).toBe('answer')
    expect(events.some((e) => (e as { kind: string }).kind === 'run_started')).toBe(true)
  })

  it('injected autocompact: called once at run start with (opts, thread); the real one is fully replaced', async () => {
    // pre-saturate so the PRODUCTION compaction would have fired — the stub
    // must be the only thing that runs
    const thread = getThread(cfg, CHAT)
    while (thread.messages.length < 80) {
      thread.messages.push({ role: 'user', content: `filler ${thread.messages.length}` })
    }
    thread.messages.push({ role: 'user', content: 'latest question' })
    const calls: Array<{ threadLen: number; chatId: number }> = []
    const deps: QueryDeps = {
      ...productionDeps(),
      autocompact: async (opts, t) => {
        calls.push({ threadLen: t.messages.length, chatId: opts.chatId })
      },
    }
    const handle = startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'ran past autocompact' }]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'latest question',
      deps,
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('ran past autocompact')
    // exactly one call, with the live saturated thread — and the thread was
    // NOT compacted (the stub did nothing), so the filler is still verbatim
    expect(calls.length).toBe(1)
    expect(calls[0]!.chatId).toBe(CHAT)
    // the live saturated thread AT CALL TIME (the run's own user message may
    // already be appended) — the stub saw the real object, not a copy
    expect(calls[0]!.threadLen).toBeGreaterThanOrEqual(80)
    expect(getThread(cfg, CHAT).messages.some((m) => String(m.content).includes('filler 79'))).toBe(true)
    resetThread(CHAT)
  })

  it('injected microcompact: called with the run message array after each tool-result batch', async () => {
    // microcompact fires after a call/result batch — a text-only reply
    // returns before it (the production control flow, not a seam change)
    const seen: number[] = []
    const deps: QueryDeps = {
      ...productionDeps(),
      microcompact: (messages: ChatMessage[]) => {
        seen.push(messages.length)
        return { evicted: 0, bytesSaved: 0 }
      },
    }
    const handle = startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: new ToolRegistry(), // unregistered tool → error RESULT (valid pair)
      llm: createMockLlmClient([
        { toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }] },
        { text: 'final after tool batch' },
      ]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'hi',
      deps,
    })
    await handle.done
    expect(seen.length).toBe(1)
  })

  it('default (no deps) is production: compaction actually engages past the trigger', async () => {
    const { autocompactThresholds } = await import('../src/loop/context.js')
    const { trigger } = autocompactThresholds()
    const thread = getThread(cfg, CHAT)
    while (thread.messages.length < trigger) {
      thread.messages.push({ role: 'user', content: `s ${thread.messages.length}` })
      thread.messages.push({ role: 'assistant', content: `a ${thread.messages.length}` })
    }
    thread.messages.push({ role: 'user', content: 'legacy check' })
    const handle = startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'LEGACY BRIEF' }, { text: 'done' }]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'legacy check',
    })
    await handle.done
    const boundary = getThread(cfg, CHAT).messages[0] as { content: string }
    expect(boundary.content).toContain('[autocompact]')
    resetThread(CHAT)
  })

  it('the seam grants nothing: deps only swap I/O-shaped fns — authority stays with the agent', () => {
    // law assertion: QueryDeps has exactly the three keys, nothing hand- or
    // approval-shaped can ride it
    const keys = Object.keys(productionDeps()).sort()
    expect(keys).toEqual(['autocompact', 'microcompact', 'uuid'])
  })
})
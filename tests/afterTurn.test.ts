// After-turn seam + away summary (PR 4, the mother-repo postSamplingHooks +
// awaySummary patterns): hooks observe every finished top-level run without
// being able to break it; scheduled runs finishing while the principal is
// idle earn a 1-3 sentence "while you were away" card.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createMockLlmClient, type MockTurn } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun } from '../src/loop/agentLoop.js'
import { clearAfterTurnHooks, fireAfterTurnHooks, registerAfterTurnHook, type AfterTurnContext } from '../src/loop/afterTurn.js'
import {
  awaySummaryHook,
  noteAdminActivity,
  registerAwaySummaryHook,
  renderRecent,
  resetAwaySummaryStateForTests,
} from '../src/loop/awaySummary.js'
import { resetThread } from '../src/loop/context.js'
import type { ChatMessage } from '../src/types.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-afterturn-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env['AWAY_SUMMARY_MIN_MS']
})

beforeEach(() => {
  clearAfterTurnHooks()
  resetAwaySummaryStateForTests()
  process.env['AWAY_SUMMARY_MIN_MS'] = '0' // tests default to "principal is away"
})

const ORCH_AGENT = {
  name: 'orchestrator',
  emoji: '🎯',
  description: 'test orchestrator',
  maxTurns: 2,
  systemPrompt: 'x',
}
const registry = () => new AgentRegistry(new Map([[ORCH_AGENT.name, ORCH_AGENT]]))
const tools = () => new ToolRegistry()

async function run(chatId: number, userText: string, script: MockTurn[], send = createNullSender()) {
  const handle = startRun({
    cfg,
    agentRegistry: registry(),
    toolRegistry: tools(),
    llm: createMockLlmClient(script),
    send,
    chatId,
    agentName: 'orchestrator',
    userText,
  })
  return { summary: await handle.done, send }
}

describe('after-turn seam', () => {
  const CHAT = 246900001
  afterAll(() => resetThread(CHAT))

  it('delivers the run summary to registered hooks', async () => {
    const seen: AfterTurnContext[] = []
    registerAfterTurnHook((ctx) => {
      seen.push(ctx)
    })
    const { summary } = await run(CHAT, 'hello desk', [{ text: 'run answer' }])
    expect(summary.finalText).toBe('run answer')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.summary.finalText).toBe('run answer')
    expect(seen[0]!.chatId).toBe(CHAT)
    expect(seen[0]!.userText).toBe('hello desk')
    expect(seen[0]!.agent).toBe('orchestrator')
  })

  it('a failing hook never breaks the run', async () => {
    registerAfterTurnHook(() => {
      throw new Error('hook exploded')
    })
    registerAfterTurnHook(async () => {
      throw new Error('async hook exploded')
    })
    const { summary } = await run(CHAT, 'still here', [{ text: 'unharmed answer' }])
    expect(summary.finalText).toBe('unharmed answer')
  })

  it('fireAfterTurnHooks is safe with zero hooks', async () => {
    await expect(fireAfterTurnHooks({
      cfg,
      chatId: CHAT,
      agent: 'orchestrator',
      userText: 'x',
      summary: {
        runId: 'r',
        agent: 'orchestrator',
        turns: 1,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 1,
        aborted: false,
        termination: 'FINAL',
        finalText: '',
      },
      llm: createMockLlmClient([]),
      send: createNullSender(),
    })).resolves.toEqual({ kind: 'observe' }) // seam v2: no hook speaks → observe
  })
})

describe('away summary', () => {
  const CHAT = 246900002
  afterAll(() => resetThread(CHAT))

  it('sends a digest card for a scheduled run while the principal is away', async () => {
    registerAwaySummaryHook()
    registerAwaySummaryHook() // idempotent — one hook, not two
    const { send } = await run(CHAT, '[scheduled] hourly market check', [
      { text: 'BTC is holding the 0.618 level.' },
      { text: 'Desk ran the hourly market check and found BTC holding. Next: watch for a sweep of the level.' },
    ])
    const cards = send.messages.filter((m) => m.text.includes('🛌'))
    expect(cards).toHaveLength(1)
    expect(cards[0]!.text).toContain('Next: watch for a sweep')
    expect(cards[0]!.chatId).toBe(CHAT)
  })

  it('never fires for a normal (non-scheduled) prompt', async () => {
    registerAwaySummaryHook()
    const { send } = await run(CHAT, 'hello desk', [
      { text: 'Hi.' },
      { text: 'should never be reached' },
    ])
    expect(send.messages.some((m) => m.text.includes('🛌'))).toBe(false)
  })

  it('never fires while the principal is active', async () => {
    process.env['AWAY_SUMMARY_MIN_MS'] = '3600000' // 1h — the principal was just here
    registerAwaySummaryHook()
    const { send } = await run(CHAT, '[scheduled] hourly check', [
      { text: 'done.' },
      { text: 'unreached digest' },
    ])
    expect(send.messages.some((m) => m.text.includes('🛌'))).toBe(false)
  })

  it('noteAdminActivity resets the away clock (one card per away gap)', async () => {
    registerAwaySummaryHook()
    await run(CHAT, '[scheduled] first scheduled run', [{ text: 'a' }, { text: 'digest one' }])
    noteAdminActivity() // the principal showed up
    process.env['AWAY_SUMMARY_MIN_MS'] = '0' // …and (test shortcut) is "gone" again instantly
    const { send } = await run(CHAT, '[scheduled] second scheduled run', [{ text: 'b' }, { text: 'digest two' }])
    expect(send.messages.some((m) => m.text.includes('digest two'))).toBe(true)
  })

  it('aborted scheduled runs earn no card', async () => {
    const seen: AfterTurnContext[] = []
    registerAfterTurnHook(awaySummaryHook)
    const handle = startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: tools(),
      llm: createMockLlmClient([{ text: 'partial' }]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: '[scheduled] doomed run',
    })
    handle.abort()
    const summary = await handle.done
    expect(summary.aborted).toBe(true)
    void seen
  })

  it('an empty digest fails open — the run completes, no card', async () => {
    registerAfterTurnHook(awaySummaryHook)
    const { summary, send } = await run(CHAT, '[scheduled] flaky digest run', [
      { text: 'run answer' },
      { text: '' },
    ])
    expect(summary.finalText).toBe('run answer')
    expect(send.messages.some((m) => m.text.includes('🛌'))).toBe(false)
  })

  it('a digest error fails open — flaky brain cannot break the run', async () => {
    registerAfterTurnHook(awaySummaryHook)
    const runLlm = createMockLlmClient([{ text: 'run answer' }])
    let llmCalls = 0
    const flaky = {
      model: 'flaky',
      async complete(req: Parameters<typeof runLlm.complete>[0]) {
        llmCalls++
        if (llmCalls === 2) throw new Error('digest brain down') // the post-run digest call
        return runLlm.complete(req)
      },
    }
    const handle = startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: tools(),
      llm: flaky,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: '[scheduled] error digest run',
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('run answer')
  })
})

describe('renderRecent (pure)', () => {
  it('renders tool results and assistant tool calls, capped per message', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'market', arguments: '{"s":"BTC"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(1200) },
      { role: 'assistant', content: 'final word' },
    ]
    const out = renderRecent(messages)
    expect(out).toContain('user: start')
    expect(out).toContain('[tool call] market(')
    expect(out.length).toBeLessThan(1200 + 200) // the 1200-char tool result was capped
  })
})

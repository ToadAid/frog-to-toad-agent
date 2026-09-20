// After-turn seam v2 (north-star cut): hooks no longer merely observe — a hook
// may DIRECT the loop with one bounded follow-up. The laws under proof:
//   · BOUNDED — a run performs at most AFTER_TURN_FOLLOWUP_MAX follow-ups.
//   · FINAL ONLY — ABORTED / ERROR / BRAIN_EMPTY / TURN_BUDGET are never
//     extended; a follow-up never re-arms a spent budget.
//   · PROVENANCE — the injected message is durable thread history, marked
//     `[after-turn hook] …` so the brain knows the principal did not write it.
//   · ONE PER FIRING — first valid followUp wins; every hook still runs.
//   · v1 PARITY — the seam still fires for every top-level run, whatever the
//     termination, and never for subagents; void-returning hooks are observes.
//   · FINAL MEANS TERMINAL — `final` is emitted exactly once, when the run is
//     truly ending; a granted follow-up continues WITHOUT a final in between.
//   · ABORT WINS BEFORE PERSISTENCE — an abort landing during the async seam
//     kills the directive before anything is emitted or persisted.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createMockLlmClient } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun } from '../src/loop/agentLoop.js'
import {
  clearAfterTurnHooks,
  fireAfterTurnHooks,
  registerAfterTurnHook,
  AFTER_TURN_FOLLOWUP_PREFIX,
  DEFAULT_FOLLOWUP_MAX,
  followupMax,
  type AfterTurnContext,
  type AfterTurnDirective,
} from '../src/loop/afterTurn.js'
import { TASK_NOTIFICATION_PREFIX, type TaskNotification } from '../src/loop/taskNotification.js'
import { getThread, resetThread } from '../src/loop/context.js'
import * as interrupt from '../src/loop/interrupt.js'
import { spawnSubagentTool } from '../src/tools/spawn.js'
import type { RunEvent } from '../src/types.js'

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

const ONE_TURN = `---
name: oneTurn
emoji: 🎯
description: budgeted agent
maxTurns: 1
---
You are a one-turn agent.
`

const WORKER = `---
name: worker
emoji: 🔧
description: test worker
maxTurns: 4
---
You are a test worker.
`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-seamv2-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', 'orchestrator.md'), ORCH)
  fs.writeFileSync(path.join(dir, 'agents', 'oneTurn.md'), ONE_TURN)
  fs.writeFileSync(path.join(dir, 'agents', 'worker.md'), WORKER)
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  clearAfterTurnHooks()
  delete process.env['AFTER_TURN_FOLLOWUP_MAX']
})

const CHAT = 777_001

/** Deterministic wait for a cross-task flag (no arbitrary sleeps). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('afterTurnSeamV2: condition never became true')
}

function summaryOf(overrides: Partial<AfterTurnContext['summary']> = {}): AfterTurnContext['summary'] {
  return {
    runId: 'r1',
    agent: 'orchestrator',
    turns: 1,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 1,
    aborted: false,
    termination: 'FINAL',
    finalText: 'done',
    ...overrides,
  }
}

function makeCtx(overrides: Partial<AfterTurnContext> = {}): AfterTurnContext {
  return {
    cfg,
    chatId: CHAT,
    agent: 'orchestrator',
    userText: 'hi',
    summary: summaryOf(),
    llm: createMockLlmClient([]),
    send: createNullSender(),
    ...overrides,
  }
}

// Registry built from the temp agents/ dir; per-agent tool allowlists ride on
// `toolOverrides` (e.g. orchestrator + spawn_subagent).
async function registryFor(
  names: string[],
  toolOverrides: Record<string, string[]> = {},
): Promise<AgentRegistry> {
  const { parseAgent } = await import('../src/agents/loader.js')
  const map = new Map()
  for (const name of names) {
    const raw = fs.readFileSync(path.join(dir, 'agents', `${name}.md`), 'utf8')
    const def = parseAgent(raw, `${name}.md`)
    if (toolOverrides[name] !== undefined) def.tools = toolOverrides[name]
    map.set(def.name, def)
  }
  return new AgentRegistry(map)
}

describe('fireAfterTurnHooks — directive protocol', () => {
  it('no hooks → observe', async () => {
    await expect(fireAfterTurnHooks(makeCtx())).resolves.toEqual({ kind: 'observe' })
  })

  it('a void-returning legacy hook (every v1 consumer) is an observe', async () => {
    let ran = 0
    registerAfterTurnHook(() => {
      ran++
    })
    await expect(fireAfterTurnHooks(makeCtx())).resolves.toEqual({ kind: 'observe' })
    expect(ran).toBe(1)
  })

  it('a throwing hook is an observe and never blocks later hooks', async () => {
    let later = 0
    registerAfterTurnHook(() => {
      throw new Error('hook exploded')
    })
    registerAfterTurnHook(() => {
      later++
    })
    await expect(fireAfterTurnHooks(makeCtx())).resolves.toEqual({ kind: 'observe' })
    expect(later).toBe(1)
  })

  it('the FIRST valid followUp wins — and every hook still runs', async () => {
    let third = 0
    registerAfterTurnHook(() => ({ kind: 'observe' }))
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'first wins' }))
    registerAfterTurnHook((): AfterTurnDirective => {
      third++
      return { kind: 'followUp', text: 'never chosen' }
    })
    const d = await fireAfterTurnHooks(makeCtx())
    expect(d).toEqual({ kind: 'followUp', text: 'first wins' })
    expect(third).toBe(1)
  })

  it('an empty followUp is ignored — the next hook\'s valid followUp wins', async () => {
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: '   ' }))
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'real ask' }))
    await expect(fireAfterTurnHooks(makeCtx())).resolves.toEqual({ kind: 'followUp', text: 'real ask' })
  })

  it('only empty followUps → observe', async () => {
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: '   \n  ' }))
    await expect(fireAfterTurnHooks(makeCtx())).resolves.toEqual({ kind: 'observe' })
  })
})

describe('followupMax knob', () => {
  it('default cap is bounded; env overrides are clamped to 0..10; negatives disable', () => {
    delete process.env['AFTER_TURN_FOLLOWUP_MAX']
    expect(followupMax()).toBe(DEFAULT_FOLLOWUP_MAX) // unset → 2
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = '0'
    expect(followupMax()).toBe(0)
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = '999'
    expect(followupMax()).toBe(10)
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = 'garbage'
    expect(followupMax()).toBe(DEFAULT_FOLLOWUP_MAX) // garbage → 2
  })

  it('a negative value is invalid and DISABLES (never silently re-arms the default)', () => {
    for (const bad of ['-5', '-0.5']) {
      process.env['AFTER_TURN_FOLLOWUP_MAX'] = bad
      expect(followupMax()).toBe(0)
    }
  })

  it('drift table: every documented input maps to its documented output', () => {
    const table: Array<[string | undefined, number]> = [
      [undefined, 2],
      ['garbage', 2],
      ['NaN', 2],
      ['-5', 0],
      ['-0.5', 0],
      ['0', 0],
      ['2.9', 2],
      ['10', 10],
      ['999', 10],
    ]
    for (const [value, expected] of table) {
      if (value === undefined) delete process.env['AFTER_TURN_FOLLOWUP_MAX']
      else process.env['AFTER_TURN_FOLLOWUP_MAX'] = value
      expect(followupMax()).toBe(expected)
    }
  })
})

describe('agentLoop — the follow-up pass', () => {
  it('a followUp directive injects a marked user message and forces one more bounded pass', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'pass one done' }, { text: 'pass two reconciled' }])
    const events: RunEvent[] = []
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return firings === 1 ? { kind: 'followUp', text: 'recheck the position file' } : { kind: 'observe' }
    })
    const sender = createNullSender()
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: sender,
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'trade and report',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    // The run's truth is the LAST pass.
    expect(summary.finalText).toBe('pass two reconciled')
    expect(summary.turns).toBe(2)
    expect(summary.termination).toBe('FINAL')
    expect(firings).toBe(2) // observed pass 1 and pass 2
    // Provenance: the injected message is durable thread history, marked.
    const thread = getThread(cfg, CHAT)
    const injected = thread.messages.find((m) => m.role === 'user' && m.content.includes(AFTER_TURN_FOLLOWUP_PREFIX))
    expect(injected?.content).toContain('recheck the position file')
    // Event parity: exactly one followup event, round 1, with the marker.
    const followups = events.filter((e): e is Extract<RunEvent, { kind: 'followup' }> => e.kind === 'followup')
    expect(followups).toHaveLength(1)
    expect(followups[0]!.round).toBe(1)
    expect(followups[0]!.text).toContain('[after-turn hook]')
    // FINAL MEANS TERMINAL: no `final` may precede the `followup` — the run
    // continued past pass one WITHOUT declaring itself finished.
    const kinds = events.map((e) => e.kind)
    const firstFollowup = kinds.indexOf('followup')
    expect(firstFollowup).toBeGreaterThan(-1)
    expect(kinds.slice(0, firstFollowup)).not.toContain('final')
    expect(events.filter((e) => e.kind === 'final')).toHaveLength(1)
    expect(kinds[kinds.length - 1]).toBe('final')
  })

  it('the cap bounds a hook that asks every pass', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([
      { text: 'pass one' },
      { text: 'pass two' },
      { text: 'pass three — cap reached, still honest' },
    ])
    const events: RunEvent[] = []
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'again' }))
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('pass three — cap reached, still honest')
    expect(summary.turns).toBe(DEFAULT_FOLLOWUP_MAX + 1)
    const followups = events.filter((e) => e.kind === 'followup')
    expect(followups).toHaveLength(DEFAULT_FOLLOWUP_MAX)
    // FINAL MEANS TERMINAL: every pass 1..N ran without a `final` — exactly
    // ONE terminal final, emitted only after the last allowed pass.
    expect(events.filter((e) => e.kind === 'final')).toHaveLength(1)
    const kinds = events.map((e) => e.kind)
    expect(kinds.lastIndexOf('final')).toBeGreaterThan(kinds.lastIndexOf('followup'))
    expect(kinds[kinds.length - 1]).toBe('final')
  })

  it('two granted follow-ups: the single final lands only at the very end', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'pass one' }, { text: 'pass two' }, { text: 'pass three' }])
    const events: RunEvent[] = []
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return firings <= 2 ? { kind: 'followUp', text: 'again' } : { kind: 'observe' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('pass three')
    expect(summary.turns).toBe(3)
    const rounds = events
      .filter((e): e is Extract<RunEvent, { kind: 'followup' }> => e.kind === 'followup')
      .map((e) => e.round)
    expect(rounds).toEqual([1, 2])
    expect(events.filter((e) => e.kind === 'final')).toHaveLength(1)
    const kinds = events.map((e) => e.kind)
    expect(kinds[kinds.length - 1]).toBe('final')
  })

  it('a clean run with no follow-up emits exactly one terminal final (unchanged parity)', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'plain answer' }])
    const events: RunEvent[] = []
    registerAfterTurnHook(() => {
      /* pure observe */
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('plain answer')
    expect(summary.termination).toBe('FINAL')
    expect(events.filter((e) => e.kind === 'final')).toHaveLength(1)
    expect(events[events.length - 1]!.kind).toBe('final')
  })

  it('AFTER_TURN_FOLLOWUP_MAX=0 disables continuation entirely', async () => {
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = '0'
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'one and done' }])
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'please continue' }))
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('one and done')
    expect(summary.turns).toBe(1)
  })

  it('FINAL ONLY: a TURN_BUDGET pass is observed but never extended', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['oneTurn'])
    const llm = createMockLlmClient([{ text: 'synthesized under budget' }])
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return { kind: 'followUp', text: 'keep going' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'oneTurn',
      userText: 'go',
    })
    const summary = await handle.done
    expect(summary.termination).toBe('TURN_BUDGET')
    expect(summary.turns).toBe(1)
    expect(firings).toBe(1) // observed, but the spent budget never re-arms
  })

  it('an errored run is observed (v1 parity) but never extended', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    // Pass 1 finishes FINAL; the hook grants a follow-up; pass 2's brain throws.
    const llm = createMockLlmClient([{ text: 'pass one done' }])
    const events: RunEvent[] = []
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return { kind: 'followUp', text: 'continue' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.termination).toBe('ERROR')
    expect(summary.finalText.startsWith('⚠️')).toBe(true)
    expect(firings).toBe(2) // pass 1 AND the errored end — observed both times
    expect(events.filter((e) => e.kind === 'followup')).toHaveLength(1) // granted once, then died
  })

  it('ABORT WINS: a hook that aborts AND directs loses — no followup, no persistence, no extra pass', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'pass one done' }, { text: 'never reached' }])
    const events: RunEvent[] = []
    registerAfterTurnHook((): AfterTurnDirective => {
      interrupt.abort(CHAT) // /stop lands between the passes
      return { kind: 'followUp', text: 'continue' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.aborted).toBe(true)
    expect(summary.termination).toBe('ABORTED')
    // The pass-1 final stands; the follow-up pass never ran.
    expect(summary.finalText).toBe('pass one done')
    expect(summary.turns).toBe(1)
    expect(events.filter((e) => e.kind === 'followup')).toHaveLength(0)
    // A synthetic instruction that will never run must never become durable history.
    const thread = getThread(cfg, CHAT)
    expect(
      thread.messages.some((m) => m.role === 'user' && m.content.includes(AFTER_TURN_FOLLOWUP_PREFIX)),
    ).toBe(false)
  })

  it('ABORT WINS in the race: an abort landing DURING the async seam kills the directive before it persists', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'pass one done' }, { text: 'never reached' }])
    const events: RunEvent[] = []
    let entered = false
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    registerAfterTurnHook(async (): Promise<AfterTurnDirective> => {
      entered = true
      await gate // park mid-seam so the abort can land during the await
      return { kind: 'followUp', text: 'continue' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    await until(() => entered)
    interrupt.abort(CHAT)
    release()
    const summary = await handle.done
    expect(summary.aborted).toBe(true)
    expect(summary.termination).toBe('ABORTED')
    expect(summary.finalText).toBe('pass one done')
    expect(summary.turns).toBe(1)
    expect(events.filter((e) => e.kind === 'followup')).toHaveLength(0)
    const thread = getThread(cfg, CHAT)
    expect(
      thread.messages.some((m) => m.role === 'user' && m.content.includes(AFTER_TURN_FOLLOWUP_PREFIX)),
    ).toBe(false)
  })

  it('an abort DURING the pass is unchanged: observed once (v1 parity), never extended', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'never reached' }])
    const events: RunEvent[] = []
    let entered = false
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return { kind: 'followUp', text: 'continue' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm: {
        model: 'slow',
        async complete(req: Parameters<typeof llm.complete>[0]) {
          if (entered) return llm.complete(req)
          entered = true
          await gate // park mid-turn so the abort lands INSIDE the pass
          return llm.complete(req)
        },
      } as never,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    await until(() => entered)
    interrupt.abort(CHAT)
    release()
    const summary = await handle.done
    expect(summary.aborted).toBe(true)
    expect(summary.termination).toBe('ABORTED')
    expect(firings).toBe(1) // the seam observed the abort exactly once
    expect(events.filter((e) => e.kind === 'followup')).toHaveLength(0)
    const thread = getThread(cfg, CHAT)
    expect(
      thread.messages.some((m) => m.role === 'user' && m.content.includes(AFTER_TURN_FOLLOWUP_PREFIX)),
    ).toBe(false)
  })

  it('subagents never fire the seam — the parent observes alone', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator', 'worker'], { orchestrator: ['spawn_subagent'] })
    const tools = new ToolRegistry()
    tools.register(spawnSubagentTool)
    let i = 0
    const scriptedLlm = {
      model: 'mixed',
      complete() {
        i++
        if (i === 1) {
          return Promise.resolve({
            message: {
              role: 'assistant' as const,
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function' as const, function: { name: 'spawn_subagent', arguments: '{"agent":"worker","prompt":"look around"}' } },
              ],
            },
          })
        }
        if (i === 2) {
          return Promise.resolve({ message: { role: 'assistant' as const, content: 'worker done' } })
        }
        return Promise.resolve({ message: { role: 'assistant' as const, content: 'parent final' } })
      },
    }
    const events: RunEvent[] = []
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return { kind: 'followUp', text: 'again' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: tools,
      llm: scriptedLlm as never,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'delegate',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('parent final')
    // The seam fired for the parent's FIRST pass only... the parent's follow-up
    // pass runs too — but the CHILD's completion never fired it.
    expect(firings).toBeGreaterThanOrEqual(1)
    expect(firings).toBeLessThanOrEqual(DEFAULT_FOLLOWUP_MAX + 1)
    // No followup event names the child, and the parent's pass count proves
    // the seam never observed a subagent run.
    expect(events.filter((e) => e.kind === 'followup').length).toBeLessThanOrEqual(DEFAULT_FOLLOWUP_MAX)
  })
})
describe('fireAfterTurnHooks — the taskNotification directive', () => {
  const scoutDone: TaskNotification = {
    taskId: 'scout:researcher#0',
    status: 'completed',
    summary: 'Scout "researcher" completed (1 turn(s), 0 tool call(s))',
    result: 'report one: trend up',
    usage: { totalTokens: 12, toolUses: 0, durationMs: 5 },
  }

  it('injects the desk mark + envelope as durable user history and forces one bounded pass', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'pass one done' }, { text: 'pass two synthesized the report' }])
    const events: RunEvent[] = []
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return firings === 1 ? { kind: 'taskNotification', notification: scoutDone } : { kind: 'observe' }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('pass two synthesized the report')
    expect(summary.turns).toBe(2)
    expect(firings).toBe(2)
    // Provenance: the injected notification is durable thread history, marked
    // by the desk — and the envelope's opening tag is what the brain
    // distinguishes it by (mother §2).
    const thread = getThread(cfg, CHAT)
    const injected = thread.messages.find(
      (m) => m.role === 'user' && m.content.includes('<task-notification>'),
    )
    expect(injected?.content).toContain(TASK_NOTIFICATION_PREFIX)
    expect(injected?.content).toContain('<task-id>scout:researcher#0</task-id>')
    expect(injected?.content).toContain('<result>report one: trend up</result>')
    // Event parity: a task_notification event, round 1 — not a followup.
    const notes = events.filter(
      (e): e is Extract<RunEvent, { kind: 'task_notification' }> => e.kind === 'task_notification',
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]!.round).toBe(1)
    expect(notes[0]!.text.startsWith(TASK_NOTIFICATION_PREFIX)).toBe(true)
    expect(events.filter((e) => e.kind === 'followup')).toHaveLength(0)
    // FINAL MEANS TERMINAL: no final before the notification inject.
    const kinds = events.map((e) => e.kind)
    expect(kinds.slice(0, kinds.indexOf('task_notification'))).not.toContain('final')
    expect(kinds[kinds.length - 1]).toBe('final')
  })

  it('a notification counts against the SAME cap — it cannot buy more passes than a followUp', async () => {
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = '1'
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'pass one' }, { text: 'pass two — cap reached' }])
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'taskNotification', notification: scoutDone }))
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
    })
    const summary = await handle.done
    expect(summary.turns).toBe(2) // 1 pass + 1 injected notification, then the cap
    expect(summary.finalText).toBe('pass two — cap reached')
  })

  it('FINAL ONLY: a notification never extends a spent budget', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['oneTurn'])
    const llm = createMockLlmClient([{ text: 'synthesized under budget' }])
    let firings = 0
    registerAfterTurnHook((): AfterTurnDirective => {
      firings++
      return { kind: 'taskNotification', notification: scoutDone }
    })
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'oneTurn',
      userText: 'go',
    })
    const summary = await handle.done
    expect(summary.termination).toBe('TURN_BUDGET')
    expect(summary.turns).toBe(1)
    expect(firings).toBe(1) // observed, never extended
  })

  it('a malformed notification is ignored — the run finalizes without an inject', async () => {
    resetThread(CHAT)
    const registry = await registryFor(['orchestrator'])
    const llm = createMockLlmClient([{ text: 'plain answer' }])
    registerAfterTurnHook((): AfterTurnDirective => ({
      kind: 'taskNotification',
      notification: { ...scoutDone, status: 'finished' as never },
    }))
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'go',
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('plain answer')
    expect(summary.turns).toBe(1)
    const thread = getThread(cfg, CHAT)
    expect(thread.messages.some((m) => m.role === 'user' && m.content.includes('<task-notification>'))).toBe(false)
  })

  it('ONE PER FIRING across kinds: the first directive wins, later kinds observe', async () => {
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'hook one asks first' }))
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'taskNotification', notification: scoutDone }))
    const d = await fireAfterTurnHooks(makeCtx())
    expect(d).toEqual({ kind: 'followUp', text: 'hook one asks first' })
  })

  it('a taskNotification after an already-granted followUp observes (first directive wins, no queueing)', async () => {
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'the ask' }))
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'taskNotification', notification: scoutDone }))
    const d = await fireAfterTurnHooks(makeCtx())
    expect(d.kind).toBe('followUp')
  })
})

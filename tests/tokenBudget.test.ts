// Token budget (mother-repo port: utils/tokenBudget.ts + query/tokenBudget.ts).
// Laws under proof:
//   · THE DECLARED BUDGET IS THE BOUND — no declaration → no continuation.
//   · SUBAGENTS NEVER BUDGET-CONTINUE.
//   · BOUNDED — continuations hard-capped (env TOKEN_BUDGET_MAX_CONTINUATIONS).
//   · Work-denominated: ~90% of target or diminishing returns stops the grants.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createMockLlmClient } from '../src/llm/mock.js'
import type { LlmClient } from '../src/llm/client.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun } from '../src/loop/agentLoop.js'
import {
  DEFAULT_BUDGET_CONTINUATION_MAX,
  TOKEN_BUDGET_PREFIX,
  budgetContinuationMax,
  checkTokenBudget,
  createBudgetTracker,
  getBudgetContinuationMessage,
  parseTokenBudget,
} from '../src/loop/tokenBudget.js'
import { getThread, resetThread } from '../src/loop/context.js'
import type { ChatMessage, RunEvent, ToolDef } from '../src/types.js'

let dir: string
let cfg: Config

const ONE_TURN = `---
name: oneTurn
emoji: 🎯
description: budgeted agent
maxTurns: 1
---
You are a one-turn agent.
`

const TWO_TURN = `---
name: twoTurn
emoji: 🎯
description: plain agent
maxTurns: 2
---
You are a two-turn agent.
`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-tokenbudget-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', 'oneTurn.md'), ONE_TURN)
  fs.writeFileSync(path.join(dir, 'agents', 'twoTurn.md'), TWO_TURN)
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env['TOKEN_BUDGET_MAX_CONTINUATIONS']
})

describe('parseTokenBudget — shorthand and verbose grammar', () => {
  it('start-anchored shorthand: "+500k" wins before anything else', () => {
    expect(parseTokenBudget('+500k')).toBe(500_000)
    expect(parseTokenBudget('+500k scan the market')).toBe(500_000)
    expect(parseTokenBudget('  +1.5m run the full sweep')).toBe(1_500_000)
    expect(parseTokenBudget('+2B tokens of work')).toBe(2_000_000_000)
  })

  it('end-anchored shorthand catches a trailing mention with punctuation', () => {
    expect(parseTokenBudget('run the deep sweep +500k')).toBe(500_000)
    expect(parseTokenBudget('run the deep sweep +500k.')).toBe(500_000)
    expect(parseTokenBudget('deep sweep +2m!')).toBe(2_000_000)
  })

  it('verbose form matches anywhere: use/spend N[kmb] tokens', () => {
    expect(parseTokenBudget('please use 2M tokens on this')).toBe(2_000_000)
    expect(parseTokenBudget('spend 750k tokens if needed')).toBe(750_000)
    expect(parseTokenBudget('USE 1.2b TOKENS')).toBe(1_200_000_000)
  })

  it('no false positives — natural language never invents a budget', () => {
    expect(parseTokenBudget('check every PR')).toBeNull()
    expect(parseTokenBudget('+5')).toBeNull() // unit required
    expect(parseTokenBudget('spend 2 million tokens')).toBeNull() // only k/m/b supported
    expect(parseTokenBudget('scan +500 positions')).toBeNull() // unit required
    expect(parseTokenBudget('')).toBeNull()
  })

  it('start-anchored shorthand beats a later verbose mention', () => {
    expect(parseTokenBudget('+500k also use 2m tokens')).toBe(500_000)
  })
})

describe('the continuation message', () => {
  it('states pct, spent and target — and demands work, not a summary', () => {
    expect(getBudgetContinuationMessage(42, 420_000, 1_000_000)).toBe(
      'Stopped at 42% of token target (420,000 / 1,000,000). Keep working — do not summarize.',
    )
  })
})

describe('checkTokenBudget — the decision law', () => {
  it('no budget or non-positive budget → stop, no completion event', () => {
    const t = createBudgetTracker()
    expect(checkTokenBudget(t, false, null, 5_000)).toEqual({ action: 'stop', completionEvent: null })
    expect(checkTokenBudget(t, false, 0, 5_000).action).toBe('stop')
    expect(checkTokenBudget(t, false, -5, 5_000).action).toBe('stop')
  })

  it('subagents never continue (mother agentId law)', () => {
    const t = createBudgetTracker()
    expect(checkTokenBudget(t, true, 1_000_000, 5_000)).toEqual({ action: 'stop', completionEvent: null })
  })

  it('below 90% with cap room → continue, tracker advances', () => {
    const t = createBudgetTracker()
    const d = checkTokenBudget(t, false, 1_000_000, 100_000)
    expect(d.action).toBe('continue')
    if (d.action !== 'continue') throw new Error('unreachable')
    expect(d.continuationCount).toBe(1)
    expect(d.pct).toBe(10)
    expect(t.continuationCount).toBe(1)
    expect(t.lastGlobalTurnTokens).toBe(100_000)
  })

  it('≥90% of target → stop with a completion event (only once continuations happened)', () => {
    const t = createBudgetTracker()
    // Mother behavior verbatim: a stop on the FIRST check (no grants yet) has
    // no completion event — nothing was continued, nothing to report.
    expect((checkTokenBudget(t, false, 1_000, 900) as { completionEvent: null }).completionEvent).toBeNull()
    // One grant, then the 90% wall → stop WITH the event.
    expect(checkTokenBudget(t, false, 1_000, 100).action).toBe('continue')
    const d = checkTokenBudget(t, false, 1_000, 900)
    expect(d.action).toBe('stop')
    if (d.action !== 'stop') throw new Error('unreachable')
    expect(d.completionEvent).not.toBeNull()
    expect(d.completionEvent!.pct).toBe(90)
    expect(d.completionEvent!.diminishingReturns).toBe(false)
    expect(d.completionEvent!.continuationCount).toBe(1)
  })

  it('diminishing returns: after 3+ continuations, two consecutive small deltas stop the grants early', () => {
    const t = createBudgetTracker()
    for (let i = 0; i < 3; i++) {
      expect(checkTokenBudget(t, false, 10_000_000, (i + 1) * 1_000).action).toBe('continue')
    }
    // Deltas still ≥ 500 → keeps granting…
    expect(checkTokenBudget(t, false, 10_000_000, 4_100).action).toBe('continue') // delta 1100
    // …delta dips under 500 but the PREVIOUS delta (1100) was not → one more grant.
    expect(checkTokenBudget(t, false, 10_000_000, 4_200).action).toBe('continue') // delta 100, lastDelta 1100
    // Two consecutive sub-500 deltas → diminishing → stop, with the event.
    const d = checkTokenBudget(t, false, 10_000_000, 4_300)
    expect(d.action).toBe('stop')
    if (d.action !== 'stop') throw new Error('unreachable')
    expect(d.completionEvent!.diminishingReturns).toBe(true)
    expect(d.completionEvent!.continuationCount).toBe(5)
  })

  it('the hard cap bounds round-trips even against a huge declared budget', () => {
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '2'
    const t = createBudgetTracker()
    expect(checkTokenBudget(t, false, 1_000_000_000, 10).action).toBe('continue')
    expect(checkTokenBudget(t, false, 1_000_000_000, 20).action).toBe('continue')
    const d = checkTokenBudget(t, false, 1_000_000_000, 30) // count 2 ≥ cap 2
    expect(d.action).toBe('stop')
    if (d.action !== 'stop') throw new Error('unreachable')
    expect(d.completionEvent!.continuationCount).toBe(2)
    expect(d.completionEvent!.diminishingReturns).toBe(false)
  })
})

describe('budgetContinuationMax knob', () => {
  it('unset → default; negatives/garbage → 0 (disable, never re-arm); clamp 0..100', () => {
    delete process.env['TOKEN_BUDGET_MAX_CONTINUATIONS']
    expect(budgetContinuationMax()).toBe(DEFAULT_BUDGET_CONTINUATION_MAX)
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '0'
    expect(budgetContinuationMax()).toBe(0)
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '-3'
    expect(budgetContinuationMax()).toBe(0)
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = 'garbage'
    expect(budgetContinuationMax()).toBe(0)
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '999'
    expect(budgetContinuationMax()).toBe(100)
  })
})

describe('agentLoop — the work-denominated pass', () => {
  // oneTurn agent: maxTurns 1, so EVERY turn is a synthesis checkpoint — the
  // mock's tool-call turns keep the run working, the fixed 10-token usage
  // makes the spend arithmetic deterministic.
  async function budgetedRun(
    userText: string,
    script: Parameters<typeof createMockLlmClient>[0],
    depth = 0,
    agentSource = ONE_TURN,
  ): Promise<{ events: RunEvent[]; summary: Awaited<ReturnType<typeof startRun>['done']> }> {
    const { parseAgent } = await import('../src/agents/loader.js')
    const def = parseAgent(agentSource, 'agent.md')
    const registry = new AgentRegistry(new Map([[def.name, def]]))
    const events: RunEvent[] = []
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient(script),
      chatId: 777_004,
      userText,
      agentName: def.name,
      send: createNullSender(),
      depth,
      onEvent: (e) => events.push(e),
    })
    return { events, summary: await handle.done }
  }

  it('a declared budget continues past the turn cap — nudge is provenance-tagged durable history', async () => {
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '2'
    resetThread(777_004)
    const { events, summary } = await budgetedRun('sweep the tape +1m', [
      { toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }] }, // working turn 1 (after grant)
      { toolCalls: [{ id: 't2', name: 'no_such_tool', arguments: '{}' }] }, // working turn 2 (after grant)
      // synthesis checkpoint after the cap → the reserved synthesis call
      { text: 'final synthesis of partial work' },
    ])
    const nudges = events.filter((e) => e.kind === 'budget_continue')
    expect(nudges).toHaveLength(2) // grant #1 and #2, then the hard cap stops
    expect(nudges[0]!.text.startsWith('[token budget] Stopped at 0% of token target')).toBe(true)
    expect(nudges[1]!.text).toContain('(10 / 1,000,000)')
    // Durable history: the nudge is a provenance-tagged user message in the thread.
    const thread = getThread(cfg, 777_004)
    const injected = thread.messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && (m.content as string).startsWith('[token budget] '))
    expect(injected).toHaveLength(2)
    expect(summary.termination).toBe('TURN_BUDGET_BUDGET_CAP')
    expect(summary.finalText).toBe('final synthesis of partial work')
  })

  it('no budget declared → the old law: clean text turn ends FINAL immediately, zero nudges', async () => {
    resetThread(777_004)
    const { events, summary } = await budgetedRun(
      'plain prompt with no target',
      [{ text: 'straight final' }],
      0,
      TWO_TURN, // turn 1 is a WORKING turn here (cap 2) — a no-tool reply ends FINAL
    )
    expect(events.filter((e) => e.kind === 'budget_continue')).toHaveLength(0)
    expect(summary.termination).toBe('FINAL')
    expect(summary.finalText).toBe('straight final')
  })

  it('subagents (depth > 0) never budget-continue even with a declared target', async () => {
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '5'
    resetThread(777_004)
    const { events, summary } = await budgetedRun(
      'scout brief +1m tokens',
      [{ text: 'scout done' }],
      1,
      TWO_TURN,
    )
    expect(events.filter((e) => e.kind === 'budget_continue')).toHaveLength(0)
    expect(summary.termination).toBe('FINAL')
  })

  it('a spent target stops granting: ≥90% → synthesis fires, no more nudges', async () => {
    // Budget 6000 tokens (+6k); the custom mock spends 600 out per call (the
    // fixed-10 mock would trip the diminishing-returns law — deltas must be
    // ≥ 500 to keep granting). 5400 = 90% of target → after 9 working turns
    // the checkpoint stops granting and the reserved synthesis fires.
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '50'
    resetThread(777_004)
    const { parseAgent } = await import('../src/agents/loader.js')
    const def = parseAgent(ONE_TURN, 'agent.md')
    const registry = new AgentRegistry(new Map([[def.name, def]]))
    let seq = 0
    // Synthesis is detected by its reserved instruction, NOT by tools.length:
    // this test's ToolRegistry is empty, so working turns pass tools: [] too.
    const SYNTH_MARKER = 'Finish from evidence already collected.'
    const llm: LlmClient = {
      model: 'spend-600',
      async complete({ messages }: { messages: ChatMessage[]; tools: ToolDef[]; signal?: AbortSignal }) {
        seq++
        const last = messages[messages.length - 1]
        if (typeof last?.content === 'string' && last.content.includes(SYNTH_MARKER)) {
          return { message: { role: 'assistant', content: 'budget spent synthesis' }, usage: { in: 10, out: 600 } }
        }
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `w${seq}`, type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }],
          },
          usage: { in: 10, out: 600 },
        }
      },
    }
    const events: RunEvent[] = []
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      chatId: 777_004,
      userText: 'burn it +6k',
      agentName: def.name,
      send: createNullSender(),
      depth: 0,
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    const nudges = events.filter((e) => e.kind === 'budget_continue')
    expect(nudges).toHaveLength(9) // grants at 0, 600 … 4800 — the 10th check is at 5400 ≥ 90%
    expect(summary.termination).toBe('TURN_BUDGET')
    expect(summary.finalText).toBe('budget spent synthesis')
    expect(summary.tokensOut).toBe(6_000) // 9 working turns + synthesis, 600 each
  })

  it('the granted working turn SEES the nudge — live injection into the current brain (1A)', async () => {
    // ONE_TURN: every turn is a synthesis checkpoint. Cap 2 → grant #1, one
    // working turn, grant #2, one working turn, then the cap stops → synthesis.
    // The mock records the EXACT messages argument of every llm call.
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '2'
    resetThread(777_004)
    const { parseAgent } = await import('../src/agents/loader.js')
    const def = parseAgent(ONE_TURN, 'agent.md')
    const registry = new AgentRegistry(new Map([[def.name, def]]))
    let seq = 0
    const SYNTH_MARKER = 'Finish from evidence already collected.'
    const calls: ChatMessage[][] = []
    const nudgeCount = (messages: ChatMessage[]): number =>
      messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[token budget] ')).length
    const llm: LlmClient = {
      model: 'nudge-observer',
      async complete({ messages }: { messages: ChatMessage[]; tools: ToolDef[]; signal?: AbortSignal }) {
        seq++
        calls.push([...messages]) // snapshot — the loop mutates this array in place
        const last = messages[messages.length - 1]
        if (typeof last?.content === 'string' && last.content.includes(SYNTH_MARKER)) {
          return { message: { role: 'assistant', content: 'synthesis after grants' }, usage: { in: 10, out: 10 } }
        }
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `w${seq}`, type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }],
          },
          usage: { in: 10, out: 10 },
        }
      },
    }
    const events: RunEvent[] = []
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      chatId: 777_004,
      userText: 'sweep the tape +1m',
      agentName: def.name,
      send: createNullSender(),
      depth: 0,
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    // 3 llm calls: two granted working turns + synthesis. Checkpoints never call.
    expect(calls).toHaveLength(3)
    // F1: the FIRST granted working turn sees exactly one provenance-tagged
    // nudge, as the LAST message — present BEFORE the working turn executes.
    expect(nudgeCount(calls[0]!)).toBe(1)
    const firstNudge = calls[0]!.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[token budget] '))[0]
    expect(firstNudge!.content).toContain('Keep working — do not summarize.')
    expect(calls[0]![calls[0]!.length - 1]).toBe(firstNudge)
    // F1: by the second granted turn there are exactly TWO nudges — one PER
    // GRANT, never a duplicate of the same grant. Each is the newest message
    // when it was injected; the second grant's nudge leads the granted turn.
    expect(nudgeCount(calls[1]!)).toBe(2)
    expect(nudgeCount(calls[2]!)).toBe(2)
    expect(calls[1]!.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[token budget] '))[1]!.content).toContain('(10 / 1,000,000)')
    // The event, the durable thread, and the live context carry the SAME string.
    const nudges = events.filter((e) => e.kind === 'budget_continue')
    expect(nudges).toHaveLength(2)
    const thread = getThread(cfg, 777_004)
    const durable = thread.messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[token budget] '))
    expect(durable).toHaveLength(2)
    expect(durable.map((m) => m.content)).toEqual(nudges.map((n) => n.text))
    expect(calls[0]!.filter((m) => m.role === 'user' && m.content === nudges[0]!.text)).toHaveLength(1)
    expect(summary.termination).toBe('TURN_BUDGET_BUDGET_CAP')
    expect(summary.finalText).toBe('synthesis after grants')
  })

  it('a follow-up pass starts at base maxTurns and never resets the budget cap (2A + 2B)', async () => {
    // Pass 1: working turn → checkpoint GRANTS #1 (cap 1) → the granted turn
    // returns clean text → FINAL ends the pass → the after-turn hook grants a
    // follow-up pass. Pass 2 must open at base maxTurns 2 (checkpoint after ONE
    // working turn, not the inherited 4) and must NOT grant continuation #2 —
    // the run-scoped tracker still counts pass-1's grant.
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '1'
    resetThread(777_004)
    const { parseAgent } = await import('../src/agents/loader.js')
    const def = parseAgent(TWO_TURN, 'agent.md')
    const registry = new AgentRegistry(new Map([[def.name, def]]))
    const { registerAfterTurnHook, clearAfterTurnHooks } = await import('../src/loop/afterTurn.js')
    let hookFires = 0
    registerAfterTurnHook(() => {
      hookFires++
      return hookFires === 1 ? { kind: 'followUp', text: 'go deeper on the tape' } : { kind: 'observe' }
    })
    try {
      let seq = 0
      const SYNTH_MARKER = 'Finish from evidence already collected.'
      const calls: ChatMessage[][] = []
      const hasNudge = (messages: ChatMessage[]): boolean =>
        messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[token budget] '))
      const hasFollowUp = (messages: ChatMessage[]): boolean =>
        messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[after-turn hook] '))
      const nudgeCount = (messages: ChatMessage[]): number =>
        messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[token budget] ')).length
      const llm: LlmClient = {
        model: 'pass-local',
        async complete({ messages }: { messages: ChatMessage[]; tools: ToolDef[]; signal?: AbortSignal }) {
          seq++
          calls.push([...messages]) // snapshot — the loop mutates this array in place
          const last = messages[messages.length - 1]
          if (typeof last?.content === 'string' && last.content.includes(SYNTH_MARKER)) {
            return { message: { role: 'assistant', content: 'pass-2 synthesis' }, usage: { in: 10, out: 10 } }
          }
          // The granted turn in pass 1 sees the nudge (and no follow-up yet) →
          // returns CLEAN TEXT so pass 1 ends FINAL before the expanded
          // checkpoint is ever reached. Pass 2's calls also carry the pass-1
          // nudge in live history — the followup mark is what sets them apart.
          if (hasNudge(messages) && !hasFollowUp(messages)) {
            return { message: { role: 'assistant', content: 'clean early final' }, usage: { in: 10, out: 10 } }
          }
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: `w${seq}`, type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }],
            },
            usage: { in: 10, out: 10 },
          }
        },
      }
      const events: RunEvent[] = []
      const handle = startRun({
        cfg,
        agentRegistry: registry,
        toolRegistry: new ToolRegistry(),
        llm,
        chatId: 777_004,
        userText: 'trace the flow +1m',
        agentName: def.name,
        send: createNullSender(),
        depth: 0,
        onEvent: (e) => events.push(e),
      })
      const summary = await handle.done
      // F2 pass-locality: pass 2 is ONE working turn (its base maxTurns 2 →
      // checkpoint at turn 2) then the budget-spent synthesis. Under the
      // inherited expanded cap the pass would run three extra working turns
      // before its checkpoint — 6 calls total instead of 4.
      expect(calls).toHaveLength(4)
      expect(hookFires).toBe(2) // pass 1 (granted) + pass 2 (observe — a budget-guard termination never extends)
      // 2A: the pass-2 working turn carries the follow-up; the pass-1 nudge is
      // still in live history (carried once, never re-injected)…
      expect(hasFollowUp(calls[2]!)).toBe(true)
      expect(nudgeCount(calls[2]!)).toBe(1)
      // …and the synthesis call right after it proves the checkpoint fired at
      // base allowance (turn 2), not the pass-1-expanded one.
      expect(hasFollowUp(calls[3]!)).toBe(true)
      const last3 = calls[3]![calls[3]!.length - 1]
      expect(typeof last3?.content === 'string' && last3.content.includes(SYNTH_MARKER)).toBe(true)
      // 2B: continuation #1 happened in pass 1; the follow-up did NOT reset the
      // hard cap — pass 2's checkpoint granted nothing.
      const grantEvents = events.filter((e) => e.kind === 'budget_continue')
      expect(grantEvents).toHaveLength(1)
      const followUpEvents = events.filter((e) => e.kind === 'followup')
      expect(followUpEvents).toHaveLength(1)
      const thread = getThread(cfg, 777_004)
      const durable = thread.messages.filter((m) => m.role === 'user' && typeof m.content === 'string')
      expect(durable.filter((m) => (m.content as string).startsWith('[token budget] '))).toHaveLength(1)
      expect(durable.filter((m) => (m.content as string).startsWith('[after-turn hook] '))).toHaveLength(1)
      expect(summary.termination).toBe('TURN_BUDGET_BUDGET_CAP')
      expect(summary.finalText).toBe('pass-2 synthesis')
    } finally {
      clearAfterTurnHooks()
    }
  })
})
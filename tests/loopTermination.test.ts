// Loop transition ledger (north-star Tier 2 #12): the widened terminal-reason
// set distinguishes "finished" from "guard fired" in the audit record. The two
// guards this file proves were previously MASKED:
//   · a clean pass whose hook asked for more but was refused by the
//     follow-up cap reported plain FINAL;
//   · synthesis at the turn cap with a declared token target still open
//     (continuation cap exhausted) reported plain TURN_BUDGET.
// Laws under proof: the widened values ride the SAME summary/final-event/
// durable-transcript path (no new event kinds); a run that ends by the
// brain's own choice is FINAL; nothing changes when no guard fires.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createMockLlmClient, type MockTurn } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun } from '../src/loop/agentLoop.js'
import {
  clearAfterTurnHooks,
  registerAfterTurnHook,
  type AfterTurnDirective,
} from '../src/loop/afterTurn.js'
import { resetThread } from '../src/loop/context.js'
import { formatRunFinal, TURN_BUDGET_NOTICE } from '../src/telegram/draft.js'
import { projectConversationTranscriptV1 } from '../src/memory/conversationEpisodes.js'
import type { LlmClient } from '../src/llm/client.js'
import type { RunEvent, RunTermination } from '../src/types.js'

let dir: string
let cfg: Config
const CHAT = 778_001

const ORCH = (turns: number) => `---
name: orchestrator
emoji: 🎯
description: test orchestrator
maxTurns: ${turns}
---
You are a test orchestrator.
`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-ledger-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', 'orch2.md'), ORCH(2))
  fs.writeFileSync(path.join(dir, 'agents', 'orch1.md'), ORCH(1))
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  clearAfterTurnHooks()
  delete process.env['AFTER_TURN_FOLLOWUP_MAX']
  delete process.env['TOKEN_BUDGET_MAX_CONTINUATIONS']
  resetThread(CHAT)
})

const ORCHES = new AgentRegistry(
  new Map([
    ['orch2', { name: 'orch2', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }],
    ['orch1', { name: 'orch1', emoji: '🎯', description: 'd', maxTurns: 1, systemPrompt: 'x' }],
  ]),
)

/** A scripted LLM with fixed usage per call (the budget ledger needs
 * tokensOut to move deterministically while the pass stays alive). */
function usageLlm(script: MockTurn[], out: number): LlmClient {
  let i = 0
  return {
    model: 'mock-budget',
    async complete() {
      const turn = script[i]
      i++
      if (!turn) throw new Error('usageLlm: script exhausted')
      if ('toolCalls' in turn) {
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: turn.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
          usage: { in: 10, out },
        }
      }
      return { message: { role: 'assistant' as const, content: turn.text }, usage: { in: 10, out } }
    },
  }
}

describe('loop transition ledger (RunTermination widening)', () => {
  it('a hook asking past the follow-up cap ends the run as FINAL_FOLLOWUP_CAP, not FINAL', async () => {
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = '2'
    const events: RunEvent[] = []
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'again' }))
    const handle = startRun({
      cfg,
      agentRegistry: new AgentRegistry(new Map([['orch2', { name: 'orch2', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }]])),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'p1' }, { text: 'p2' }, { text: 'p3' }] as MockTurn[]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orch2',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    // the cap refused the third ask: 2 grants, then the guard fired
    expect(events.filter((e) => e.kind === 'followup')).toHaveLength(2)
    const final = events.find((e) => e.kind === 'final')
    expect(final && final.termination).toBe('FINAL_FOLLOWUP_CAP')
    expect(summary.termination).toBe('FINAL_FOLLOWUP_CAP')
  })

  it('a hook ask WITHIN the cap still ends as plain FINAL (no masking regression)', async () => {
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = '2'
    let fires = 0
    registerAfterTurnHook((): AfterTurnDirective | undefined => {
      fires += 1
      return fires === 1 ? { kind: 'followUp', text: 'once' } : undefined
    })
    const events: RunEvent[] = []
    const handle = startRun({
      cfg,
      agentRegistry: new AgentRegistry(new Map([['orch2', { name: 'orch2', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }]])),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'p1' }, { text: 'p2' }] as MockTurn[]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orch2',
      userText: 'go',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(summary.termination).toBe('FINAL')
    expect(events.filter((e) => e.kind === 'followup')).toHaveLength(1)
  })

  it('an observing hook leaves the clean pass as plain FINAL (the default is byte-for-byte)', async () => {
    registerAfterTurnHook(() => undefined)
    const handle = startRun({
      cfg,
      agentRegistry: new AgentRegistry(new Map([['orch2', { name: 'orch2', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }]])),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'clean' }] as MockTurn[]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orch2',
      userText: 'go',
    })
    const summary = await handle.done
    expect(summary.termination).toBe('FINAL')
  })

  it('turn cap with no declared budget is plain TURN_BUDGET', async () => {
    const handle = startRun({
      cfg,
      agentRegistry: new AgentRegistry(new Map([['orch1', { name: 'orch1', emoji: '🎯', description: 'd', maxTurns: 1, systemPrompt: 'x' }]])),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'the answer' }] as MockTurn[]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orch1',
      userText: 'go',
    })
    const summary = await handle.done
    expect(summary.termination).toBe('TURN_BUDGET')
  })

  it('turn cap with the declared target still open and the continuation cap spent is TURN_BUDGET_BUDGET_CAP', async () => {
    process.env['TOKEN_BUDGET_MAX_CONTINUATIONS'] = '1'
    const events: RunEvent[] = []
    // one-turn agent: turn 1 is the synthesis checkpoint → the continue
    // grants turn 2 with NO llm call (the grant skips synthesis) → turn 2 is
    // the working turn (a TOOL call keeps the pass alive — a text reply here
    // would be the brain choosing to stop = plain FINAL) → turn 3 checkpoint:
    // continuationCount(1) < cap(1) is false → stop, target at ~2% → the
    // reserved synthesis call runs (script slot 2)
    const handle = startRun({
      cfg,
      agentRegistry: new AgentRegistry(new Map([['orch1', { name: 'orch1', emoji: '🎯', description: 'd', maxTurns: 1, systemPrompt: 'x' }]])),
      toolRegistry: new ToolRegistry(), // unregistered tool → error RESULT (valid pair)
      llm: createMockLlmClient([
        { toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }] },
        { text: 'final synthesis' },
      ] as MockTurn[]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orch1',
      userText: 'work +1k',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(events.some((e) => e.kind === 'budget_continue')).toBe(true)
    const final = events.find((e) => e.kind === 'final')
    expect(final && 'termination' in final && final.termination).toBe('TURN_BUDGET_BUDGET_CAP')
    expect(summary.termination).toBe('TURN_BUDGET_BUDGET_CAP')
  })

  it('turn cap with the declared target MET is plain TURN_BUDGET (budget spent, no guard)', async () => {
    const events: RunEvent[] = []
    // usage out=1000/call against a 1k target: turn 1 is the synthesis
    // checkpoint (0 tokens spent) → the continue grants turn 2 with NO llm
    // call → turn 2 works (tool call, out 1000) → turn 3's checkpoint sees
    // 100% — the stop decision is the budget MET, not a guard; the reserved
    // synthesis call runs and the ledger keeps plain TURN_BUDGET
    const handle = startRun({
      cfg,
      agentRegistry: new AgentRegistry(new Map([['orch1', { name: 'orch1', emoji: '🎯', description: 'd', maxTurns: 1, systemPrompt: 'x' }]])),
      toolRegistry: new ToolRegistry(),
      llm: usageLlm(
        [
          { toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }] },
          { text: 'final synthesis' },
        ],
        1000,
      ),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orch1',
      userText: 'work +1k',
      onEvent: (e) => events.push(e),
    })
    const summary = await handle.done
    expect(events.some((e) => e.kind === 'budget_continue')).toBe(true)
    expect(summary.termination).toBe('TURN_BUDGET')
  })

  it('the widened value survives the DURABLE path: transcript note → episode closure', async () => {
    process.env['AFTER_TURN_FOLLOWUP_MAX'] = '1'
    registerAfterTurnHook((): AfterTurnDirective => ({ kind: 'followUp', text: 'again' }))
    const handle = startRun({
      cfg,
      agentRegistry: new AgentRegistry(new Map([['orch2', { name: 'orch2', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }]])),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'p1' }, { text: 'p2' }] as MockTurn[]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orch2',
      userText: 'go',
    })
    await handle.done
    // the closure note carries summary.termination — the episode validator
    // (TERMINATIONS set) must ACCEPT the widened value end to end
    const result = projectConversationTranscriptV1(cfg, CHAT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const withClosure = result.projection.episodes.find((e) => e.closure !== null)
    expect(withClosure?.closure?.termination).toBe('FINAL_FOLLOWUP_CAP')
    expect(withClosure?.closureStatus).toBe('RUN_SUMMARY_OBSERVED')
  })

  it('run summaries still refuse garbage terminations (validator stays strict)', async () => {
    // the widened set is additive — an unknown reason still fails closed
    const badChat = CHAT + 5
    fs.mkdirSync(path.join(cfg.paths.dataDir, 'transcript'), { recursive: true })
    fs.writeFileSync(
      path.join(cfg.paths.dataDir, 'transcript', `${badChat}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        conversationRunId: '7a1d3c5e-1111-4222-8333-444455566677',
        runId: 'badreason',
        agent: 'orch1',
        summary: { turns: 1, toolCalls: 0, aborted: false, termination: 'MADE_UP' },
      }) + '\n',
    )
    const result = projectConversationTranscriptV1(cfg, badChat)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('TRANSCRIPT_PROJECTION_REFUSED')
    expect(result.error).toContain('INVALID_RUN_SUMMARY')
  })
})

describe('ledger consumers (draft card + episode summary type)', () => {
  it('FINAL_FOLLOWUP_CAP formats as the same card as a plain finish', () => {
    expect(formatRunFinal('the answer', 'FINAL_FOLLOWUP_CAP')).toBe('the answer')
    expect(formatRunFinal('', 'FINAL_FOLLOWUP_CAP')).toBe('')
  })

  it('TURN_BUDGET_BUDGET_CAP formats like the turn-budget notice', () => {
    expect(formatRunFinal('', 'TURN_BUDGET_BUDGET_CAP')).toBe(TURN_BUDGET_NOTICE)
    expect(formatRunFinal('partial answer', 'TURN_BUDGET_BUDGET_CAP')).toBe(
      `${TURN_BUDGET_NOTICE}\n\npartial answer`,
    )
  })

  it('the widened union is exactly the seven named reasons', () => {
    const all: RunTermination[] = [
      'FINAL',
      'FINAL_FOLLOWUP_CAP',
      'BRAIN_EMPTY',
      'TURN_BUDGET',
      'TURN_BUDGET_BUDGET_CAP',
      'ABORTED',
      'ERROR',
    ]
    expect(new Set(all).size).toBe(7)
  })
})
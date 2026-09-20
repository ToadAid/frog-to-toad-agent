// Withhold-then-recover (north-star Tier 2 #13): recoverable brain failures
// are WITHHELD from the consumer while a single-shot recovery stage runs; the
// error surfaces only when recovery exhausts. Laws under proof:
//   · a TRANSIENT failure retries the SAME request once, then surfaces
//   · a CONTEXT_OVERFLOW failure retries only when microcompact relieves it
//   · each stage fires at most ONCE per run (the counters bound the ladder)
//   · fatal errors (auth, 4xx) surface immediately — nothing is withheld
//   · exhaustion surfaces through the UNCHANGED run-level catch (terminal
//     ERROR; no new event kinds beyond the audit-only 'recovering' mark)
//   · the draft consumer stays silent while recovering (audit-visible only)
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { MockTurn } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun, productionDeps, classifyRecoverableLlmError } from '../src/loop/agentLoop.js'
import { resetThread } from '../src/loop/context.js'
import { createDraftStream, type DraftSender } from '../src/telegram/draft.js'
import type { LlmClient } from '../src/llm/client.js'
import type { RunEvent } from '../src/types.js'

let dir: string
let cfg: Config
const CHAT = 779_001

const ORCH = (turns: number) => `---
name: orchestrator
emoji: 🎯
description: test orchestrator
maxTurns: ${turns}
---
You are a test orchestrator.
`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-recover-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  process.env['RECOVERY_BACKOFF_MS'] = '0' // deterministic: no real backoff in tests
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', 'orch2.md'), ORCH(2))
  fs.writeFileSync(path.join(dir, 'agents', 'orch1.md'), ORCH(1))
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  resetThread(CHAT)
})

const ORCHES = {
  orch2: new AgentRegistry(
    new Map([['orch2', { name: 'orch2', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }]]),
  ),
  orch1: new AgentRegistry(
    new Map([['orch1', { name: 'orch1', emoji: '🎯', description: 'd', maxTurns: 1, systemPrompt: 'x' }]]),
  ),
}

/** Scripted brain: a step either throws (the provider's failure) or answers
 * with a MockTurn. The throws carry the client's REAL error spellings so the
 * classifier is proven against production surfaces. */
type Step = { throws: string } | { turn: MockTurn }
function scriptLlm(steps: Step[]): LlmClient & { calls: () => number } {
  let i = 0
  let calls = 0
  return {
    model: 'mock-recover',
    calls: () => calls,
    async complete() {
      calls++
      const step = steps[i]
      i++
      if (!step) throw new Error('scriptLlm: script exhausted')
      if ('throws' in step) {
        const e = new Error(step.throws)
        if (step.throws.includes('TIMEOUT')) e.name = 'TimeoutError'
        throw e
      }
      const turn = step.turn
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
          usage: { in: 10, out: 10 },
        }
      }
      return { message: { role: 'assistant' as const, content: turn.text }, usage: { in: 10, out: 10 } }
    },
  }
}

function run(
  agentRegistry: AgentRegistry,
  llm: LlmClient,
  microcompactEvicted: number | undefined,
  onEvent?: (e: RunEvent) => void,
) {
  return startRun({
    cfg,
    agentRegistry,
    toolRegistry: new ToolRegistry(), // unregistered tool → error RESULT (valid pair)
    llm,
    send: createNullSender(),
    chatId: CHAT,
    agentName: agentRegistry === ORCHES.orch1 ? 'orch1' : 'orch2',
    userText: 'go',
    onEvent,
    // the #145 DI seam: a stubbed microcompact makes the overflow stage
    // deterministic (undefined = the real one, which evicts nothing here)
    deps: {
      ...productionDeps(),
      ...(microcompactEvicted !== undefined
        ? { microcompact: () => ({ evicted: microcompactEvicted, bytesSaved: 1000 }) }
        : {}),
    },
  })
}

const recovering = (events: RunEvent[]) => events.filter((e) => e.kind === 'recovering')

describe('withhold-then-recover (the ladder)', () => {
  it('a TRANSIENT failure is withheld, retried once, and the run finishes clean', async () => {
    const events: RunEvent[] = []
    const llm = scriptLlm([{ throws: 'LLM HTTP 500: internal error' }, { turn: { text: 'the answer' } }])
    const handle = run(ORCHES.orch2, llm, undefined, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(2) // the SAME request retried once
    expect(recovering(events)).toHaveLength(1)
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(summary.termination).toBe('FINAL')
  })

  it('a TRANSIENT failure that repeats EXHAUSTS the stage and surfaces as terminal ERROR', async () => {
    const events: RunEvent[] = []
    const llm = scriptLlm([
      { throws: 'LLM HTTP 429: slow down' },
      { throws: 'LLM HTTP 429: still slow' },
    ])
    const handle = run(ORCHES.orch1, llm, undefined, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(2) // one retry, no more — the counter is single-shot
    expect(recovering(events)).toHaveLength(1) // the withheld mark, once
    const error = events.find((e) => e.kind === 'error')
    expect(error && error.message).toContain('429')
    expect(summary.termination).toBe('ERROR')
  })

  it('a CONTEXT_OVERFLOW failure retries after microcompact relief and finishes clean', async () => {
    const events: RunEvent[] = []
    const llm = scriptLlm([{ throws: 'LLM HTTP 413: prompt too long' }, { turn: { text: 'the answer' } }])
    const handle = run(ORCHES.orch2, llm, 3 /* the stub evicted something */, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(2)
    expect(recovering(events)).toHaveLength(1)
    const mark = recovering(events)[0]
    expect(mark && mark.kind === 'recovering' && mark.stage).toBe('CONTEXT_OVERFLOW')
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(summary.termination).toBe('FINAL')
  })

  it('a CONTEXT_OVERFLOW with NO relief does not retry — it surfaces immediately', async () => {
    const events: RunEvent[] = []
    const llm = scriptLlm([{ throws: 'LLM HTTP 413: prompt too long' }])
    const handle = run(ORCHES.orch1, llm, 0 /* nothing evicted, no relief */, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(1) // no relief, no retry
    expect(recovering(events)).toHaveLength(0) // nothing was withheld — nothing to mark
    expect(summary.termination).toBe('ERROR')
  })

  it('a fatal error (auth) is never withheld — it surfaces immediately', async () => {
    const events: RunEvent[] = []
    const llm = scriptLlm([{ throws: 'LLM HTTP 401: invalid api key' }])
    const handle = run(ORCHES.orch1, llm, 3, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(1)
    expect(recovering(events)).toHaveLength(0)
    expect(summary.termination).toBe('ERROR')
  })

  it('a TimeoutError is classified TRANSIENT and recovered', async () => {
    const events: RunEvent[] = []
    const llm = scriptLlm([{ throws: 'LLM TIMEOUT-TOKEN request took too long' }, { turn: { text: 'ok' } }])
    const handle = run(ORCHES.orch2, llm, undefined, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(2)
    expect(summary.termination).toBe('FINAL')
    expect(recovering(events)).toHaveLength(1)
  })

  it('the two stages are INDEPENDENT counters: both may recover in one run', async () => {
    const events: RunEvent[] = []
    // turn 1: transient recovered (retry answers a tool call); turn 2 is the
    // synthesis checkpoint: overflow recovered (retry answers the synthesis)
    const llm = scriptLlm([
      { throws: 'LLM HTTP 429: slow down' },
      { turn: { toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }] } },
      { throws: 'LLM HTTP 413: context length exceeded' },
      { turn: { text: 'final synthesis' } },
    ])
    const handle = run(ORCHES.orch2, llm, 2, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(4)
    expect(recovering(events).map((e) => (e.kind === 'recovering' ? e.stage : null))).toEqual([
      'TRANSIENT',
      'CONTEXT_OVERFLOW',
    ])
    expect(summary.termination).toBe('TURN_BUDGET') // synthesis at a plain 2-turn cap, recovered en route
  })

  it('a stage counter does not reset: a second CONTEXT_OVERFLOW exhausts', async () => {
    const events: RunEvent[] = []
    const llm = scriptLlm([
      { throws: 'LLM HTTP 413: prompt too long' },
      { throws: 'LLM HTTP 413: still too long' },
    ])
    const handle = run(ORCHES.orch1, llm, 3, (e) => events.push(e))
    const summary = await handle.done
    expect(llm.calls()).toBe(2)
    expect(summary.termination).toBe('ERROR')
  })
})

describe('the classifier (pure function)', () => {
  it('classifies the production error surfaces exactly', () => {
    const timeout = new Error('request took too long')
    timeout.name = 'TimeoutError'
    expect(classifyRecoverableLlmError(timeout)).toBe('TRANSIENT')
    expect(classifyRecoverableLlmError(new Error('LLM HTTP 429: rate limited'))).toBe('TRANSIENT')
    expect(classifyRecoverableLlmError(new Error('LLM HTTP 503: upstream down'))).toBe('TRANSIENT')
    expect(classifyRecoverableLlmError(new Error('LLM request failed after 3 attempts: fetch failed'))).toBe(
      'TRANSIENT',
    )
    expect(classifyRecoverableLlmError(new Error('LLM HTTP 413: prompt too long'))).toBe('CONTEXT_OVERFLOW')
    expect(classifyRecoverableLlmError(new Error('context length exceeded'))).toBe('CONTEXT_OVERFLOW')
    // fatal: surfaces immediately
    expect(classifyRecoverableLlmError(new Error('LLM HTTP 401: invalid key'))).toBeNull()
    expect(classifyRecoverableLlmError(new Error('LLM HTTP 400: bad request'))).toBeNull()
    expect(classifyRecoverableLlmError(new Error('LLM_API_KEY required for remote providers'))).toBeNull()
  })
})

describe('the draft consumer stays silent while recovering', () => {
  it('a recovering event adds no line and sends nothing new', async () => {
    let sends = 0
    const sender: DraftSender = {
      send: async () => {
        sends++
        return sends
      },
      tryEdit: async () => true,
    }
    const draft = createDraftStream({ chatId: CHAT, sender })
    draft.onEvent({ kind: 'run_started', runId: 'r1', agent: 'orch1', chatId: CHAT })
    // the withheld mark must be audit-visible only — never a user-facing card
    draft.onEvent({ kind: 'recovering', runId: 'r1', stage: 'TRANSIENT', error: 'HTTP 429: slow down' })
    draft.dispose()
    expect(sends).toBe(1) // only the initial bubble; no error card, no extra line
  })
})
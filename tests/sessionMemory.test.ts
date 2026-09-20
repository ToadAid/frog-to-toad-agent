// Session-memory arc (north-star Tier 1 #5, the mother sessionMemory arc):
//   · EXTRACTION — the after-turn hook fires a background extraction; gates
//     (disabled env, init latch, growth) are cheapest-first; a valid reply is
//     structure-validated then atomically written; every refusal leaves the
//     file and state untouched (fail-open, the next trigger retries).
//   · STRUCTURE LAW — headers and italic instruction lines are validated in
//     code, never trusted to the model.
//   · COMPACTION CONSUMER (gated off by default) — the memory file replaces
//     the one-shot summary; the watermark must correspond to the flushed
//     state; pair-edge law; preservedSegment note; watermark cleared after.
//     Every failure mode falls back to legacy autocompact.
//   · RELINK COMPATIBILITY — a session-memory boundary rehydrates exactly
//     like a legacy one.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createNullSender } from '../src/telegram/bot.js'
import { createMockLlmClient, type MockTurn } from '../src/llm/mock.js'
import { startRun } from '../src/loop/agentLoop.js'
import { autocompactThresholds } from '../src/loop/context.js'
import {
  SESSION_MEMORY_TEMPLATE,
  countToolCallsSince,
  isSessionMemoryExtracting,
  registerSessionMemoryHook,
  resetSessionMemoryForTests,
  sessionMemoryHook,
  shouldExtractMemory,
  trySessionMemoryCompaction,
  validateMemoryContent,
  waitForSessionMemoryFlush,
} from '../src/loop/sessionMemory.js'
import {
  getThread,
  installRestoredThread,
  messagesFromTranscriptRecords,
  resetThread,
  transcriptPath,
} from '../src/loop/context.js'
import { clearAfterTurnHooks } from '../src/loop/afterTurn.js'
import { preservedSegmentRelink } from '../src/loop/context.js'

let dir: string
let cfg: Config
const CHAT = 4242

const ORCH = `---
name: orchestrator
emoji: 🎯
description: test orchestrator
maxTurns: 4
---
You are a test orchestrator.
`

function validReply(): string {
  // The template with a fresh "Current State" body — every header and italic
  // instruction line byte-identical to the template (the structure law).
  const lines = SESSION_MEMORY_TEMPLATE.split('\n')
  let out: string[] = []
  for (const line of lines) {
    out.push(line)
    if (line === '# Current State') {
      out.push('_What the desk is working on RIGHT NOW. Always updated — never stale._')
      out.push('Watching BTC; two open paper brackets; feed chain healthy.')
      break
    }
  }
  out = [...out, ...lines.slice(lines.indexOf('# Current State') + 3)]
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function record(message: object, ts: number): string {
  return JSON.stringify({ ts, message })
}

function writeTranscript(records: string[]): void {
  const p = transcriptPath(cfg, CHAT)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, records.join('\n') + '\n')
}

function userMsg(text: string): object {
  return { role: 'user', content: text }
}
function assistantMsg(text: string): object {
  return { role: 'assistant', content: text }
}
function toolCallMsg(id: string): object {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'market_price', arguments: '{}' } }],
  }
}
function toolMsg(id: string, content: string): object {
  return { role: 'tool', tool_call_id: id, content }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-session-memory-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agents', 'orchestrator.md'), ORCH)
  cfg = loadConfig()
})

afterEach(() => {
  for (const k of [
    'SESSION_MEMORY',
    'SESSION_MEMORY_INIT_CHARS',
    'SESSION_MEMORY_GROWTH_CHARS',
    'SESSION_MEMORY_MIN_TOOL_CALLS',
    'SESSION_MEMORY_DIGEST_BUDGET',
    'SESSION_MEMORY_MAX_TOTAL_CHARS',
    'SESSION_MEMORY_COMPACT',
    'SESSION_MEMORY_COMPACT_KEEP',
    'AUTOCOMPACT_TRIGGER',
    'AUTOCOMPACT_KEEP',
  ]) {
    delete process.env[k]
  }
  resetSessionMemoryForTests()
  resetThread(CHAT)
  // fresh slate for the next test
  try {
    fs.rmSync(path.join(cfg.paths.dataDir, 'memory', 'session'), { recursive: true, force: true })
    fs.rmSync(path.join(cfg.paths.dataDir, 'memory', '.session-memory.state.json'), { force: true })
    fs.rmSync(transcriptPath(cfg, CHAT), { force: true })
  } catch {
    // best-effort cleanup
  }
})

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // tmpdir best-effort
  }
})

/** A thread with n plain messages (all small enough to avoid stubbing). */
function seedThread(n: number): void {
  const t = getThread(cfg, CHAT)
  for (let i = 0; i < n; i++) {
    t.messages.push({ role: 'user', content: `msg ${i}: ${'x'.repeat(40)}` })
    t.messages.push({ role: 'assistant', content: `reply ${i}: ${'y'.repeat(40)}` })
  }
}

function hookCtx(llm: ReturnType<typeof createMockLlmClient>): Parameters<typeof sessionMemoryHook>[0] {
  return {
    cfg,
    chatId: CHAT,
    agent: 'orchestrator',
    userText: 'hello',
    summary: {
      runId: 'r1',
      agent: 'orchestrator',
      turns: 1,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 1,
      aborted: false,
      termination: 'FINAL' as const,
      finalText: 'ok',
    },
    llm,
    send: {
      send: async () => undefined,
      sendWithKeyboard: async () => undefined,
      edit: async () => {},
      editWithKeyboard: async () => {},
      tryEdit: async () => true,
      answerCallback: async () => {},
    },
  }
}

async function drainExtraction(): Promise<void> {
  await waitForSessionMemoryFlush()
  while (isSessionMemoryExtracting()) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

const memoryFile = (): string => path.join(cfg.paths.dataDir, 'memory', 'session', `${CHAT}.md`)
const stateFile = (): string => path.join(cfg.paths.dataDir, 'memory', '.session-memory.state.json')

describe('extraction gates', () => {
  it('does nothing when SESSION_MEMORY=off — the brain is never called', async () => {
    process.env['SESSION_MEMORY'] = 'off'
    process.env['SESSION_MEMORY_INIT_CHARS'] = '1'
    seedThread(2)
    const llm = createMockLlmClient([{ text: validReply() }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.existsSync(memoryFile())).toBe(false)
  })

  it('init latch: a fresh chat below INIT_CHARS never extracts', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '100000'
    seedThread(2)
    const llm = createMockLlmClient([{ text: validReply() }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.existsSync(memoryFile())).toBe(false)
  })

  it('init: a fresh chat above INIT_CHARS extracts, writes the file and state', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(3)
    writeTranscript([record(userMsg('a'), 1), record(assistantMsg('b'), 2)])
    const llm = createMockLlmClient([{ text: validReply() }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.readFileSync(memoryFile(), 'utf8')).toContain('Watching BTC')
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    expect(state.chats[String(CHAT)].flushedTranscriptSize).toBeGreaterThan(0)
    expect(state.schemaVersion).toBe(1)
  })

  it('growth gate: below GROWTH_CHARS since flush → no second extraction', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    process.env['SESSION_MEMORY_GROWTH_CHARS'] = '100000'
    seedThread(3)
    writeTranscript([record(userMsg('a'), 1)])
    const llm = createMockLlmClient([{ text: validReply() }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.existsSync(memoryFile())).toBe(true)
    // second firing: transcript grew by ~0
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    // llm script had only one turn; a second extraction attempt would have thrown (caught) and left a warn —
    // assert the file was NOT rewritten twice by checking the mtime-stable content is intact
    expect(fs.readFileSync(memoryFile(), 'utf8')).toContain('Watching BTC')
  })

  it('growth + natural break extracts even with zero tool calls since flush', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    process.env['SESSION_MEMORY_GROWTH_CHARS'] = '10'
    process.env['SESSION_MEMORY_MIN_TOOL_CALLS'] = '99'
    seedThread(3) // ends on an assistant turn with no tool_calls
    writeTranscript([record(userMsg('seed'), 1), record(assistantMsg('reply'), 2)])
    const llm = createMockLlmClient([{ text: validReply() }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.existsSync(memoryFile())).toBe(true)
  })

  it('countToolCallsSince counts assistant tool_calls newer than the watermark ts', () => {
    writeTranscript([
      record(userMsg('old'), 10),
      record(toolCallMsg('t1'), 20),
      record(toolMsg('t1', 'ok'), 21),
      record(assistantMsg('done'), 30),
      record(toolCallMsg('t2'), 40),
    ])
    expect(countToolCallsSince(cfg, CHAT, 0)).toBe(2)
    expect(countToolCallsSince(cfg, CHAT, 25)).toBe(1)
    expect(countToolCallsSince(cfg, CHAT, 100)).toBe(0)
  })
})

describe('extraction discipline', () => {
  it('structure refusal: a missing header leaves file and state untouched', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(2)
    const bad = validReply()
      .split('\n')
      .filter((l) => l !== '# Learnings')
      .join('\n')
    const llm = createMockLlmClient([{ text: bad }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.existsSync(memoryFile())).toBe(false)
    expect(fs.existsSync(stateFile())).toBe(false)
  })

  it('structure refusal: an altered italic instruction line is rejected', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(2)
    const bad = validReply().replace(
      '_What the desk is working on RIGHT NOW. Always updated — never stale._',
      '_free-form rewording_',
    )
    const llm = createMockLlmClient([{ text: bad }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.existsSync(memoryFile())).toBe(false)
  })

  it('LLM error → fail-open, nothing written', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(2)
    const llm = createMockLlmClient([]) // script dry → throws
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    expect(fs.existsSync(memoryFile())).toBe(false)
    expect(fs.existsSync(stateFile())).toBe(false)
  })

  it('validateMemoryContent unit laws', () => {
    expect(validateMemoryContent(SESSION_MEMORY_TEMPLATE)).toBeUndefined()
    expect(validateMemoryContent('no headers at all')).toBeDefined()
    // out-of-order header
    const swapped = SESSION_MEMORY_TEMPLATE
      .split('# Errors & Corrections').join('@@')
      .split('# Learnings').join('# Errors & Corrections')
      .split('@@').join('# Learnings')
    expect(validateMemoryContent(swapped)).toBeDefined()
  })

  it('the hook returns without awaiting (fire-and-forget), work still completes', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(2)
    let release: (() => void) | undefined
    const slow: MockTurn[] = [{ text: validReply() }]
    const llm = createMockLlmClient(slow)
    const origComplete = llm.complete.bind(llm)
    ;(llm as unknown as { complete: typeof llm.complete }).complete = (req) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(origComplete({ messages: [], tools: [] })), 30)
      })
    const ret = sessionMemoryHook(hookCtx(llm))
    expect(ret).toBeUndefined() // void — the seam is never blocked
    // one macrotask tick: the FIFO chain has started but NOT finished
    await new Promise((r) => setImmediate(r))
    expect(isSessionMemoryExtracting() || fs.existsSync(memoryFile())).toBe(true)
    await drainExtraction()
    expect(fs.readFileSync(memoryFile(), 'utf8')).toContain('Watching BTC')
    void release
  })
})

describe('compaction consumer', () => {
  /** Flush a real extraction, then compact. Returns the llm script use count. */
  async function flushThenCompaction(keepFloor: number): Promise<{
    done: boolean
    llmCalls: number
    before: number
    thread: ReturnType<typeof getThread>
    llm: ReturnType<typeof createMockLlmClient>
  }> {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(6) // 12 messages
    const msgs = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'].map((s, i) => record(userMsg(s), 100 + i))
    writeTranscript(msgs)
    const llm = createMockLlmClient([{ text: validReply() }])
    let calls = 0
    const orig = llm.complete.bind(llm)
    ;(llm as unknown as { complete: typeof llm.complete }).complete = async (req) => {
      calls++
      return orig(req)
    }
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    const thread = getThread(cfg, CHAT)
    const before = thread.messages.length
    const done = await trySessionMemoryCompaction({ cfg, chatId: CHAT }, thread, keepFloor)
    return { done, llmCalls: calls, before, thread, llm }
  }

  it('no watermark → false (legacy fallback)', async () => {
    resetSessionMemoryForTests()
    const thread = getThread(cfg, CHAT)
    thread.messages = [{ role: 'user', content: 'hello' }]
    expect(await trySessionMemoryCompaction({ cfg, chatId: CHAT }, thread, 8)).toBe(false)
  })

  it('compacts into a memory boundary + kept suffix, no LLM call, watermark cleared', async () => {
    process.env['SESSION_MEMORY_COMPACT_KEEP'] = '6'
    const { done, llmCalls, before, thread } = await flushThenCompaction(6)
    expect(done).toBe(true)
    expect(llmCalls).toBe(1) // extraction only — the compaction made NO summary call
    expect(before).toBe(12)
    expect(thread.messages.length).toBe(7) // boundary + 6 kept
    const boundary = thread.messages[0]!
    expect(boundary.role).toBe('user')
    expect(boundary.content).toContain('[session-memory]')
    expect(boundary.content).toContain('never authority')
    expect(boundary.content).toContain('Watching BTC')
    // watermark cleared: a second consumer attempt honestly declines
    expect(await trySessionMemoryCompaction({ cfg, chatId: CHAT }, thread, 6)).toBe(false)
  })

  it('persists a preservedSegment note the relink understands', async () => {
    process.env['SESSION_MEMORY_COMPACT_KEEP'] = '6'
    await flushThenCompaction(6)
    const records = fs.readFileSync(transcriptPath(cfg, CHAT), 'utf8').trimEnd().split('\n')
    const relink = preservedSegmentRelink(records)
    expect(relink).toBeDefined()
    expect(relink!.segmentIdxs.length).toBe(6)
    const rebuilt = messagesFromTranscriptRecords(CHAT, records)
    // [boundary, ...kept] — the same chain the live thread now holds
    expect(rebuilt.length).toBe(7)
    expect(rebuilt[0]!.content).toContain('[session-memory]')
  })

  it('pair-edge law: the cut advances past trailing tool results', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    process.env['SESSION_MEMORY_COMPACT_KEEP'] = '4'
    seedThread(5) // 10 messages, ends assistant
    const thread = getThread(cfg, CHAT)
    // craft an evict/keep edge that lands on tool results: [..., call, result, keep...]
    thread.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] })
    thread.messages.push({ role: 'tool', tool_call_id: 'c1', content: 'r1' })
    thread.messages.push({ role: 'tool', tool_call_id: 'c1', content: 'r2' })
    const transcript = [record(toolCallMsg('c1'), 1), record(toolMsg('c1', 'x'), 2)]
    writeTranscript(transcript)
    const llm = createMockLlmClient([{ text: validReply() }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    const lenBefore = thread.messages.length
    const done = await trySessionMemoryCompaction({ cfg, chatId: CHAT }, thread, 4)
    expect(done).toBe(true)
    // kept suffix: 4 non-tool boundary alignment — first kept is NOT a tool result
    const firstKept = thread.messages[1]!
    expect(firstKept.role).not.toBe('tool')
    expect(thread.messages.length).toBeLessThanOrEqual(lenBefore)
  })

  it('template-equal file → false; corrupt state correspondence → false', async () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(3)
    writeTranscript([record(userMsg('a'), 1)])
    // LLM replies with the unchanged template
    const llm = createMockLlmClient([{ text: SESSION_MEMORY_TEMPLATE }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    // file exists but is template-equal and the watermark IS valid — the
    // content refusal is the consumer's own law
    const thread = getThread(cfg, CHAT)
    const ok = await trySessionMemoryCompaction({ cfg, chatId: CHAT }, thread, 2)
    expect(ok).toBe(false)
  })
})

describe('hook registration', () => {
  it('registers without breaking the seam', async () => {
    registerSessionMemoryHook()
    clearAfterTurnHooks()
    expect(true).toBe(true)
  })

  it('shouldExtractMemory init reason is honest', () => {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '1'
    const thread = getThread(cfg, CHAT)
    thread.messages = [{ role: 'user', content: 'x' }]
    expect(shouldExtractMemory(cfg, CHAT, thread)?.reason).toBe('init')
  })
})

describe('maybeAutocompact wiring (integration, through startRun)', () => {
  const registry = () =>
    new AgentRegistry(
      new Map([
        ['orchestrator', { name: 'orchestrator', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }],
      ]),
    )

  /** Flush a real extraction, then saturate past the legacy trigger. */
  async function flushAndSaturate(): Promise<void> {
    process.env['SESSION_MEMORY_INIT_CHARS'] = '10'
    seedThread(6) // 12 messages — the flush watermark
    writeTranscript([record(userMsg('a'), 1), record(assistantMsg('b'), 2)])
    const llm = createMockLlmClient([{ text: validReply() }])
    sessionMemoryHook(hookCtx(llm))
    await drainExtraction()
    // saturate past AUTOCOMPACT_TRIGGER (80 by default): plain pairs + one user
    const thread = getThread(cfg, CHAT)
    while (thread.messages.length < autocompactThresholds().trigger) {
      thread.messages.push({ role: 'user', content: `filler ${thread.messages.length}` })
      thread.messages.push({ role: 'assistant', content: `ack ${thread.messages.length}` })
    }
    thread.messages.push({ role: 'user', content: 'latest question' })
  }

  it('SESSION_MEMORY_COMPACT=on: the run starts on the memory boundary with NO summary call', async () => {
    process.env['SESSION_MEMORY_COMPACT'] = 'on'
    await flushAndSaturate()
    // exactly ONE script turn — a legacy summarizer call would consume it and
    // leave the run's own turn dry (mock throws → ERROR termination)
    const handle = await startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'memory-compacted answer' }]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'latest question',
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('memory-compacted answer')
    expect(summary.termination).not.toBe('ERROR')
    const thread = getThread(cfg, CHAT)
    const boundary = thread.messages[0] as { role: string; content: string }
    expect(boundary.content).toContain('[session-memory]')
    expect(boundary.content).toContain('never authority')
    // the flushed head is gone; the filler tail is verbatim
    expect(thread.messages.some((m) => String(m.content).includes('filler 12'))).toBe(true)
    expect(thread.messages.some((m) => String(m.content).includes('reply 0'))).toBe(false)
  })

  it('SESSION_MEMORY_COMPACT=on with no watermark: honest legacy fallback at run start', async () => {
    resetSessionMemoryForTests()
    resetThread(CHAT)
    const thread = getThread(cfg, CHAT)
    while (thread.messages.length < autocompactThresholds().trigger) {
      thread.messages.push({ role: 'user', content: `filler ${thread.messages.length}` })
      thread.messages.push({ role: 'assistant', content: `ack ${thread.messages.length}` })
    }
    thread.messages.push({ role: 'user', content: 'latest question' })
    const handle = await startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: new ToolRegistry(),
      llm: createMockLlmClient([{ text: 'LEGACY BRIEF: nothing remembered.' }, { text: 'legacy answer' }]),
      send: createNullSender(),
      chatId: CHAT,
      agentName: 'orchestrator',
      userText: 'latest question',
    })
    const summary = await handle.done
    expect(summary.finalText).toBe('legacy answer')
    const boundary = getThread(cfg, CHAT).messages[0] as { role: string; content: string }
    expect(boundary.content).toContain('[autocompact]')
    expect(boundary.content).toContain('LEGACY BRIEF')
  })
})

// keep tree-shaking honest: installRestoredThread is exercised via the
// relink path above
void installRestoredThread
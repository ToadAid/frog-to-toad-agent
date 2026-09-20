// Dream (batch-2 PR 1, the mother-repo autoDream pattern): background memory
// consolidation behind cheapest-first gates (hands → time → throttle →
// sessions → atomic lease). The dream acts ONLY through the guarded §-ops
// memory_save uses; USER.md is out of scope (principal-admission law); state
// (.dream.state.json) is separate from the lease (.dream.lease); a failed
// dream never writes state, so the prior window re-arms.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { createMockLlmClient, type MockTurn } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import type { AfterTurnContext } from '../src/loop/afterTurn.js'
import type { LlmClient } from '../src/llm/client.js'
import type { ChatMessage } from '../src/types.js'
import {
  collectStores,
  dreamHook,
  observeLease,
  readLastConsolidatedAt,
  releaseLease,
  resetDreamStateForTests,
  setDreamReleaseSeamForTests,
  transcriptsSince,
  tryClaimLease,
  type DreamLeaseClaim,
} from '../src/loop/dream.js'
import { resetThread } from '../src/loop/context.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-dream-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  resetThread(246970100)
})

beforeEach(() => {
  resetDreamStateForTests()
  delete process.env['DREAM_MIN_HOURS']
  delete process.env['DREAM_MIN_SESSIONS']
  delete process.env['DREAM_OFF']
  // Fresh lab: doctor open, no state, no lease, no stores, no transcripts.
  fs.rmSync(path.join(cfg.paths.dataDir, 'memory'), { recursive: true, force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'transcript'), { recursive: true, force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'workspace', 'DESK.md'), { force: true })
  fs.mkdirSync(path.join(cfg.paths.dataDir, 'state'), { recursive: true })
  fs.writeFileSync(
    path.join(cfg.paths.dataDir, 'state', 'doctor.json'),
    JSON.stringify({ lastRunTs: Date.now(), cheapOk: true, lastTestGreenAt: Date.now() }),
  )
})

const CHAT = 246970100
const MEMORY_DIR = () => path.join(cfg.paths.dataDir, 'memory')
const DESK_FILE = () => path.join(cfg.paths.dataDir, 'workspace', 'DESK.md')

function makeCtx(overrides: Partial<AfterTurnContext> = {}): AfterTurnContext {
  return {
    cfg,
    chatId: CHAT,
    agent: 'orchestrator',
    userText: '[scheduled] nightly watch',
    summary: {
      runId: 'run-1',
      agent: 'orchestrator',
      turns: 1,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      aborted: false,
      termination: 'FINAL',
      finalText: 'ok',
    },
    llm: createMockLlmClient([{ text: 'NO_UPDATE' }]),
    send: createNullSender(),
    ...overrides,
  }
}

/** Consolidation state 24h+ ago → the time gate passes. */
function ageState(hoursAgo: number): void {
  fs.mkdirSync(MEMORY_DIR(), { recursive: true })
  record({ lastConsolidatedAt: Date.now() - hoursAgo * 3_600_000 })
  function record(state: object): void {
    fs.writeFileSync(path.join(MEMORY_DIR(), '.dream.state.json'), JSON.stringify(state))
  }
}

/**
 * A production-shaped transcript: `{ ts, message: ChatMessage }` envelopes.
 * `extra` rows are appended verbatim (notes, malformed rows…).
 */
function seedTranscript(name: string, hoursAgo: number, rows: Array<ChatMessage | object | string>): void {
  fs.mkdirSync(path.join(cfg.paths.dataDir, 'transcript'), { recursive: true })
  const file = path.join(cfg.paths.dataDir, 'transcript', name)
  fs.writeFileSync(
    file,
    rows
      .map((r) =>
        typeof r === 'string'
          ? r // verbatim raw row (malformed / note shapes)
          : 'message' in r
            ? JSON.stringify({ ts: Date.now() - hoursAgo * 3_600_000, ...r })
            : JSON.stringify(r),
      )
      .join('\n') + '\n',
  )
  const when = new Date(Date.now() - hoursAgo * 3_600_000)
  fs.utimesSync(file, when, when)
}

function msg(role: 'user' | 'assistant', content: string): { message: ChatMessage } {
  return { message: { role, content } as ChatMessage }
}

function seedDesk(entries: string[]): void {
  fs.mkdirSync(path.join(cfg.paths.dataDir, 'workspace'), { recursive: true })
  fs.writeFileSync(DESK_FILE(), entries.map((e) => `§${e}`).join('\n'))
}

/** LlmClient spy: records every request, delegates to the scripted mock. */
function spyLlm(mock: LlmClient, calls: Array<{ messages: Array<{ content?: unknown }> }>): LlmClient {
  return {
    model: 'spy-1',
    complete: async (req: { messages: Array<{ content?: unknown }> }) => {
      calls.push(req)
      return mock.complete(req as Parameters<typeof mock.complete>[0])
    },
  } as unknown as LlmClient
}

/** Mock that returns scripted turns, then throws — the down-brain path. */
function llmThatThrowsAfter(script: MockTurn[]): LlmClient {
  const inner = createMockLlmClient(script)
  let i = 0
  return {
    model: 'throw-after',
    complete: async (req: Parameters<LlmClient['complete']>[0]) => {
      const turn = script[i]
      i++
      if (!turn) throw new Error('dream brain down')
      return inner.complete(req)
    },
  } as unknown as LlmClient
}

/** Two fresh external transcripts — the minimum the session gate accepts. */
function seedTwoFreshTranscripts(): void {
  seedTranscript('100.jsonl', 1, [msg('user', 'the zai feed dropped quotes for 3 minutes'), msg('assistant', 'backup feed took over')])
  seedTranscript('200.jsonl', 2, [msg('user', 'groq whisper free tier works fine')])
}

const stateIsFresh = (): boolean => Date.now() - readLastConsolidatedAt(cfg) < 60_000

const LEASE_FILE = () => path.join(MEMORY_DIR(), '.dream.lease')

/** Write a well-formed lease document directly (test fixture). */
function seedLease(token: string, acquiredAt: number): void {
  fs.mkdirSync(MEMORY_DIR(), { recursive: true })
  fs.writeFileSync(LEASE_FILE(), JSON.stringify({ version: 1, token, acquiredAt, pid: process.pid }))
}

const onDiskLeaseToken = (): string => JSON.parse(fs.readFileSync(LEASE_FILE(), 'utf8'))['token'] as string

describe('gates', () => {
  it('skips aborted runs, DREAM_OFF, and a closed hands gate without touching state', async () => {
    const abortedCtx = makeCtx({
      summary: {
        runId: 'run-1',
        agent: 'orchestrator',
        turns: 1,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
        aborted: true,
        termination: 'ABORTED',
        finalText: '',
      },
    })
    await dreamHook(abortedCtx)
    process.env['DREAM_OFF'] = '1'
    await dreamHook(makeCtx())
    delete process.env['DREAM_OFF']
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'state', 'doctor.json'), JSON.stringify({ lastRunTs: 0, cheapOk: false, lastTestGreenAt: 0 }))
    await dreamHook(makeCtx()) // hands gated → shut
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.state.json'))).toBe(false)
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.lease'))).toBe(false)
  })

  it('skips when the time gate has not passed and leaves the state untouched', async () => {
    ageState(1)
    await dreamHook(makeCtx())
    expect(Date.now() - readLastConsolidatedAt(cfg) > 55 * 60_000).toBe(true) // ~1h ago still
  })

  it('skips when the session gate has not passed (no fresh transcripts)', async () => {
    ageState(48)
    await dreamHook(makeCtx())
    expect(Date.now() - readLastConsolidatedAt(cfg) > 47 * 3_600_000).toBe(true) // still ~48h ago
  })

  it('skips when another dream holds a fresh lease (time gate forced open)', async () => {
    process.env['DREAM_MIN_HOURS'] = '0' // bypass the time gate; the lease gate is under test
    seedLease('holder-token', Date.now())
    await dreamHook(makeCtx())
    expect(onDiskLeaseToken()).toBe('holder-token') // untouched
  })

  it('STALE lease fails closed: claim loses, the file is never mutated', () => {
    seedLease('dead-holder', Date.now() - 2 * 3_600_000) // acquiredAt 2h ago → stale
    const before = fs.readFileSync(LEASE_FILE(), 'utf8')
    expect(tryClaimLease(cfg)).toBeNull() // stale is NOT permission to steal
    expect(fs.readFileSync(LEASE_FILE(), 'utf8')).toBe(before) // bytes unchanged
    expect(onDiskLeaseToken()).toBe('dead-holder') // token unchanged
    expect(fs.readdirSync(MEMORY_DIR()).filter((f) => f.includes('.reclaim-'))).toEqual([]) // no scratch
  })

  it('skips the run\'s own transcript in the session gate', () => {
    seedTranscript(`${CHAT}.jsonl`, 0, [msg('user', 'self')])
    seedTranscript('999.jsonl', 0, [msg('user', 'other')])
    expect(transcriptsSince(cfg, 0, CHAT)).toEqual(['999.jsonl'])
  })
})

describe('the transcript envelope', () => {
  it('feeds two production-shaped external transcripts to the dream request, ignoring notes, malformed rows, and the current chat', async () => {
    process.env['DREAM_MIN_HOURS'] = '0'
    seedTranscript('100.jsonl', 1, [
      msg('user', 'EVIDENCE-ONE zai feed gap at 14:02'),
      { ts: '2026-09-07T12:00:00Z', note: 'transcript rotated' }, // no message → ignored
      'this line is not JSON', // malformed → skipped, fail open
      msg('assistant', 'EVIDENCE-TWO backup feed took over'),
    ])
    seedTranscript('200.jsonl', 1, [msg('user', 'EVIDENCE-THREE groq whisper free tier')])
    seedTranscript(`${CHAT}.jsonl`, 0, [msg('user', 'SELF-CHAT-EXCLUDED must not reach the dream')])

    const calls: Array<{ messages: Array<{ content?: unknown }> }> = []
    await dreamHook(makeCtx({ llm: spyLlm(createMockLlmClient([{ text: 'NO_UPDATE' }]), calls) }))

    // One store (DESK.md only), one request, and the request carries the
    // evidence from BOTH external transcripts.
    expect(calls).toHaveLength(1)
    const prompt = String(calls[0]!.messages[0]!.content)
    expect(prompt).toContain('EVIDENCE-ONE')
    expect(prompt).toContain('EVIDENCE-TWO')
    expect(prompt).toContain('EVIDENCE-THREE')
    expect(prompt).not.toContain('transcript rotated') // note row ignored
    expect(prompt).not.toContain('SELF-CHAT-EXCLUDED')
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.state.json'))).toBe(true)
  })
})

describe('the dream itself', () => {
  it('consolidates through the guarded ops and sends the 🌙 card', async () => {
    ageState(48)
    seedTwoFreshTranscripts()
    seedDesk(['old fact from yesterday'])
    const llm = createMockLlmClient([
      { text: '```json\n[{"action":"add","content":"ZAI FEED GAP (2026-09-07): 3-minute quote drop at 14:02 UTC; backup feed took over."}]\n```' },
    ])
    const sent: string[] = []
    const events: unknown[] = []
    await dreamHook(
      makeCtx({
        llm,
        send: { send: async (_chatId: number, text: string) => void sent.push(text) } as AfterTurnContext['send'],
        onEvent: (e) => void events.push(e),
      }),
    )
    const desk = fs.readFileSync(DESK_FILE(), 'utf8')
    expect(desk).toContain('ZAI FEED GAP (2026-09-07)')
    expect(desk).toContain('old fact from yesterday') // add, not rewrite
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/🌙 dream consolidated — 1 memory op across 1 store/)
    expect(events).toHaveLength(1)
    expect(stateIsFresh()).toBe(true) // completion recorded
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.lease'))).toBe(false) // lease released
  })

  it('records the consolidation window even when every store answers NO_UPDATE', async () => {
    ageState(48)
    seedTwoFreshTranscripts()
    await dreamHook(makeCtx({ llm: createMockLlmClient([{ text: 'NO_UPDATE' }]) }))
    expect(stateIsFresh()).toBe(true)
    expect(fs.existsSync(DESK_FILE())).toBe(false) // nothing written
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.lease'))).toBe(false)
  })
})

describe('atomicity', () => {
  it('two concurrent dream attempts: exactly one winner', async () => {
    ageState(48)
    seedTwoFreshTranscripts()
    seedDesk(['seed fact'])
    // One store (DESK.md) → the winner makes exactly ONE llm call; a second
    // attempt slipping through would exhaust the script and throw loudly.
    const llm = createMockLlmClient([{ text: '[{"action":"add","content":"concurrent proof"}]' }])
    const sent: string[] = []
    const ctxA = makeCtx({
      llm,
      send: { send: async (_c: number, t: string) => void sent.push(t) } as AfterTurnContext['send'],
    })
    const ctxB = makeCtx({
      llm,
      send: { send: async (_c: number, t: string) => void sent.push(t) } as AfterTurnContext['send'],
    })
    await Promise.all([dreamHook(ctxA), dreamHook(ctxB)])
    expect(sent).toHaveLength(1) // exactly one winner
    const desk = fs.readFileSync(DESK_FILE(), 'utf8')
    expect(desk.match(/concurrent proof/g)).toHaveLength(1) // applied once, not twice
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.lease'))).toBe(false)
    expect(stateIsFresh()).toBe(true)
  })

  it('no partial learning: a phase-1 llm throw leaves EVERY store unchanged and re-arms the window', async () => {
    ageState(48)
    seedTwoFreshTranscripts()
    seedDesk(['desk seed fact'])
    fs.mkdirSync(MEMORY_DIR(), { recursive: true })
    fs.writeFileSync(path.join(MEMORY_DIR(), 'researcher.md'), '§agent seed note')
    // Store 1 (DESK.md) returns a valid op; store 2 (researcher.md) throws —
    // the throw must land in phase 1, BEFORE the DESK op was ever applied.
    const llm = llmThatThrowsAfter([
      { text: '[{"action":"add","content":"DESK op that must NOT be applied"}]' },
    ])
    await dreamHook(makeCtx({ llm }))
    const desk = fs.readFileSync(DESK_FILE(), 'utf8')
    expect(desk).not.toContain('DESK op that must NOT be applied')
    expect(desk).toContain('desk seed fact')
    expect(fs.readFileSync(path.join(MEMORY_DIR(), 'researcher.md'), 'utf8')).toContain('agent seed note')
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.state.json'))).toBe(true)
    expect(stateIsFresh()).toBe(false) // state untouched — still ~48h: re-armed
    expect(fs.existsSync(path.join(MEMORY_DIR(), '.dream.lease'))).toBe(false) // released
  })
})

describe('lease ownership', () => {
  it('1+2 · fresh O_EXCL claim succeeds; second fresh claimant loses', () => {
    const a = tryClaimLease(cfg)
    expect(a).not.toBeNull()
    const doc = JSON.parse(fs.readFileSync(LEASE_FILE(), 'utf8'))
    expect(doc['token']).toBe(a!.token)
    expect(doc['version']).toBe(1)
    expect(typeof doc['acquiredAt']).toBe('number')
    expect(observeLease(cfg)).toBe('HELD')
    const b = tryClaimLease(cfg)
    expect(b).toBeNull() // fresh holder — loses cleanly
    expect(onDiskLeaseToken()).toBe(a!.token) // untouched
    releaseLease(cfg, a!)
    expect(fs.existsSync(LEASE_FILE())).toBe(false)
  })

  it('3 · correct owner release removes the lease', () => {
    seedLease('real-owner', Date.now())
    releaseLease(cfg, { token: 'real-owner' })
    expect(fs.existsSync(LEASE_FILE())).toBe(false)
  })

  it('4 · wrong-token release leaves the lease untouched', () => {
    seedLease('real-owner-2', Date.now())
    releaseLease(cfg, { token: 'impostor' })
    expect(onDiskLeaseToken()).toBe('real-owner-2') // untouched
    expect(observeLease(cfg)).toBe('HELD')
  })

  it('5 · malformed lease release never unlinks', () => {
    seedLease('owner', Date.now())
    fs.writeFileSync(LEASE_FILE(), 'not a lease document at all')
    releaseLease(cfg, { token: 'owner' }) // malformed → not provably ours → do NOT delete
    expect(fs.readFileSync(LEASE_FILE(), 'utf8')).toBe('not a lease document at all')
    expect(observeLease(cfg)).toBe('MALFORMED')
  })

  it('6 · vanished lease release is a safe no-op', () => {
    expect(() => releaseLease(cfg, { token: 'ghost' })).not.toThrow()
  })

  it('7 · well-formed STALE lease: claim returns null, file byte-identical, nothing renamed or unlinked', () => {
    seedLease('stale-holder', Date.now() - 2 * 3_600_000)
    const before = fs.readFileSync(LEASE_FILE(), 'utf8')
    expect(tryClaimLease(cfg)).toBeNull()
    expect(fs.readFileSync(LEASE_FILE(), 'utf8')).toBe(before)
    expect(onDiskLeaseToken()).toBe('stale-holder')
    expect(fs.readdirSync(MEMORY_DIR()).filter((f) => f.includes('.reclaim-'))).toEqual([]) // no scratch files
  })

  it('8 · malformed STALE lease: claim returns null, file remains byte-identical', () => {
    fs.mkdirSync(MEMORY_DIR(), { recursive: true })
    fs.writeFileSync(LEASE_FILE(), 'corrupted beyond parsing')
    const old = new Date(Date.now() - 2 * 3_600_000)
    fs.utimesSync(LEASE_FILE(), old, old)
    expect(tryClaimLease(cfg)).toBeNull() // fail closed — nobody "owns" a malformed doc either
    expect(fs.readFileSync(LEASE_FILE(), 'utf8')).toBe('corrupted beyond parsing')
    expect(observeLease(cfg)).toBe('MALFORMED')
  })

  it('9 · no compliant claimant can acquire between owner verification and unlink (release TOCTOU)', () => {
    const a = tryClaimLease(cfg)
    expect(a).not.toBeNull()
    let bClaim: DreamLeaseClaim | null | undefined
    // Seam fires AFTER A verifies its token, BEFORE A unlinks — the exact
    // window the old release TOCTOU concern named. B must find the pathname
    // still occupied by A's lease and lose; automatic stale reclaim no longer
    // exists to save it.
    setDreamReleaseSeamForTests(() => {
      setDreamReleaseSeamForTests(undefined) // B must not re-enter the seam
      bClaim = tryClaimLease(cfg)
    })
    releaseLease(cfg, a!)
    setDreamReleaseSeamForTests(undefined)

    expect(bClaim).toBeNull() // A's lease pathname was still there
    expect(fs.existsSync(LEASE_FILE())).toBe(false) // A completed the release
  })

  it('10 · after legitimate release, the next fresh claimant acquires', () => {
    const a = tryClaimLease(cfg)
    expect(a).not.toBeNull()
    releaseLease(cfg, a!)
    const b = tryClaimLease(cfg)
    expect(b).not.toBeNull()
    expect(b!.token).not.toBe(a!.token)
    expect(onDiskLeaseToken()).toBe(b!.token)
    releaseLease(cfg, b!)
    expect(fs.existsSync(LEASE_FILE())).toBe(false)
  })

  it('11 · no reclaim scratch path can be produced anywhere', () => {
    seedLease('stale-holder', Date.now() - 2 * 3_600_000)
    void tryClaimLease(cfg) // stale → loses, no mutation
    void tryClaimLease(cfg) // second look must behave identically
    const names = fs.readdirSync(MEMORY_DIR())
    expect(names.filter((f) => f.includes('.reclaim-'))).toEqual([])
    expect(names.filter((f) => f.startsWith('.dream.lease') && f !== '.dream.lease')).toEqual([])
  })
})

describe('store surface', () => {
  it('excludes USER.md from the store list', () => {
    fs.mkdirSync(MEMORY_DIR(), { recursive: true })
    fs.writeFileSync(path.join(MEMORY_DIR(), 'orchestrator.md'), '§agent note')
    const labels = collectStores(cfg).map((s) => s.label)
    expect(labels).toEqual(['DESK.md', 'memory/orchestrator.md'])
  })

  it('applies ops to agent memory files through the same guarded lane', async () => {
    ageState(48)
    seedTwoFreshTranscripts()
    fs.mkdirSync(MEMORY_DIR(), { recursive: true })
    fs.writeFileSync(path.join(MEMORY_DIR(), 'researcher.md'), '§stale research note')
    const llm = createMockLlmClient([
      { text: 'NO_UPDATE' }, // DESK.md
      { text: '[{"action":"replace","find":"stale research note","content":"fresh research note (2026-09-07)"}]' },
    ])
    await dreamHook(makeCtx({ llm }))
    const mem = fs.readFileSync(path.join(MEMORY_DIR(), 'researcher.md'), 'utf8')
    expect(mem).toContain('fresh research note (2026-09-07)')
    expect(mem).not.toContain('stale research note')
  })
})
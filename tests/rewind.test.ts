// /rewind — run checkpoints + transcript rewind (resume/rewind cut).
// Laws under test: a checkpoint is recorded before the work it may undo;
// rewind restores the durable transcript (record-boundary truncate) and
// rebuilds the live window from it; rewind is a principal act with the exact
// private-principal gate; checkpoint/rewind serialize through the run queue.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  appendToThread,
  getThread,
  installRestoredThread,
  messagesFromTranscriptRecords,
  readTranscriptSnapshot,
  resetThread,
  restoreThreads,
  transcriptPath,
} from '../src/loop/context.js'
import {
  applyRewind,
  formatCheckpointList,
  listCheckpoints,
  recordCheckpoint,
  transcriptPrefixDigest,
} from '../src/loop/rewind.js'
import { handleRewindCommand } from '../src/telegram/bot.js'
import { startStatusServer } from '../src/status/http.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createMockLlmClient } from '../src/llm/mock.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startRun } from '../src/loop/agentLoop.js'
import http from 'node:http'
import type { ChatMessage } from '../src/types.js'

let dir: string
let cfg: Config
const ADMIN = 500

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-rewind-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  process.env['TELEGRAM_ADMIN_CHAT_ID'] = String(ADMIN)
  process.env['TELEGRAM_PRINCIPAL_USER_ID'] = String(ADMIN)
  cfg = loadConfig()
  expect(cfg.telegram.adminChatId).toBe(ADMIN)
  expect(cfg.telegram.principalUserId).toBe(ADMIN)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env['TELEGRAM_ADMIN_CHAT_ID']
  delete process.env['TELEGRAM_PRINCIPAL_USER_ID']
})

/** Simulate a run's durable footprint: checkpoint first, then appends. */
function fakeRun(chatId: number, prompt: string, after: ChatMessage[]): void {
  recordCheckpoint(cfg, chatId, prompt)
  const thread = getThread(cfg, chatId)
  appendToThread(cfg, thread, { role: 'user', content: prompt })
  for (const m of after) appendToThread(cfg, thread, m)
}

function transcriptLines(chatId: number): string[] {
  const p = transcriptPath(cfg, chatId)
  if (!fs.existsSync(p)) return []
  const raw = fs.readFileSync(p, 'utf8').trimEnd()
  return raw === '' ? [] : raw.split('\n')
}

describe('rewind core', () => {
  it('recordCheckpoint captures ts/lines/preview with the preview capped', () => {
    const chatId = 60100
    fakeRun(chatId, 'x'.repeat(200), [{ role: 'assistant', content: 'done' }])
    const cps = listCheckpoints(cfg, chatId)
    expect(cps).toHaveLength(1)
    expect(cps[0]!.lines).toBe(0) // recorded BEFORE the run touched anything
    expect(cps[0]!.preview).toHaveLength(80)
    expect(cps[0]!.ts).toBeGreaterThan(0)
  })

  it('checkpoints are a bounded ring (REWIND_MAX_CHECKPOINTS)', () => {
    const chatId = 60101
    process.env['REWIND_MAX_CHECKPOINTS'] = '4'
    try {
      for (let i = 0; i < 6; i++) fakeRun(chatId, `run ${i}`, [])
      const cps = listCheckpoints(cfg, chatId)
      expect(cps).toHaveLength(4)
      expect(cps[0]!.preview).toBe('run 2') // oldest two evicted
      expect(cps[3]!.preview).toBe('run 5')
    } finally {
      delete process.env['REWIND_MAX_CHECKPOINTS']
    }
  })

  it('applyRewind 1 truncates to the boundary, rebuilds the window, prunes checkpoints', () => {
    const chatId = 60102
    resetThread(chatId)
    fakeRun(chatId, 'first run', [
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'm', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ])
    fakeRun(chatId, 'second run', [{ role: 'assistant', content: 'second final' }])
    expect(transcriptLines(chatId)).toHaveLength(5)
    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(true)
    // The undone run's prompt + its turn records are gone; run 1's records
    // (user, assistant tool_call, tool result) survive intact.
    expect(transcriptLines(chatId)).toHaveLength(3)
    const messages = getThread(cfg, chatId).messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[0]!.content).toBe('first run')
    expect(res.text).toContain('dropped 2 transcript record(s)')
    expect(res.text).toContain('second run') // the undone run's preview
    expect(listCheckpoints(cfg, chatId)).toHaveLength(1)
  })

  it('applyRewind 2 rewinds past two runs and the atomic write leaves no tmp litter', () => {
    const chatId = 60103
    resetThread(chatId)
    fakeRun(chatId, 'run A', [{ role: 'assistant', content: 'a' }])
    fakeRun(chatId, 'run B', [{ role: 'assistant', content: 'b' }])
    const res = applyRewind(cfg, chatId, 2)
    expect(res.ok).toBe(true)
    expect(transcriptLines(chatId)).toHaveLength(0)
    expect(getThread(cfg, chatId).messages).toHaveLength(0)
    expect(listCheckpoints(cfg, chatId)).toHaveLength(0)
    const leftovers = fs.readdirSync(path.dirname(transcriptPath(cfg, chatId))).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    const raw = fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')
    expect(raw).toBe('') // truncation to zero writes an empty file, not a bare newline
  })

  it('applyRewind refuses honestly: bad n, no checkpoints, too many, moved state', () => {
    const chatId = 60104
    expect(applyRewind(cfg, chatId, 0).error).toContain('usage')
    expect(applyRewind(cfg, chatId, 1.5).error).toContain('usage')
    expect(applyRewind(cfg, chatId, 1).error).toContain('no checkpoints yet')
    fakeRun(chatId, 'only run', [])
    expect(applyRewind(cfg, chatId, 2).error).toContain('only 1 checkpoint(s) exist')
    // Transcript truncated out from under us → refuse, never destroy blindly.
    fakeRun(chatId, 'second', []) // this checkpoint claims 1 durable record
    fs.writeFileSync(transcriptPath(cfg, chatId), '') // ...but the file is empty now
    expect(applyRewind(cfg, chatId, 1).error).toContain('state moved under us')
  })

  it('formatCheckpointList lists most-recent-first and admits the empty case', () => {
    const chatId = 60105
    expect(formatCheckpointList(cfg, chatId)).toContain('no checkpoints yet')
    fakeRun(chatId, 'alpha', [])
    fakeRun(chatId, 'beta', [])
    const text = formatCheckpointList(cfg, chatId)
    const betaIdx = text.indexOf('beta')
    const alphaIdx = text.indexOf('alpha')
    expect(betaIdx).toBeGreaterThan(-1)
    expect(betaIdx).toBeLessThan(alphaIdx)
    expect(text).toContain('/rewind <n>')
  })

  it('restoreThreads still rehydrates after a rewind (single-chat helper parity)', () => {
    const chatId = 60106
    resetThread(chatId)
    fakeRun(chatId, 'keep me', [{ role: 'assistant', content: 'kept final' }])
    fakeRun(chatId, 'drop me', [{ role: 'assistant', content: 'dropped final' }])
    expect(applyRewind(cfg, chatId, 1).ok).toBe(true)
    resetThread(chatId)
    expect(restoreThreads(cfg)).toBeGreaterThanOrEqual(1)
    expect(getThread(cfg, chatId).messages.map((m) => m.content)).toEqual(['keep me', 'kept final'])
  })
})

describe('F1 — observation truth (unknown is not empty)', () => {
  it('1A: an unreadable transcript SKIPS the checkpoint — no forged lines=0', () => {
    const chatId = 60107
    resetThread(chatId)
    // Deterministic CI-safe read failure: the transcript path is a DIRECTORY,
    // so readFileSync throws EISDIR — no chmod dependency.
    fs.mkdirSync(transcriptPath(cfg, chatId), { recursive: true })
    try {
      expect(() => recordCheckpoint(cfg, chatId, 'should not be recorded')).not.toThrow()
      const cps = listCheckpoints(cfg, chatId)
      expect(cps).toHaveLength(0) // no checkpoint — and specifically none with lines === 0
    } finally {
      fs.rmdirSync(transcriptPath(cfg, chatId))
    }
  })

  it('1A: the run-side caller survives a skipped checkpoint (fail open for the run)', () => {
    const chatId = 60108
    resetThread(chatId)
    fs.mkdirSync(transcriptPath(cfg, chatId), { recursive: true })
    try {
      // The agentLoop call shape: checkpoint failure must not break the run.
      const before = Date.now()
      expect(() => recordCheckpoint(cfg, chatId, 'run continues anyway')).not.toThrow()
      expect(Date.now()).toBeGreaterThanOrEqual(before)
      expect(listCheckpoints(cfg, chatId)).toHaveLength(0)
    } finally {
      fs.rmdirSync(transcriptPath(cfg, chatId))
    }
  })

  it('missing transcript is a VALID empty checkpoint (lines=0, digest of empty)', () => {
    const chatId = 60109
    resetThread(chatId)
    expect(fs.existsSync(transcriptPath(cfg, chatId))).toBe(false)
    // Regression A: genuine absence reads as a valid empty transcript…
    const snap = readTranscriptSnapshot(cfg, chatId)
    expect(snap).toEqual({ ok: true, records: [] })
    // …so the legitimate first-run checkpoint (lines=0, empty digest) is kept.
    recordCheckpoint(cfg, chatId, 'first ever run')
    const cps = listCheckpoints(cfg, chatId)
    expect(cps).toHaveLength(1)
    expect(cps[0]!.lines).toBe(0)
    expect(cps[0]!.prefixSha256).toBe(transcriptPrefixDigest([]))
  })

  it('1B: a lookup failure (ENOTDIR) is NOT an empty transcript — checkpoint skipped', () => {
    const chatId = 60130
    resetThread(chatId)
    // Deterministic CI-safe lookup failure that is NOT ENOENT: the transcript
    // PARENT is a regular file, so reading <parent>/<chatId>.jsonl throws
    // ENOTDIR. existsSync() would collapse this into false==missing; direct
    // read + errno classification keeps it an observation failure.
    const ringDir = path.join(cfg.paths.dataDir, 'transcript')
    const ringBak = `${ringDir}.bak-1b`
    fs.mkdirSync(ringDir, { recursive: true })
    fs.rmSync(ringBak, { recursive: true, force: true })
    fs.renameSync(ringDir, ringBak)
    fs.writeFileSync(ringDir, 'not a directory')
    try {
      const snap = readTranscriptSnapshot(cfg, chatId)
      expect(snap.ok).toBe(false)
      if (!snap.ok) expect(snap.error).toContain('ENOTDIR')
      expect(() => recordCheckpoint(cfg, chatId, 'must not be recorded')).not.toThrow()
      // No checkpoint at all — specifically no forged lines=0 one.
      expect(listCheckpoints(cfg, chatId)).toHaveLength(0)
      expect(fs.existsSync(path.join(cfg.paths.dataDir, 'transcript', `${chatId}.checkpoints.json`))).toBe(false)
    } finally {
      fs.rmSync(ringDir, { force: true })
      fs.renameSync(ringBak, ringDir)
    }
  })

  it('the digest is deterministic and hashes the exact durable records', () => {
    expect(transcriptPrefixDigest([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(transcriptPrefixDigest([])).toBe(transcriptPrefixDigest([]))
    const a = ['{"ts":1,"message":{"role":"user","content":"a"}}']
    const b = ['{"ts":1,"message":{"role":"user","content":"a"}}']
    expect(transcriptPrefixDigest(a)).toBe(transcriptPrefixDigest(b))
    // Order matters — a reordered history is a different digest.
    expect(transcriptPrefixDigest(['x', 'y'])).not.toBe(transcriptPrefixDigest(['y', 'x']))
  })
})

describe('F2 — checkpoint identity (prefix binding)', () => {
  it('2A: same length, mutated prefix → REFUSE with zero mutation anywhere', () => {
    const chatId = 60110
    resetThread(chatId)
    fakeRun(chatId, 'run one', [{ role: 'assistant', content: 'one final' }])
    fakeRun(chatId, 'run two', [{ role: 'assistant', content: 'two final' }])
    const transcriptBefore = fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')
    const liveBefore = JSON.parse(JSON.stringify(getThread(cfg, chatId).messages))
    const cpsBefore = listCheckpoints(cfg, chatId)
    // Mutate an EARLY record inside the stored prefix; record count unchanged.
    const lines = transcriptBefore.trimEnd().split('\n')
    lines[0] = '{"ts":999,"message":{"role":"user","content":"REPLACED HISTORY"}}'
    fs.writeFileSync(transcriptPath(cfg, chatId), `${lines.join('\n')}\n`)

    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no longer matches the transcript prefix')

    // Zero mutation: transcript bytes, live thread, checkpoints all unchanged.
    expect(fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')).toBe(lines.join('\n') + '\n')
    expect(JSON.parse(JSON.stringify(getThread(cfg, chatId).messages))).toEqual(liveBefore)
    expect(listCheckpoints(cfg, chatId)).toEqual(cpsBefore)
  })

  it('2A: reordering inside the prefix is also refusal material', () => {
    const chatId = 60111
    resetThread(chatId)
    fakeRun(chatId, 'run one', [{ role: 'assistant', content: 'one final' }])
    fakeRun(chatId, 'run two', [{ role: 'assistant', content: 'two final' }])
    const lines = fs.readFileSync(transcriptPath(cfg, chatId), 'utf8').trimEnd().split('\n')
    const reordered = [lines[1], lines[0], ...lines.slice(2)]
    fs.writeFileSync(transcriptPath(cfg, chatId), `${reordered.join('\n')}\n`)
    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no longer matches the transcript prefix')
  })

  it('2B: an appended suffix still rewinds — prefix survives record-identically', () => {
    const chatId = 60112
    resetThread(chatId)
    fakeRun(chatId, 'run one', [{ role: 'assistant', content: 'one final' }])
    const prefixBytes = fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')
    fakeRun(chatId, 'run two', [{ role: 'assistant', content: 'two final' }])
    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')).toBe(prefixBytes)
    expect(getThread(cfg, chatId).messages.map((m) => m.content)).toEqual(['run one', 'one final'])
  })

  it('2C: malformed checkpoints are excluded — never defaults, never used', () => {
    const chatId = 60113
    resetThread(chatId)
    const cpFile = transcriptPath(cfg, chatId).replace('.jsonl', '.checkpoints.json')
    const malformed = [
      { ts: Date.now(), lines: -1, preview: 'neg', prefixSha256: 'a'.repeat(64) },
      { ts: Date.now(), lines: 1.5, preview: 'frac', prefixSha256: 'a'.repeat(64) },
      { ts: 0, lines: 0, preview: 'zero ts', prefixSha256: 'a'.repeat(64) },
      { ts: Date.now(), lines: 0, preview: 'missing digest' },
      { ts: Date.now(), lines: 0, preview: 'short digest', prefixSha256: 'abc123' },
      { ts: Date.now(), lines: 0, preview: 'uppercase digest', prefixSha256: 'A'.repeat(64) },
      { ts: 'not-a-number', lines: 0, preview: 'bad ts', prefixSha256: 'a'.repeat(64) },
      'not even an object',
    ]
    fs.mkdirSync(path.dirname(cpFile), { recursive: true })
    fs.writeFileSync(cpFile, JSON.stringify(malformed))
    expect(listCheckpoints(cfg, chatId)).toEqual([])
    expect(applyRewind(cfg, chatId, 1).error).toContain('no checkpoints yet')
  })

  it('a valid checkpoint stored alongside malformed ones is still usable', () => {
    const chatId = 60114
    resetThread(chatId)
    fakeRun(chatId, 'good run', [{ role: 'assistant', content: 'good final' }])
    const cpFile = transcriptPath(cfg, chatId).replace('.jsonl', '.checkpoints.json')
    const good = listCheckpoints(cfg, chatId)
    expect(good).toHaveLength(1)
    fs.writeFileSync(cpFile, JSON.stringify([{ lines: 99, preview: 'junk' }, ...good]))
    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(true)
    expect(transcriptLines(chatId)).toHaveLength(0)
  })
})

describe('F3 — live/durable parity', () => {
  it('3A: rewind installs live state built from the EXACT verified target records', () => {
    const chatId = 60115
    resetThread(chatId)
    fakeRun(chatId, 'run one', [
      { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'm', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'p1', content: 'pair result' },
    ])
    fakeRun(chatId, 'run two', [{ role: 'assistant', content: 'two final' }])
    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(true)

    // DURABLE: exactly the target prefix records.
    const durableLines = transcriptLines(chatId)
    const cps = listCheckpoints(cfg, chatId)
    // Live: derived through the shared path from those same records.
    const expectLive = messagesFromTranscriptRecords(chatId, durableLines)
    expect(getThread(cfg, chatId).messages).toEqual(expectLive)
    // The retained tool pair survived provider-valid; the undone run is gone
    // from BOTH durable and live state.
    expect(getThread(cfg, chatId).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(JSON.stringify(durableLines)).not.toContain('run two')
    expect(JSON.stringify(getThread(cfg, chatId).messages)).not.toContain('run two')
    expect(cps).toHaveLength(1)
  })

  it('3B: a transcript WRITE failure changes neither durable nor live state', () => {
    const chatId = 60116
    resetThread(chatId)
    fakeRun(chatId, 'run one', [{ role: 'assistant', content: 'one final' }])
    fakeRun(chatId, 'run two', [{ role: 'assistant', content: 'two final' }])
    const durableBefore = fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')
    const liveBefore = JSON.parse(JSON.stringify(getThread(cfg, chatId).messages))
    // Deterministic write failure: the tmp path is a DIRECTORY → EISDIR on
    // writeFileSync. No chmod, no timing.
    fs.mkdirSync(`${transcriptPath(cfg, chatId)}.tmp`)
    try {
      const res = applyRewind(cfg, chatId, 1)
      expect(res.ok).toBe(false)
      expect(res.error).toContain('transcript truncate failed')
      expect(fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')).toBe(durableBefore)
      expect(JSON.parse(JSON.stringify(getThread(cfg, chatId).messages))).toEqual(liveBefore)
      expect(listCheckpoints(cfg, chatId)).toHaveLength(2) // not pruned either
    } finally {
      fs.rmdirSync(`${transcriptPath(cfg, chatId)}.tmp`)
    }
  })

  it('3C: rewind to zero clears durable AND live state truthfully', () => {
    const chatId = 60117
    resetThread(chatId)
    fakeRun(chatId, 'only run', [{ role: 'assistant', content: 'final' }])
    // The checkpoint binds to the empty prefix (lines 0, digest of empty).
    const cps = listCheckpoints(cfg, chatId)
    expect(cps[0]!.lines).toBe(0)
    expect(cps[0]!.prefixSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(transcriptPath(cfg, chatId), 'utf8')).toBe('')
    expect(getThread(cfg, chatId).messages).toEqual([])
    expect(listCheckpoints(cfg, chatId)).toEqual([])
  })

  it('boot and rewind share one rehydration path (installRestoredThread parity)', () => {
    const chatId = 60118
    resetThread(chatId)
    fakeRun(chatId, 'keep', [{ role: 'assistant', content: 'kept' }])
    const viaBootHelper = messagesFromTranscriptRecords(chatId, transcriptLines(chatId))
    installRestoredThread(chatId, viaBootHelper)
    expect(getThread(cfg, chatId).messages).toEqual(viaBootHelper)
    // And restoreThread (boot) goes through the same helper:
    resetThread(chatId)
    const restored = restoreThreads(cfg)
    expect(restored).toBeGreaterThanOrEqual(1)
    expect(getThread(cfg, chatId).messages).toEqual(viaBootHelper)
  })
})

describe('rewind × agentLoop (depth-0 runs record checkpoints)', () => {
  const AGENT_DEF = { name: 'orchestrator', emoji: '🎯', description: 'd', maxTurns: 4, systemPrompt: 'x' }
  const registry = new AgentRegistry(new Map([['orchestrator', AGENT_DEF]]))

  it('a top-level run records a checkpoint before its user message', async () => {
    const chatId = 60200
    resetThread(chatId)
    const sender = createNullSender()
    const llm = createMockLlmClient([{ text: 'final one' }])
    const handle = startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm,
      send: sender,
      chatId,
      agentName: 'orchestrator',
      userText: 'check the funding spread',
    })
    await handle.done
    const cps = listCheckpoints(cfg, chatId)
    expect(cps).toHaveLength(1)
    expect(cps[0]!.preview).toBe('check the funding spread')
    expect(cps[0]!.lines).toBe(0) // recorded BEFORE the run appended anything

    // A second run checkpoints at the post-run-1 record count (message
    // records + the run-summary note — whatever the loop durably wrote).
    const linesAfterRun1 = transcriptLines(chatId).length
    const llm2 = createMockLlmClient([{ text: 'final two' }])
    await startRun({
      cfg,
      agentRegistry: registry,
      toolRegistry: new ToolRegistry(),
      llm: llm2,
      send: sender,
      chatId,
      agentName: 'orchestrator',
      userText: 'second prompt',
    }).done
    const cps2 = listCheckpoints(cfg, chatId)
    expect(cps2).toHaveLength(2)
    expect(cps2[1]!.lines).toBe(linesAfterRun1)

    // And the rewind undoes exactly run 2: transcript back to run 1's
    // footprint, live window rebuilt to run 1's message records only.
    const res = applyRewind(cfg, chatId, 1)
    expect(res.ok).toBe(true)
    expect(transcriptLines(chatId)).toHaveLength(linesAfterRun1)
    expect(getThread(cfg, chatId).messages.map((m) => m.content)).toEqual(['check the funding spread', 'final one'])
  })
})

describe('/rewind authority (exact private principal)', () => {
  const ALLOWED_NON_PRINCIPAL = 111

  function harness() {
    const sent: Array<{ chatId: number; text: string }> = []
    const deps = {
      cfg,
      send: async (chatId: number, text: string) => {
        sent.push({ chatId, text })
      },
      runExclusive: async (_chatId: number, job: () => Promise<void>) => {
        await job()
      },
      noteAdminActivity: () => {},
    }
    return { sent, deps }
  }

  it('the principal rewinds through the run-queue seam', async () => {
    const chatId = ADMIN
    resetThread(chatId)
    fakeRun(chatId, 'undo me', [{ role: 'assistant', content: 'x' }])
    fakeRun(chatId, 'undo me too', [{ role: 'assistant', content: 'y' }])
    const { sent, deps } = harness()
    await handleRewindCommand(deps, { chat: { id: chatId, type: 'private' }, from: { id: ADMIN }, args: '1' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('rewound 1 run(s)')
    expect(transcriptLines(chatId)).toHaveLength(2)
  })

  it('no args lists checkpoints instead of mutating', async () => {
    const { sent, deps } = harness()
    await handleRewindCommand(deps, { chat: { id: ADMIN, type: 'private' }, from: { id: ADMIN }, args: '' })
    expect(sent[0]!.text).toContain('checkpoints')
  })

  it('bad n gets usage, not a mutation', async () => {
    const { sent, deps } = harness()
    await handleRewindCommand(deps, { chat: { id: ADMIN, type: 'private' }, from: { id: ADMIN }, args: 'zero' })
    expect(sent[0]!.text).toContain('usage')
  })

  it('an allowed non-principal chat gets SILENT refusal — no list, no mutation', async () => {
    const before = transcriptLines(ADMIN).length
    const { sent, deps } = harness()
    await handleRewindCommand(deps, { chat: { id: ALLOWED_NON_PRINCIPAL, type: 'private' }, from: { id: ALLOWED_NON_PRINCIPAL }, args: '1' })
    expect(sent).toHaveLength(0)
    expect(transcriptLines(ADMIN).length).toBe(before)
  })

  it('right chat, wrong sender account → SILENT refusal', async () => {
    const { sent, deps } = harness()
    await handleRewindCommand(deps, { chat: { id: ADMIN, type: 'private' }, from: { id: 999 }, args: '1' })
    expect(sent).toHaveLength(0)
  })

  it('group chats are not the boundary even for the admin account', async () => {
    const { sent, deps } = harness()
    await handleRewindCommand(deps, { chat: { id: ADMIN, type: 'group' }, from: { id: ADMIN }, args: '1' })
    expect(sent).toHaveLength(0)
  })
})

describe('dashboard rewind endpoints', () => {
  let server: http.Server
  let base = ''
  let token = ''

  beforeAll(async () => {
    const source = Object.assign(() => ({ activeRuns: 0, pendingApprovals: 0, lastRunAt: 123 }), {
      rewindThread: async (n: number) => ({ ok: true, text: `rewound ${n} run(s)` }),
      threadCheckpoints: () => [{ ts: 1, lines: 0, preview: 'seeded' }],
    })
    server = startStatusServer(cfg, source)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}`
    token = (await fetch(`${base}/`)).headers.get('x-desk-token') ?? ''
  })

  it('POST /thread/rewind uses the loopback dashboard source seam without a donor token assumption', async () => {
    const res = await fetch(`${base}/thread/rewind`, { method: 'POST', body: JSON.stringify({ n: 1 }) })
    expect(res.status).toBe(200)
  })

  it('POST /thread/rewind {n} rewinds the admin chat through the source seam', async () => {
    const res = await fetch(`${base}/thread/rewind`, {
      method: 'POST',
      headers: { 'x-desk-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ n: 2 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; text: string }
    expect(body.ok).toBe(true)
    expect(body.text).toContain('rewound 2 run(s)')
  })

  it('POST /thread/rewind validates n', async () => {
    const res = await fetch(`${base}/thread/rewind`, {
      method: 'POST',
      headers: { 'x-desk-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ n: 0 }),
    })
    expect(res.status).toBe(400)
  })

  it('GET /thread/checkpoints returns the admin-chat checkpoint list', async () => {
    const res = await fetch(`${base}/thread/checkpoints`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { checkpoints: Array<{ ts: number; lines: number; preview: string }> }
    expect(body.checkpoints).toEqual([{ ts: 1, lines: 0, preview: 'seeded' }])
  })

  it('a source without the rewind seam fails closed with 503', async () => {
    const bare = Object.assign(() => ({ activeRuns: 0, pendingApprovals: 0, lastRunAt: 1 }), {})
    const server2 = startStatusServer(cfg, bare)
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve))
    const addr = server2.address() as { port: number }
    const base2 = `http://127.0.0.1:${addr.port}`
    const token2 = (await fetch(`${base2}/`)).headers.get('x-desk-token') ?? ''
    const rewind = await fetch(`${base2}/thread/rewind`, {
      method: 'POST',
      headers: { 'x-desk-token': token2, 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    })
    expect(rewind.status).toBe(503)
    const cps = await fetch(`${base2}/thread/checkpoints`)
    expect(cps.status).toBe(503)
    server2.close()
  })
})

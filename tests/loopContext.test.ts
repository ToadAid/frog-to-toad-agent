// Microcompact tests (PR 1, the coder-repo pattern): old bulky tool results
// are stubbed in-memory while the call/result skeleton stays provider-valid
// and the transcript keeps full fidelity.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  appendToThread,
  getThread,
  messagesFromTranscriptRecords,
  microcompactThread,
  preservedSegmentRelink,
  persistTranscriptNote,
  resetThread,
  restoreThreads,
} from '../src/loop/context.js'
import type { ChatMessage } from '../src/types.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-microcompact-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function toolMsg(id: string, chars: number): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: 'x'.repeat(chars) }
}

describe('microcompactThread', () => {
  it('keeps the most recent tool results intact and stubs older bulky ones, skeleton preserved', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'scan the feed' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'market', arguments: '{}' } }] },
      toolMsg('c1', 1000),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'market', arguments: '{}' } }] },
      toolMsg('c2', 1000),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'market', arguments: '{}' } }] },
      toolMsg('c3', 1000),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c4', type: 'function', function: { name: 'market', arguments: '{}' } }] },
      toolMsg('c4', 1000),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c5', type: 'function', function: { name: 'market', arguments: '{}' } }] },
      toolMsg('c5', 1000),
      { role: 'assistant', content: 'done' },
    ]
    const { evicted, bytesSaved } = microcompactThread(messages)
    // default MICROCOMPACT_KEEP = 4 → the oldest (c1) is the only eviction
    expect(evicted).toBe(1)
    expect(bytesSaved).toBe(1000)
    // stub replaces content but keeps the pair the provider requires
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: expect.stringContaining('[microcompact: 1000-char'),
    })
    // recent results untouched
    expect(messages[4]).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
    expect((messages[4] as { content: string }).content).toHaveLength(1000)
    // assistant skeleton untouched
    expect(messages[1]).toMatchObject({ role: 'assistant' })
  })

  it('leaves small old results alone — stubbing them saves nothing', () => {
    const messages: ChatMessage[] = [toolMsg('a', 10), toolMsg('b', 10), toolMsg('c', 10), toolMsg('d', 10), toolMsg('e', 10)]
    const { evicted } = microcompactThread(messages)
    expect(evicted).toBe(0)
    expect((messages[0] as { content: string }).content).toHaveLength(10)
  })

  it('is idempotent — the stub is short and never re-qualifies', () => {
    const messages: ChatMessage[] = [toolMsg('a', 5000), toolMsg('b', 5000), toolMsg('c', 5000), toolMsg('d', 5000), toolMsg('e', 5000)]
    const first = microcompactThread(messages)
    expect(first.evicted).toBe(1)
    const second = microcompactThread(messages)
    expect(second.evicted).toBe(0)
    expect(second.bytesSaved).toBe(0)
  })

  it('never touches user/assistant messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'y'.repeat(5000) },
      { role: 'assistant', content: 'z'.repeat(5000) },
    ]
    const { evicted } = microcompactThread(messages)
    expect(evicted).toBe(0)
    expect(messages[0]).toEqual({ role: 'user', content: 'y'.repeat(5000) })
  })
})

describe('appendToThread microcompact integration', () => {
  const CHAT = 987654321

  afterAll(() => resetThread(CHAT))

  it('evicts from the live thread but persists FULL text in the transcript', () => {
    resetThread(CHAT)
    const thread = getThread(cfg, CHAT)
    // five bulky tool results → the oldest falls outside the keep-4 set
    for (let i = 0; i < 5; i++) {
      const id = `ic${i}`
      appendToThread(cfg, thread, {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: 'market', arguments: '{}' } }],
      })
      appendToThread(cfg, thread, toolMsg(id, 900))
    }
    const toolMsgs = thread.messages.filter((m) => m.role === 'tool') as Array<{ content: string }>
    expect(toolMsgs).toHaveLength(5)
    expect(toolMsgs[0]!.content).toContain('[microcompact: 900-char')
    expect(toolMsgs.slice(1).every((m) => m.content === 'x'.repeat(900))).toBe(true)

    // transcript keeps the full text — stubbing is in-memory only
    const transcript = fs.readFileSync(path.join(dir, 'data', 'transcript', `${CHAT}.jsonl`), 'utf8')
    expect(transcript.match(/"x{900}"/g)?.length ?? 0).toBe(5)
  })
})

describe('restoreThreads microcompact on rehydrate', () => {
  const CHAT = 987654322

  it('stubs bulky old tool results when rehydrating from the transcript', () => {
    resetThread(CHAT)
    const thread = getThread(cfg, CHAT)
    for (let i = 0; i < 5; i++) {
      const id = `rc${i}`
      appendToThread(cfg, thread, {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: 'market', arguments: '{}' } }],
      })
      appendToThread(cfg, thread, toolMsg(id, 900))
    }
    resetThread(CHAT)

    expect(restoreThreads(cfg)).toBeGreaterThanOrEqual(0)
    const restored = getThread(cfg, CHAT)
    const toolMsgs = restored.messages.filter((m) => m.role === 'tool') as Array<{ content: string }>
    expect(toolMsgs).toHaveLength(5)
    expect(toolMsgs[0]!.content).toContain('[microcompact: 900-char')
    // pairs stay provider-valid after rehydrate + stub
    expect(restored.messages.filter((m) => m.role === 'assistant' && m.tool_calls)).toHaveLength(5)
  })
})

// ── preservedSegment relink (the coder-repo compact pattern, desk-native) ────
// Post-compact restore coherence: the boundary note carries preservedSegment
// metadata; rehydration splices the kept segment into the live chain instead
// of the raw tail, so a restart never resurrects the evicted head behind the
// summary. Validation-first: a broken walk is a TRUE no-op (raw-tail
// fallback), never a half-relink.

function rec(m: ChatMessage): string {
  return JSON.stringify({ ts: 0, message: m })
}

function boundaryRec(content: string, kept: number): string {
  return JSON.stringify({
    ts: 0,
    message: { role: 'user', content },
    autocompact: { evicted: kept, chars: 10, preservedSegment: { kept } },
  })
}

function runNote(): string {
  return JSON.stringify({ ts: 0, runId: 'r1', agent: 'desk', summary: { turns: 1 } })
}

const user = (c: string): ChatMessage => ({ role: 'user', content: c })
const contents = (ms: ChatMessage[]): string[] => ms.map((m) => (m as { content: string }).content)

describe('preservedSegmentRelink — walk + validation laws', () => {
  it('finds the LAST boundary, skips notes, and names the kept message records', () => {
    const records = [rec(user('m1')), runNote(), rec(user('m2')), rec(user('m3')), boundaryRec('summary', 2)]
    const r = preservedSegmentRelink(records)
    expect(r).toEqual({ boundaryIdx: 4, segmentIdxs: [2, 3] })
  })

  it('the newest malformed boundary wins the decision and forces raw-tail fallback', () => {
    const malformedB2 = JSON.stringify({
      ts: 0,
      message: user('b2 malformed'),
      autocompact: { preservedSegment: { kept: '2' } },
    })
    const records = [
      rec(user('m1')),
      rec(user('m2')),
      boundaryRec('b1 summary', 2),
      rec(user('m3')),
      malformedB2,
      rec(user('m4')),
    ]

    expect(preservedSegmentRelink(records)).toBeUndefined()
    expect(contents(messagesFromTranscriptRecords(1, records))).toEqual([
      'm1', 'm2', 'b1 summary', 'm3', 'b2 malformed', 'm4',
    ])
  })

  it('no boundary, malformed kept, boundary without a summary, or over-claim → undefined (true no-op)', () => {
    expect(preservedSegmentRelink([rec(user('m1'))])).toBeUndefined()
    expect(preservedSegmentRelink([rec(user('m1')), boundaryRec('s', 0)])).toBeUndefined()
    expect(preservedSegmentRelink([rec(user('m1')), boundaryRec('s', 1.5)])).toBeUndefined()
    expect(preservedSegmentRelink([rec(user('m1')), JSON.stringify({ ts: 0, message: user('s'), autocompact: { preservedSegment: { kept: '3' } } })])).toBeUndefined()
    expect(preservedSegmentRelink([rec(user('m1')), boundaryRec('s', 10_001)])).toBeUndefined()
    // over-claim: kept=3 but only 2 message records exist
    expect(preservedSegmentRelink([rec(user('m1')), rec(user('m2')), boundaryRec('s', 3)])).toBeUndefined()
    // boundary note without a message field cannot anchor the chain
    expect(preservedSegmentRelink([rec(user('m1')), JSON.stringify({ ts: 0, autocompact: { preservedSegment: { kept: 1 } } })])).toBeUndefined()
  })

  it('a corrupt record inside the claimed span breaks the walk — no half-relink', () => {
    const records = [rec(user('m1')), rec(user('m2')), '{oops', boundaryRec('s', 3)]
    expect(preservedSegmentRelink(records)).toBeUndefined()
  })

  it('a claim descending past an older boundary is stale metadata → broken', () => {
    // m1..m7, b1(kept=3: m5..m7), m8, m9, b2(kept=6: claims into pre-b1 history)
    const records = [
      rec(user('m1')), rec(user('m2')), rec(user('m3')), rec(user('m4')), rec(user('m5')),
      rec(user('m6')), rec(user('m7')), boundaryRec('b1 summary', 3), rec(user('m8')), rec(user('m9')),
      boundaryRec('b2 summary', 6),
    ]
    expect(preservedSegmentRelink(records)).toBeUndefined()
  })

  it('the walk may REUSE an older boundary\'s segment but never descend below its head', () => {
    // b2(kept=5) legitimately reaches into b1's segment (m5 is live after b1)
    const records = [
      rec(user('m1')), rec(user('m2')), rec(user('m3')), rec(user('m4')), rec(user('m5')),
      rec(user('m6')), rec(user('m7')), boundaryRec('b1 summary', 3), rec(user('m8')), rec(user('m9')),
      boundaryRec('b2 summary', 5),
    ]
    const r = preservedSegmentRelink(records)
    // m9,m8 collected, then b1 skipped (floor = b1's segment head, m5's record),
    // then m7,m6,m5 fill the claim — m5 IS live history after b1's compact
    expect(r).toEqual({ boundaryIdx: 10, segmentIdxs: [4, 5, 6, 8, 9] })
  })

  it('a nested older boundary without a summary invalidates the entire relink', () => {
    const b1WithoutSummary = JSON.stringify({
      ts: 0,
      autocompact: { preservedSegment: { kept: 2 } },
    })
    const records = [
      rec(user('m1')),
      rec(user('m2')),
      b1WithoutSummary,
      rec(user('m3')),
      rec(user('m4')),
      boundaryRec('b2 summary', 4),
    ]

    expect(preservedSegmentRelink(records)).toBeUndefined()
  })
})

describe('preservedSegment relink — restore coherence', () => {
  it('rehydrates [boundary, kept segment, post-boundary tail] — the evicted head never resurrects behind the summary', () => {
    const records = [
      rec(user('m1')), rec(user('m2')), rec(user('m3')), rec(user('m4')), rec(user('m5')),
      rec(user('m6')), rec(user('m7')), runNote(), boundaryRec('[autocompact] summary', 3),
      rec(user('m8 after')),
    ]
    const out = messagesFromTranscriptRecords(1, records)
    expect(contents(out)).toEqual([
      expect.stringContaining('[autocompact] summary'),
      'm5', 'm6', 'm7', 'm8 after',
    ])
  })

  it('a broken walk falls back to the raw-tail window — today\'s behavior, never a half-relink', () => {
    const records = [
      rec(user('m1')), rec(user('m2')), '{corrupt', boundaryRec('[autocompact] summary', 2),
    ]
    const out = messagesFromTranscriptRecords(1, records)
    // fallback = parse records in file order (corrupt line skipped): the
    // boundary lands at its PHYSICAL position, evicted history stays
    expect(contents(out)).toEqual(['m1', 'm2', expect.stringContaining('[autocompact] summary')])
  })

  it('window-trim applies AFTER the splice — the newest tail survives, not the summary', () => {
    const records: string[] = []
    for (let i = 0; i < 90; i++) records.push(rec(user(`m${i}`)))
    // kept = last 85 messages (m5..m89) → chain = [boundary, m5..m89, m90after] = 87
    records.push(boundaryRec('[autocompact] summary', 85))
    records.push(rec(user('m90 after')))
    const out = messagesFromTranscriptRecords(1, records)
    expect(out).toHaveLength(80) // MAX_THREAD_MESSAGES window
    expect(contents(out)[0]).toBe('m11') // newest 80 of the spliced chain
    expect(contents(out)[out.length - 1]).toBe('m90 after')
    expect(contents(out).some((c) => c.includes('[autocompact]'))).toBe(false) // trimmed off the head
  })

  it('round-trips through the real transcript file: compact note → restore → coherent chain', () => {
    const CHAT = 987654323
    resetThread(CHAT)
    const thread = getThread(cfg, CHAT)
    for (let i = 1; i <= 5; i++) appendToThread(cfg, thread, user(`live m${i}`))
    // maybeAutocompact's boundary note (kept = the last 2 messages)
    persistTranscriptNote(cfg, CHAT, {
      message: { role: 'user', content: '[autocompact] Summary of the 3 earlier messages' },
      autocompact: { evicted: 3, chars: 40, preservedSegment: { kept: 2 } },
    })
    appendToThread(cfg, thread, user('live m6 post-compact'))
    resetThread(CHAT)

    restoreThreads(cfg)
    const restored = getThread(cfg, CHAT).messages
    expect(contents(restored)).toEqual([
      '[autocompact] Summary of the 3 earlier messages',
      'live m4', 'live m5', 'live m6 post-compact',
    ])
    resetThread(CHAT)
  })
})

import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage } from '../types.js'
import type { Config } from '../config.js'
import { appendJsonl } from '../store/jsonl.js'
import { log } from '../log.js'

/**
 * Chat window: last N messages re-sent each turn (transcript keeps everything).
 * 80 balances recall vs token cost on GLM's ~200K window; THREAD_MESSAGES env
 * overrides without a recompile.
 */
const MAX_THREAD_MESSAGES = Math.max(4, Number(process.env['THREAD_MESSAGES']) || 80)

// Microcompact (the coder-repo pattern): old tool RESULTS are the token hogs
// in a long thread — a soak run of market scans and diffs leaves hundreds of
// 8KB outputs behind. Keep the most recent MICROCOMPACT_KEEP tool results at
// full fidelity; stub older bulky ones down to a short marker with the role +
// tool_call_id PRESERVED (the provider requires every result to follow its
// assistant call — repairThreadToolPairs drops orphans). Deterministic, no LLM
// calls, idempotent (the stub is short, so it never re-qualifies). The
// transcript JSONL keeps the full text — stubbing is in-memory only.
const MICROCOMPACT_KEEP = Math.max(1, Number(process.env['MICROCOMPACT_KEEP']) || 4)
const MICROCOMPACT_MIN_CHARS = Math.max(1, Number(process.env['MICROCOMPACT_MIN_CHARS']) || 256)

// Autocompact (PR 2, the coder-repo autoCompact pattern): the 80-message
// window tail-drops the desk's oldest turns forever. When the window is
// SATURATED (length >= TRIGGER, default = the window itself), the next run
// summarizes the older portion into one compact-boundary message instead of
// dropping it silently. KEEP is how much recent history survives verbatim
// (75% of the trigger). Summary failure fails OPEN to the old tail-drop —
// never lose history because the summarizer hiccuped.
const AUTOCOMPACT_TRIGGER = Math.max(
  12,
  Number(process.env['AUTOCOMPACT_TRIGGER']) || MAX_THREAD_MESSAGES,
)
const AUTOCOMPACT_KEEP = Math.max(8, Math.floor(AUTOCOMPACT_TRIGGER * 0.75))

export type Thread = {
  chatId: number
  /** Full message history (excluding system prompt) — trimmed to a window. */
  messages: ChatMessage[]
}

const threads = new Map<number, Thread>()

/**
 * Responses API history is strict: every persisted tool result must follow an
 * assistant function call with the same id. Older desk transcripts omitted
 * assistant tool_calls, so discard only those unusable orphan results while
 * preserving normal conversation history and any complete call/result pairs.
 */
export function repairThreadToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const repaired: ChatMessage[] = []
  let pending: Extract<ChatMessage, { role: 'assistant' }> | undefined
  let outputs: Array<Extract<ChatMessage, { role: 'tool' }>> = []

  const flushPending = (): void => {
    if (!pending) return
    const outputIds = new Set(outputs.map((message) => message.tool_call_id))
    const matchedCalls = (pending.tool_calls ?? []).filter((call) => outputIds.has(call.id))
    if (pending.content || matchedCalls.length > 0) {
      repaired.push({
        ...pending,
        tool_calls: matchedCalls.length > 0 ? matchedCalls : undefined,
      })
      const matchedIds = new Set(matchedCalls.map((call) => call.id))
      repaired.push(...outputs.filter((message) => matchedIds.has(message.tool_call_id)))
    }
    pending = undefined
    outputs = []
  }

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      flushPending()
      pending = message
      continue
    }
    if (message.role === 'tool') {
      if (pending?.tool_calls?.some((call) => call.id === message.tool_call_id)) outputs.push(message)
      continue
    }
    flushPending()
    repaired.push(message)
  }
  flushPending()
  return repaired
}

export function getThread(cfg: Config, chatId: number): Thread {
  let t = threads.get(chatId)
  if (!t) {
    t = { chatId, messages: [] }
    threads.set(chatId, t)
  }
  void cfg
  return t
}

export function resetThread(chatId: number): void {
  threads.delete(chatId)
}

/**
 * Microcompact in place: stub every tool result outside the most recent
 * MICROCOMPACT_KEEP ones down to a short marker (when it is at least
 * MICROCOMPACT_MIN_CHARS — tiny results cost nothing to keep). Returns what
 * was evicted so callers can log it; the call/result skeleton is never
 * touched, so the thread stays provider-valid.
 */
export function microcompactThread(messages: ChatMessage[]): { evicted: number; bytesSaved: number } {
  let evicted = 0
  let bytesSaved = 0
  let kept = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'tool') continue
    kept++
    if (kept <= MICROCOMPACT_KEEP) continue
    if (m.content.length < MICROCOMPACT_MIN_CHARS) continue
    bytesSaved += m.content.length
    messages[i] = {
      role: 'tool',
      tool_call_id: m.tool_call_id,
      content: `[microcompact: ${m.content.length}-char tool output evicted — full text in the transcript]`,
    }
    evicted++
  }
  return { evicted, bytesSaved }
}

/**
 * Pure autocompact split: when the thread has saturated the window, choose
 * the evict/keep boundary (evict down to AUTOCOMPACT_KEEP) with the
 * pair-edge law — a kept message may never be a tool result whose assistant
 * call was evicted, so the cut advances past any trailing tool results of
 * the evicted head. Returns undefined when there is nothing to compact.
 */
export function autocompactSplit(messages: ChatMessage[]): { evicted: ChatMessage[]; kept: ChatMessage[] } | undefined {
  if (messages.length < AUTOCOMPACT_TRIGGER) return undefined
  let cut = messages.length - AUTOCOMPACT_KEEP
  if (cut <= 0) return undefined
  while (cut < messages.length && messages[cut]?.role === 'tool') cut++
  if (cut >= messages.length) return undefined // pathological: nothing but tools to keep
  return { evicted: messages.slice(0, cut), kept: messages.slice(cut) }
}

export function autocompactThresholds(): { trigger: number; keep: number } {
  return { trigger: AUTOCOMPACT_TRIGGER, keep: AUTOCOMPACT_KEEP }
}

/**
 * Append to the thread + persist to data/transcript/<chatId>.jsonl.
 * Compaction is two-layered (transcript keeps everything): the window keeps
 * the last MAX_THREAD_MESSAGES messages, and microcompact stubs bulky tool
 * results older than the most recent few. Summary compaction of evicted
 * turns is a later refinement (PR 2).
 */
export type TranscriptConversationBinding = Readonly<{
  /**
   * Code-owned durable conversation UUID, deliberately separate from the short
   * operator-facing runId. Message text can never supply this binding.
   */
  conversationRunId: string
}>

export function appendToThread(
  cfg: Config,
  thread: Thread,
  message: ChatMessage,
  binding?: TranscriptConversationBinding,
): void {
  thread.messages.push(message)
  if (thread.messages.length > MAX_THREAD_MESSAGES) {
    // Keep the tail, then discard any tool outputs whose assistant call fell
    // just outside the window.
    const overflow = thread.messages.length - MAX_THREAD_MESSAGES
    thread.messages.splice(0, overflow)
    while (thread.messages[0]?.role === 'tool') thread.messages.shift()
  }
  const { evicted, bytesSaved } = microcompactThread(thread.messages)
  if (evicted > 0) {
    log.info(`microcompact evicted ${evicted} tool result(s) (${bytesSaved} chars) from a thread`)
  }
  try {
    appendJsonl(path.join(cfg.paths.dataDir, 'transcript', `${thread.chatId}.jsonl`), {
      ts: Date.now(),
      message,
      ...(binding ? { conversationRunId: binding.conversationRunId } : {}),
    })
  } catch (e) {
    log.warn('transcript append failed')
  }
}

export function persistTranscriptNote(cfg: Config, chatId: number, note: object): void {
  try {
    appendJsonl(path.join(cfg.paths.dataDir, 'transcript', `${chatId}.jsonl`), {
      ts: Date.now(),
      ...note,
    })
  } catch (e) {
    log.warn('transcript note failed')
  }
}

/** Durable transcript path for one chat — the rewind lane reads/truncates it. */
export function transcriptPath(cfg: Config, chatId: number): string {
  return path.join(cfg.paths.dataDir, 'transcript', `${chatId}.jsonl`)
}

/**
 * Observed transcript state as a discriminated result. Unknown is NOT empty:
 * a missing file is a valid empty transcript; a file that exists but cannot
 * be read/stat/decoded is an OBSERVATION FAILURE — callers must skip, never
 * substitute zero or emptiness for what they could not observe.
 */
export type TranscriptSnapshot =
  | { ok: true; records: string[] }
  | { ok: false; error: string }

export function readTranscriptSnapshot(cfg: Config, chatId: number): TranscriptSnapshot {
  const p = transcriptPath(cfg, chatId)
  try {
    const raw = fs.readFileSync(p, 'utf8').trimEnd()
    if (raw === '') return { ok: true, records: [] }
    return { ok: true, records: raw.split('\n') }
  } catch (e) {
    // "Missing is a fact. Failure to observe is not missing." ENOENT alone
    // proves the transcript is absent (valid empty); every other error —
    // EISDIR, ENOTDIR, EACCES, ELOOP, anything else — is an observation
    // failure and must never collapse into an empty transcript.
    if (isErrnoException(e) && e.code === 'ENOENT') return { ok: true, records: [] }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Narrow a caught value to a Node filesystem error with an errno code. */
function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e
}

/** Parsed transcript record — the fields any lane may have persisted. */
type ParsedRecord = {
  message?: ChatMessage
  autocompact?: { preservedSegment?: unknown }
  /** JSON.parse threw — the record cannot be trusted inside a kept segment. */
  corrupt?: boolean
}

function parseRecord(line: string): ParsedRecord {
  try {
    return JSON.parse(line) as ParsedRecord
  } catch {
    return { corrupt: true }
  }
}

/** A kept-claim bound — malformed metadata must not scan unbounded history. */
const MAX_PRESERVED_SEGMENT = 10_000
const MAX_RELINK_DEPTH = 64

function hasPreservedSegment(record: ParsedRecord | undefined): record is ParsedRecord & {
  autocompact: { preservedSegment: unknown }
} {
  const autocompact = record?.autocompact
  return (
    typeof autocompact === 'object' &&
    autocompact !== null &&
    Object.prototype.hasOwnProperty.call(autocompact, 'preservedSegment')
  )
}

function validPreservedSegmentKept(segment: unknown): number | undefined {
  if (typeof segment !== 'object' || segment === null || !('kept' in segment)) return undefined
  const kept = segment.kept
  if (
    typeof kept !== 'number' ||
    !Number.isInteger(kept) ||
    kept <= 0 ||
    kept > MAX_PRESERVED_SEGMENT
  )
    return undefined
  return kept
}

export type PreservedSegmentRelink = {
  /** Record index of the compact boundary carrying the metadata. */
  boundaryIdx: number
  /** Message-record indices of the kept segment, in file order. */
  segmentIdxs: number[]
}

/**
 * preservedSegment relink (the coder-repo applyPreservedSegmentRelinks
 * pattern, desk-native — our transcript is flat, so the "chain" is record
 * order): find the LAST compact boundary carrying preservedSegment metadata,
 * then walk BACKWARD collecting the `kept` message records it names,
 * skipping non-message notes (run summaries). The boundary record itself is
 * the anchor — the kept segment is everything it summarizes plus the live
 * tail, so the post-compact chain is [boundary, …kept, …post-boundary].
 *
 * Validation happens BEFORE anything is used — a broken walk is a TRUE
 * no-op (callers fall back to the raw tail window; never a half-relink):
 *   - a corrupt record inside the claimed span → broken;
 *   - the claim descends past an OLDER preservedSegment boundary's own
 *     segment → broken (that history was summarized into it — a claim on
 *     more is stale metadata, the phantom-leaf law);
 *   - fewer than `kept` message records exist → broken;
 *   - `kept` malformed or absurdly large → broken.
 * Returns undefined when there is no segment or the walk broke.
 */
export function preservedSegmentRelink(records: string[]): PreservedSegmentRelink | undefined {
  const parsed = records.map(parseRecord)
  let boundaryIdx = -1
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (hasPreservedSegment(parsed[i])) {
      boundaryIdx = i
      break
    }
  }
  if (boundaryIdx < 0) return undefined
  const boundary = parsed[boundaryIdx]!
  if (!hasPreservedSegment(boundary)) return undefined
  const kept = validPreservedSegmentKept(boundary.autocompact.preservedSegment)
  if (kept === undefined || !boundary.message) return undefined
  const segmentIdxs = collectSegment(parsed, boundaryIdx, kept, 0)
  if (!segmentIdxs) return undefined
  return { boundaryIdx, segmentIdxs }
}

/**
 * Walk backward from a boundary collecting up to `kept` message records.
 * Older preservedSegment boundaries met along the way are evicted summaries —
 * skipped, never counted — but they pin the walk's floor: their own segment
 * is validated recursively and the walk may reuse it, yet never descend
 * below it (that history was summarized into them). Broken at any point →
 * undefined (the whole relink no-ops).
 */
function collectSegment(
  parsed: ParsedRecord[],
  boundaryIdx: number,
  kept: number,
  depth: number,
): number[] | undefined {
  if (depth > MAX_RELINK_DEPTH) return undefined
  const segmentIdxs: number[] = []
  let floor = 0 // the outermost walk may descend to the transcript head
  for (let i = boundaryIdx - 1; i >= floor && segmentIdxs.length < kept; i--) {
    const rec = parsed[i]
    if (!rec || rec.corrupt) return undefined
    if (hasPreservedSegment(rec)) {
      // An older boundary: an evicted summary — not part of any kept segment.
      // Validate its segment and pin the floor at that segment's head.
      const olderKept = validPreservedSegmentKept(rec.autocompact.preservedSegment)
      if (olderKept === undefined || !rec.message) return undefined
      const inner = collectSegment(parsed, i, olderKept, depth + 1)
      if (!inner) return undefined
      floor = inner[0]!
      continue // the boundary record itself is never a kept message
    }
    if (!rec.message) continue // notes (run summaries etc.) are not messages
    segmentIdxs.unshift(i)
  }
  if (segmentIdxs.length < kept) return undefined // walk ran out — broken claim
  return segmentIdxs
}

/**
 * Build the provider-valid live window from already-read transcript record
 * lines — ONE source of truth shared by boot rehydration (restoreThread) and
 * rewind (applyRewind): parse message records, apply the preservedSegment
 * relink when a compact boundary carries it, window-trim, repairThreadToolPairs,
 * microcompact. Rewind passes the exact verified target prefix, so the live
 * state derives from the same records the durable rewrite installs.
 */
export function messagesFromTranscriptRecords(chatId: number, records: string[]): ChatMessage[] {
  const relink = preservedSegmentRelink(records)
  let messages: ChatMessage[]
  if (relink) {
    // Post-compact coherence: the live chain is the boundary summary, the
    // kept segment it names, then everything appended after the boundary —
    // NEVER the raw tail, which would resurrect the evicted head behind the
    // summary. Window-trim applies after the splice; repair/microcompact
    // below stay the one shared tail.
    const boundaryMsg = parseRecord(records[relink.boundaryIdx]!).message!
    const segMsgs = relink.segmentIdxs.map((i) => parseRecord(records[i]!).message!)
    const postMsgs: ChatMessage[] = []
    for (let i = relink.boundaryIdx + 1; i < records.length; i++) {
      const rec = parseRecord(records[i]!)
      if (rec.message) postMsgs.push(rec.message)
    }
    messages = [boundaryMsg, ...segMsgs, ...postMsgs]
    if (messages.length > MAX_THREAD_MESSAGES) {
      messages = messages.slice(messages.length - MAX_THREAD_MESSAGES)
    }
  } else {
    messages = []
    for (const line of records.slice(-MAX_THREAD_MESSAGES)) {
      const rec = parseRecord(line)
      if (rec.corrupt) log.warn(`thread restore skipped corrupt record for chat ${chatId}`)
      if (rec.message) messages.push(rec.message)
    }
  }
  const repaired = repairThreadToolPairs(messages)
  microcompactThread(repaired)
  return repaired
}

/** Install a rebuilt live window for one chat (empty = no live thread). */
export function installRestoredThread(chatId: number, messages: ChatMessage[]): void {
  if (messages.length > 0) threads.set(chatId, { chatId, messages })
  else threads.delete(chatId)
}

/** Rehydrate ONE chat's in-memory thread from its (possibly truncated)
 * transcript through the shared record→messages path. Returns the restored
 * message count; an unreadable transcript returns 0 WITHOUT touching any
 * existing live state (boot has none; callers treat 0 as unobservable). */
export function restoreThread(cfg: Config, chatId: number): number {
  const snap = readTranscriptSnapshot(cfg, chatId)
  if (!snap.ok) {
    log.warn('thread restore failed')
    return 0
  }
  const repaired = messagesFromTranscriptRecords(chatId, snap.records)
  installRestoredThread(chatId, repaired)
  return repaired.length
}

/** Rehydrate threads from transcripts on boot so conversations survive restarts. */
export function restoreThreads(cfg: Config): number {
  const dir = path.join(cfg.paths.dataDir, 'transcript')
  let restored = 0
  try {
    if (!fs.existsSync(dir)) return 0
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const chatId = Number(file.replace('.jsonl', ''))
      if (!Number.isFinite(chatId)) continue
      if (restoreThread(cfg, chatId) > 0) restored++
    }
  } catch (e) {
    log.warn(`thread restore failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return restored
}

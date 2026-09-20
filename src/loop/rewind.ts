import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Config } from '../config.js'
import { log } from '../log.js'
import {
  installRestoredThread,
  messagesFromTranscriptRecords,
  readTranscriptSnapshot,
  transcriptPath,
} from './context.js'

/**
 * Run checkpoints + /rewind — undo the last n top-level runs.
 *
 * A checkpoint is recorded at TOP-LEVEL RUN START, before the run's user
 * message is appended to the durable transcript (data/transcript/<chatId>.jsonl).
 * So checkpoint.lines = transcript record count BEFORE that run touched
 * anything, and rewinding to it truncates the transcript exactly at a record
 * boundary that precedes the run's own prompt — tool pairs stay intact by
 * construction.
 *
 * Each checkpoint BINDS to the exact transcript prefix that created it via a
 * SHA-256 digest of the durable record strings in their original order
 * (node built-in crypto, no dependency). A line count locates a boundary; a
 * digest proves which boundary it is. Rewind verifies count AND digest before
 * ANY destructive write — appended records after a checkpoint are valid;
 * replaced/reordered/removed records inside the prefix are not.
 *
 * Rewind is transactional: the live window is built from the SAME verified
 * target records the durable rewrite installs, and installed only AFTER the
 * rename succeeds — live and durable truth may not diverge.
 *
 * AUTHORITY: rewind is a principal act (Telegram admin seam + token-gated
 * dashboard lane). No agent tool exposes it — the frog never rewinds its own
 * thread.
 */

export type RewindCheckpoint = { ts: number; lines: number; preview: string; prefixSha256: string }
export type RewindResult = { ok: boolean; text: string; error?: string }

const PREVIEW_CHARS = 80
const HEX64 = /^[0-9a-f]{64}$/

/** Bounded ring — a long soak must not grow checkpoints unbounded. */
function maxCheckpoints(): number {
  return Math.max(4, Number(process.env['REWIND_MAX_CHECKPOINTS']) || 24)
}

function checkpointsPath(cfg: Config, chatId: number): string {
  return path.join(cfg.paths.dataDir, 'transcript', `${chatId}.checkpoints.json`)
}

/** ONE canonical digest, shared by checkpoint creation and rewind
 * verification: the actual durable record strings in original order —
 * never parsed/re-stringified JSON, previews, or the line count alone.
 * Empty transcript hashes the empty UTF-8 string. */
export function transcriptPrefixDigest(records: string[]): string {
  const h = createHash('sha256')
  if (records.length > 0) h.update(`${records.join('\n')}\n`, 'utf8')
  return h.digest('hex')
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function isValidCheckpoint(c: unknown): c is RewindCheckpoint {
  if (typeof c !== 'object' || c === null) return false
  const rec = c as Partial<RewindCheckpoint>
  return (
    Number.isInteger(rec.ts) === true &&
    (rec.ts as number) > 0 &&
    Number.isInteger(rec.lines) === true &&
    (rec.lines as number) >= 0 &&
    typeof rec.preview === 'string' &&
    typeof rec.prefixSha256 === 'string' &&
    HEX64.test(rec.prefixSha256)
  )
}

/** Tolerant read of the CHECKPOINT ring (hardened validation — malformed
 * authority coordinates are refusal material, not defaults). A corrupt or
 * half-written file reads as empty; unusable entries are excluded, never
 * silently repaired or backfilled with invented fingerprints. */
export function listCheckpoints(cfg: Config, chatId: number): RewindCheckpoint[] {
  try {
    const p = checkpointsPath(cfg, chatId)
    if (!fs.existsSync(p)) return []
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidCheckpoint)
  } catch (e) {
    log.warn(`rewind checkpoint list failed for chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

/** Record a checkpoint at top-level run start (called from agentLoop, depth 0,
 * BEFORE the run's user message is appended). Serialized against rewinds by
 * the same per-chat run queue that serializes runs.
 *
 * A failed transcript observation SKIPS the checkpoint — it may never
 * manufacture one (unknown state is not an empty transcript). Checkpoint
 * failure still fails OPEN for the run: the run continues, it is simply not
 * rewindable to this boundary. */
export function recordCheckpoint(cfg: Config, chatId: number, preview: string): void {
  try {
    const snap = readTranscriptSnapshot(cfg, chatId)
    if (!snap.ok) {
      log.warn(`rewind checkpoint skipped for chat ${chatId}: transcript unobservable (${snap.error})`)
      return
    }
    const list = listCheckpoints(cfg, chatId)
    list.push({
      ts: Date.now(),
      lines: snap.records.length,
      preview: preview.slice(0, PREVIEW_CHARS),
      prefixSha256: transcriptPrefixDigest(snap.records),
    })
    while (list.length > maxCheckpoints()) list.shift()
    writeJsonAtomic(checkpointsPath(cfg, chatId), list)
  } catch (e) {
    // A checkpoint failure must never break the run it precedes.
    log.warn(`rewind checkpoint record failed for chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Undo the last n top-level runs. Transactional sequence: validate → observe
 * transcript → prove count → prove prefix digest → derive target records →
 * build the candidate live window FROM those records → write tmp → rename →
 * install the prebuilt live window → prune checkpoints. Nothing mutates
 * (durable or live) until every proof passes; the live install happens only
 * after durable persistence succeeds.
 */
export function applyRewind(cfg: Config, chatId: number, n: number): RewindResult {
  // A. validate n
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, text: '', error: 'usage: /rewind [n] — n = how many recent runs to undo' }
  }
  // B. load + validate checkpoints
  const cps = listCheckpoints(cfg, chatId)
  if (cps.length === 0) {
    return { ok: false, text: '', error: 'no checkpoints yet — checkpoints are recorded per run from this desk build on' }
  }
  if (n > cps.length) {
    return { ok: false, text: '', error: `only ${cps.length} checkpoint(s) exist — cannot rewind ${n} run(s)` }
  }
  const target = cps[cps.length - n]!

  // C. read transcript snapshot (unknown state refuses — never truncates blind)
  const snap = readTranscriptSnapshot(cfg, chatId)
  if (!snap.ok) {
    return { ok: false, text: '', error: `transcript unreadable: ${snap.error}` }
  }
  // D. prove count
  if (snap.records.length < target.lines) {
    return {
      ok: false,
      text: '',
      error: `transcript has ${snap.records.length} record(s) but checkpoint claims ${target.lines} — state moved under us, refusing`,
    }
  }
  // E. prove identity: the boundary must still belong to the same history
  //    that created the checkpoint. Appended suffixes are fine; a replaced,
  //    reordered, or edited prefix is refusal material.
  const targetRecords = snap.records.slice(0, target.lines)
  const actualDigest = transcriptPrefixDigest(targetRecords)
  if (actualDigest !== target.prefixSha256) {
    return {
      ok: false,
      text: '',
      error: 'checkpoint no longer matches the transcript prefix it was recorded against (history replaced, reordered, or edited) — refusing',
    }
  }

  // G. build the candidate live window FROM the exact verified target records
  //    (same parse/window/repair/microcompact path as boot) BEFORE any write.
  const candidateLive = messagesFromTranscriptRecords(chatId, targetRecords)

  // H. write transcript tmp — truncate by record boundary, never bytes.
  const tPath = transcriptPath(cfg, chatId)
  try {
    const tmp = `${tPath}.tmp`
    if (targetRecords.length === 0) fs.writeFileSync(tmp, '')
    else fs.writeFileSync(tmp, `${targetRecords.join('\n')}\n`)
    // I. rename tmp → transcript
    fs.renameSync(tmp, tPath)
  } catch (e) {
    // Write/rename failed: durable AND live state both unchanged.
    return { ok: false, text: '', error: `transcript truncate failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  // J. install the prebuilt candidate — durable rename already succeeded.
  installRestoredThread(chatId, candidateLive)

  // K. prune the undone checkpoints (the n most recent, target excluded).
  try {
    writeJsonAtomic(checkpointsPath(cfg, chatId), cps.slice(0, cps.length - n))
  } catch (e) {
    log.warn(`rewind checkpoint prune failed for chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`)
  }

  const dropped = snap.records.length - target.lines
  const when = new Date(target.ts).toLocaleString()
  const text =
    `⏪ rewound ${n} run(s) — dropped ${dropped} transcript record(s), ${candidateLive.length} message(s) back in the live window\n` +
    `• undone run started ${when}: "${target.preview}"`
  log.info(`rewind chat ${chatId}: n=${n} dropped=${dropped} restored=${candidateLive.length}`)
  return { ok: true, text }
}

/** One-line-per-checkpoint list for /rewind with no args (most recent first). */
export function formatCheckpointList(cfg: Config, chatId: number): string {
  const cps = listCheckpoints(cfg, chatId)
  if (cps.length === 0) {
    return '⏪ no checkpoints yet — every top-level run records one; /rewind [n] undoes the n-th-last run'
  }
  const rows = cps
    .slice(-8)
    .reverse()
    .map((c, i) => `${i + 1}. ${new Date(c.ts).toLocaleString()} · "${c.preview}"`)
  return (
    `⏪ checkpoints (most recent first, max ${cps.length}) — /rewind <n> undoes the n-th-last run:\n` +
    rows.join('\n')
  )
}
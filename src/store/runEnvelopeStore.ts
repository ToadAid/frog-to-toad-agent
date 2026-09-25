import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'

export const RUN_ENVELOPE_SCHEMA_VERSION = 'frog.governed-run-envelope.v1' as const
export const RUN_FENCE_SCHEMA_VERSION = 'frog.governed-run-fence.v1' as const

const SHA256 = /^[a-f0-9]{64}$/
const MAX_ID_CHARS = 200
const MAX_PAYLOAD_BYTES = 1024 * 1024
const DEFAULT_LOCK_ATTEMPTS = 80
const DEFAULT_LOCK_DELAY_MS = 25

export type RunWriterFence = Readonly<{
  schemaVersion: typeof RUN_FENCE_SCHEMA_VERSION
  runId: string
  ownerId: string
  fencingToken: number
  issuedAt: string
  reason: 'START' | 'RESTART' | 'FAILOVER'
}>

export type StoredRunEnvelopeRecord = Readonly<{
  schemaVersion: typeof RUN_ENVELOPE_SCHEMA_VERSION
  runId: string
  slot: string
  revision: number
  updatedAt: string
  writer: Readonly<{ ownerId: string; fencingToken: number }>
  envelopeSha256: string
  previousHeadSha256: string | null
  envelope: unknown
}>

export type StoredRunEnvelopeHead = Readonly<{
  record: StoredRunEnvelopeRecord
  headSha256: string
}>

export type PersistRunEnvelopeInput = Readonly<{
  slot: string
  expectedHeadSha256: string | null
  envelope: unknown
  updatedAt?: string
}>

type FenceControl = Readonly<{
  schemaVersion: typeof RUN_FENCE_SCHEMA_VERSION
  runId: string
  ownerId: string
  fencingToken: number
  issuedAt: string
  reason: RunWriterFence['reason']
}>

const serialTails = new Map<string, Promise<void>>()

function boundedId(value: string, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_ID_CHARS || trimmed.includes('\0')) {
    throw new TypeError(`${label} is invalid`)
  }
  return trimmed
}

function iso(value: string | undefined): string {
  const candidate = value ?? new Date().toISOString()
  const ms = Date.parse(candidate)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== candidate) throw new TypeError('timestamp must be canonical ISO-8601')
  return candidate
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stableJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('run envelope contains a non-finite number')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('run envelope contains a cycle')
    seen.add(value)
    const result = value.map((item) => stableJsonValue(item, seen))
    seen.delete(value)
    return result
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('run envelope contains a cycle')
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new TypeError('run envelope must contain plain JSON objects')
    seen.add(value)
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (key.includes('\0')) throw new TypeError('run envelope contains an invalid object key')
      const item = source[key]
      if (item === undefined) throw new TypeError('run envelope must not contain undefined values')
      result[key] = stableJsonValue(item, seen)
    }
    seen.delete(value)
    return result
  }
  throw new TypeError(`run envelope contains unsupported value type: ${typeof value}`)
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value))
}

function canonicalEnvelopeJson(value: unknown): string {
  const json = stableJson(value)
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) throw new RangeError(`run envelope exceeds ${MAX_PAYLOAD_BYTES} bytes`)
  return json
}

function recordSha256(record: StoredRunEnvelopeRecord): string {
  return sha256(stableJson(record))
}

function runKey(runId: string): string {
  return sha256(boundedId(runId, 'runId'))
}

function slotKey(slot: string): string {
  return sha256(boundedId(slot, 'slot'))
}

function runDir(cfg: Config, runId: string): string {
  return path.join(cfg.paths.dataDir, 'runtime', 'governed-runs', runKey(runId))
}

function controlPath(cfg: Config, runId: string): string {
  return path.join(runDir(cfg, runId), 'control.json')
}

function lockPath(cfg: Config, runId: string): string {
  return path.join(runDir(cfg, runId), '.lock')
}

function slotPath(cfg: Config, runId: string, slot: string): string {
  return path.join(runDir(cfg, runId), 'slots', `${slotKey(slot)}.json`)
}

function lockAttempts(): number {
  const parsed = Number(process.env['RUN_ENVELOPE_LOCK_ATTEMPTS'])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_ATTEMPTS
}

function lockDelayMs(): number {
  const parsed = Number(process.env['RUN_ENVELOPE_LOCK_DELAY_MS'])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_DELAY_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as NodeJS.ErrnoException).code === code
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function writeJsonAtomicDurable(file: string, value: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, file)
    fsyncDir(dir)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

async function withSerial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = serialTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  serialTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (serialTails.get(key) === tail) serialTails.delete(key)
  }
}

async function withRunLock<T>(cfg: Config, runId: string, fn: () => Promise<T> | T): Promise<T> {
  const canonicalRunId = boundedId(runId, 'runId')
  return withSerial(runKey(canonicalRunId), async () => {
    const dir = runDir(cfg, canonicalRunId)
    fs.mkdirSync(dir, { recursive: true })
    const file = lockPath(cfg, canonicalRunId)
    const token = crypto.randomUUID()
    let acquired = false
    for (let attempt = 0; attempt < lockAttempts(); attempt++) {
      try {
        const fd = fs.openSync(file, 'wx', 0o600)
        try {
          fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }), 'utf8')
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        acquired = true
        break
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          await sleep(lockDelayMs())
          continue
        }
        throw new Error(`run envelope lock could not be created: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!acquired) throw new Error('run envelope store is busy; stale lock is not permission to steal')
    try {
      return await fn()
    } finally {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: unknown }
        if (raw.token === token) fs.rmSync(file)
      } catch {
        // Fail closed: a vanished or changed lock is never removed by this holder.
      }
    }
  })
}

function parseControl(value: unknown, expectedRunId: string): FenceControl {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('run fence control has invalid shape')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== RUN_FENCE_SCHEMA_VERSION) throw new Error('run fence control schemaVersion mismatch')
  if (record.runId !== expectedRunId) throw new Error('run fence control runId mismatch')
  const ownerId = boundedId(record.ownerId as string, 'ownerId')
  if (!Number.isSafeInteger(record.fencingToken) || (record.fencingToken as number) < 1) throw new Error('run fence control token is invalid')
  const issuedAt = iso(record.issuedAt as string)
  if (!['START', 'RESTART', 'FAILOVER'].includes(record.reason as string)) throw new Error('run fence control reason is invalid')
  return Object.freeze({
    schemaVersion: RUN_FENCE_SCHEMA_VERSION,
    runId: expectedRunId,
    ownerId,
    fencingToken: record.fencingToken as number,
    issuedAt,
    reason: record.reason as RunWriterFence['reason'],
  })
}

function readControl(cfg: Config, runId: string): FenceControl | null {
  let raw: string
  try { raw = fs.readFileSync(controlPath(cfg, runId), 'utf8') }
  catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('run fence control is not valid JSON') }
  return parseControl(parsed, runId)
}

function validateLease(lease: RunWriterFence): RunWriterFence {
  const runId = boundedId(lease.runId, 'runId')
  const ownerId = boundedId(lease.ownerId, 'ownerId')
  if (lease.schemaVersion !== RUN_FENCE_SCHEMA_VERSION) throw new Error('run writer fence schemaVersion mismatch')
  if (!Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1) throw new Error('run writer fencingToken is invalid')
  const issuedAt = iso(lease.issuedAt)
  if (!['START', 'RESTART', 'FAILOVER'].includes(lease.reason)) throw new Error('run writer fence reason is invalid')
  return Object.freeze({ ...lease, runId, ownerId, issuedAt })
}

function assertFenceCurrentUnsafe(cfg: Config, lease: RunWriterFence): void {
  const canonical = validateLease(lease)
  const current = readControl(cfg, canonical.runId)
  if (!current) throw new Error('run writer fence is not established')
  if (current.fencingToken !== canonical.fencingToken || current.ownerId !== canonical.ownerId) {
    throw new Error('stale run writer fence')
  }
}

function parseStoredHead(value: unknown, expectedRunId: string, expectedSlot: string): StoredRunEnvelopeHead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('stored run envelope head has invalid shape')
  const wrapper = value as Record<string, unknown>
  if (typeof wrapper.headSha256 !== 'string' || !SHA256.test(wrapper.headSha256)) throw new Error('stored run envelope head SHA is invalid')
  if (typeof wrapper.record !== 'object' || wrapper.record === null || Array.isArray(wrapper.record)) throw new Error('stored run envelope record has invalid shape')
  const record = wrapper.record as unknown as StoredRunEnvelopeRecord
  if (record.schemaVersion !== RUN_ENVELOPE_SCHEMA_VERSION) throw new Error('stored run envelope schemaVersion mismatch')
  if (record.runId !== expectedRunId || record.slot !== expectedSlot) throw new Error('stored run envelope identity mismatch')
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error('stored run envelope revision is invalid')
  iso(record.updatedAt)
  boundedId(record.writer?.ownerId, 'writer.ownerId')
  if (!Number.isSafeInteger(record.writer?.fencingToken) || record.writer.fencingToken < 1) throw new Error('stored run envelope fencing token is invalid')
  if (typeof record.envelopeSha256 !== 'string' || !SHA256.test(record.envelopeSha256)) throw new Error('stored run envelope payload SHA is invalid')
  if (record.previousHeadSha256 !== null && (typeof record.previousHeadSha256 !== 'string' || !SHA256.test(record.previousHeadSha256))) {
    throw new Error('stored run envelope predecessor SHA is invalid')
  }
  if (record.revision === 0 && record.previousHeadSha256 !== null) throw new Error('initial run envelope predecessor must be null')
  if (record.revision > 0 && record.previousHeadSha256 === null) throw new Error('non-initial run envelope predecessor is missing')
  const canonicalEnvelope = canonicalEnvelopeJson(record.envelope)
  if (sha256(canonicalEnvelope) !== record.envelopeSha256) throw new Error('stored run envelope payload integrity mismatch')
  if (recordSha256(record) !== wrapper.headSha256) throw new Error('stored run envelope head integrity mismatch')
  return Object.freeze({ record: Object.freeze(record), headSha256: wrapper.headSha256 })
}

function readHeadUnsafe(cfg: Config, runId: string, slot: string): StoredRunEnvelopeHead | null {
  const file = slotPath(cfg, runId, slot)
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('stored run envelope head is not valid JSON') }
  return parseStoredHead(parsed, runId, slot)
}

export async function issueRunWriterFence(
  cfg: Config,
  input: Readonly<{ runId: string; ownerId: string; reason: RunWriterFence['reason']; issuedAt?: string }>,
): Promise<RunWriterFence> {
  const runId = boundedId(input.runId, 'runId')
  const ownerId = boundedId(input.ownerId, 'ownerId')
  const issuedAt = iso(input.issuedAt)
  return withRunLock(cfg, runId, () => {
    const previous = readControl(cfg, runId)
    if (previous && Date.parse(issuedAt) < Date.parse(previous.issuedAt)) throw new RangeError('run writer issuedAt cannot move backwards')
    const fencingToken = (previous?.fencingToken ?? 0) + 1
    if (!Number.isSafeInteger(fencingToken)) throw new RangeError('run writer fencing token exhausted')
    const control: FenceControl = Object.freeze({
      schemaVersion: RUN_FENCE_SCHEMA_VERSION,
      runId,
      ownerId,
      fencingToken,
      issuedAt,
      reason: input.reason,
    })
    writeJsonAtomicDurable(controlPath(cfg, runId), control)
    return control
  })
}

export function assertRunWriterFenceCurrent(cfg: Config, lease: RunWriterFence): void {
  assertFenceCurrentUnsafe(cfg, lease)
}

export function readRunEnvelopeHead(cfg: Config, runIdInput: string, slotInput: string): StoredRunEnvelopeHead | null {
  const runId = boundedId(runIdInput, 'runId')
  const slot = boundedId(slotInput, 'slot')
  return readHeadUnsafe(cfg, runId, slot)
}

export async function persistRunEnvelope(
  cfg: Config,
  leaseInput: RunWriterFence,
  input: PersistRunEnvelopeInput,
): Promise<StoredRunEnvelopeHead> {
  const lease = validateLease(leaseInput)
  const slot = boundedId(input.slot, 'slot')
  const updatedAt = iso(input.updatedAt)
  const envelopeJson = canonicalEnvelopeJson(input.envelope)
  const envelope = JSON.parse(envelopeJson) as unknown
  const envelopeSha256 = sha256(envelopeJson)
  if (input.expectedHeadSha256 !== null && !SHA256.test(input.expectedHeadSha256)) throw new TypeError('expectedHeadSha256 is invalid')

  return withRunLock(cfg, lease.runId, () => {
    assertFenceCurrentUnsafe(cfg, lease)
    const current = readHeadUnsafe(cfg, lease.runId, slot)
    const actualHead = current?.headSha256 ?? null
    if (actualHead !== input.expectedHeadSha256) {
      throw new Error(`run envelope CAS mismatch: expected ${input.expectedHeadSha256 ?? 'EMPTY'}, found ${actualHead ?? 'EMPTY'}`)
    }
    const record: StoredRunEnvelopeRecord = Object.freeze({
      schemaVersion: RUN_ENVELOPE_SCHEMA_VERSION,
      runId: lease.runId,
      slot,
      revision: (current?.record.revision ?? -1) + 1,
      updatedAt,
      writer: Object.freeze({ ownerId: lease.ownerId, fencingToken: lease.fencingToken }),
      envelopeSha256,
      previousHeadSha256: actualHead,
      envelope,
    })
    const head: StoredRunEnvelopeHead = Object.freeze({ record, headSha256: recordSha256(record) })
    writeJsonAtomicDurable(slotPath(cfg, lease.runId, slot), head)
    return head
  })
}

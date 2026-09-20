import {
  digestCanonicalJson,
  serializeCanonicalJson,
} from './developmentalMemory.js'
import {
  decodeEvidenceSnapshotV1,
  type EvidenceSnapshotV1,
  type JsonValue,
} from '../spine/evidence.js'

export const TEMPORAL_CONTINUITY_SCHEMA_VERSION = 1 as const
export const TEMPORAL_CONTINUITY_EVENT_ARTIFACT = 'TemporalContinuityEventV1' as const

export type TemporalContinuityEventTypeV1 =
  | 'EVIDENCE_OBSERVED'
  | 'JOURNAL_DECISION_RECORDED'

export type TemporalContinuitySourceProvenanceV1 =
  | 'ORIGINAL_SOURCE_REF'
  | 'DERIVED_LEGACY'

export interface TemporalContinuitySourceV1 {
  readonly store: 'evidence-snapshot' | 'journal'
  readonly recordId: string
  readonly contentDigestSha256: string
  readonly provenance: TemporalContinuitySourceProvenanceV1
}

export type TemporalContinuityFreshnessV1 =
  | {
      readonly kind: 'WINDOW'
      readonly maxAgeMs: number
    }
  | {
      readonly kind: 'HISTORICAL'
    }

export type TemporalContinuityCausationV1 = {
  readonly kind: 'UNPROVEN'
}

export interface TemporalContinuityEventV1 {
  readonly schemaVersion: typeof TEMPORAL_CONTINUITY_SCHEMA_VERSION
  readonly artifact: typeof TEMPORAL_CONTINUITY_EVENT_ARTIFACT
  readonly eventId: string
  readonly eventType: TemporalContinuityEventTypeV1
  readonly source: TemporalContinuitySourceV1
  /** When the evidenced thing happened. Null means the source does not establish it. */
  readonly occurredAt: number | null
  /** When the source observed the thing. */
  readonly observedAt: number
  /** Earliest time this artifact proves the desk could know it. */
  readonly knownAt: number
  readonly freshness: TemporalContinuityFreshnessV1
  readonly episodeId: string
  readonly correlationId: string
  readonly causation: TemporalContinuityCausationV1
  readonly evidenceRefs: readonly string[]
  readonly eventData: JsonValue
  readonly authorityGranted: false
}

export interface TemporalContinuityEventV1Input {
  readonly schemaVersion: 1
  readonly eventType: TemporalContinuityEventTypeV1
  readonly source: TemporalContinuitySourceV1
  readonly occurredAt: number | null
  readonly observedAt: number
  readonly knownAt: number
  readonly freshness: TemporalContinuityFreshnessV1
  readonly episodeId: string
  readonly correlationId: string
  readonly causation: TemporalContinuityCausationV1
  readonly evidenceRefs: readonly string[]
  readonly eventData: JsonValue
  readonly authorityGranted: false
}

export interface JournalTemporalInputV1 {
  readonly journalRef?: string
  readonly ts: number
  readonly symbol: string
  readonly decision: string
  readonly outcome?: string
  readonly grade?: 'good-process' | 'bad-process'
  readonly lesson?: string
  readonly runId?: string
}

export interface TemporalKnowledgeProjectionV1 {
  readonly schemaVersion: 1
  readonly artifact: 'TemporalKnowledgeProjectionV1'
  readonly asOf: number
  /** Events whose knowledge-availability time is <= asOf. */
  readonly known: readonly TemporalContinuityEventV1[]
  /** Freshness-only evidence at asOf. This never implies READY/admissible fitness. */
  readonly freshEvidence: readonly TemporalContinuityEventV1[]
  /** Known events that are historical, including stale evidence. */
  readonly history: readonly TemporalContinuityEventV1[]
  /** Events unavailable to the desk at asOf. */
  readonly future: readonly TemporalContinuityEventV1[]
  readonly authorityGranted: false
}

export interface TemporalDecisionTimelineV1 {
  readonly schemaVersion: 1
  readonly artifact: 'TemporalDecisionTimelineV1'
  readonly decision: TemporalContinuityEventV1
  /** Strictly knowable before the decision's knowledge-availability instant. */
  readonly knowledgeBeforeDecision: TemporalKnowledgeProjectionV1
  readonly before: readonly TemporalContinuityEventV1[]
  /** Same knownAt as the decision; ordering relative to the decision is unproven. */
  readonly coTemporalUnordered: readonly TemporalContinuityEventV1[]
  readonly after: readonly TemporalContinuityEventV1[]
  readonly ordering: {
    readonly causal: false
    readonly rule: 'KNOWN_AT_OBSERVED_AT_OCCURRED_AT_EVENT_ID'
    readonly coTemporalOrder: 'UNPROVEN'
  }
  readonly authorityGranted: false
}

export type TemporalContinuityErrorCode =
  | 'INVALID_SHAPE'
  | 'INVALID_TIME'
  | 'IMPOSSIBLE_CHRONOLOGY'
  | 'INVALID_DIGEST'
  | 'AUTHORITY_REQUESTED'
  | 'INVALID_CAUSATION'
  | 'INVALID_JOURNAL_ENTRY'
  | 'EVENT_ID_MISMATCH'
  | 'DUPLICATE_EVENT'
  | 'DECISION_NOT_FOUND'
  | 'TARGET_NOT_DECISION'

export class TemporalContinuityError extends Error {
  constructor(
    public readonly code: TemporalContinuityErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'TemporalContinuityError'
  }
}

const SHA256 = /^[a-f0-9]{64}$/

function fail(code: TemporalContinuityErrorCode, message: string): never {
  throw new TemporalContinuityError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_SHAPE', `${label} must contain exactly: ${wanted.join(', ')}`)
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key))
  if (extra.length > 0) fail('INVALID_JOURNAL_ENTRY', `${label} has unknown field(s): ${extra.join(', ')}`)
}

function text(value: unknown, label: string, code: TemporalContinuityErrorCode = 'INVALID_SHAPE'): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be non-empty canonical text`)
  }
  return value
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_TIME', `${label} must be a non-negative safe integer`)
  }
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('INVALID_DIGEST', `${label} must be lowercase SHA-256 hex`)
  }
  return value
}

function uniqueTexts(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail('INVALID_SHAPE', `${label} must be an array`)
  const items = value.map((item, index) => text(item, `${label}[${index}]`))
  if (new Set(items).size !== items.length) fail('INVALID_SHAPE', `${label} contains duplicates`)
  return items.sort()
}

function jsonValue(value: unknown, label = 'eventData'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_SHAPE', `${label} contains a non-finite number`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`))
  if (!isRecord(value)) fail('INVALID_SHAPE', `${label} must contain canonical JSON values`)
  const cloned: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, item] of Object.entries(value)) cloned[key] = jsonValue(item, `${label}.${key}`)
  return cloned
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function parseSource(value: unknown): TemporalContinuitySourceV1 {
  if (!isRecord(value)) fail('INVALID_SHAPE', 'source must be a plain object')
  exactKeys(value, ['store', 'recordId', 'contentDigestSha256', 'provenance'], 'source')
  if (value.store !== 'evidence-snapshot' && value.store !== 'journal') {
    fail('INVALID_SHAPE', 'source.store is unsupported')
  }
  if (value.provenance !== 'ORIGINAL_SOURCE_REF' && value.provenance !== 'DERIVED_LEGACY') {
    fail('INVALID_SHAPE', 'source.provenance is unsupported')
  }
  const parsed = {
    store: value.store,
    recordId: text(value.recordId, 'source.recordId'),
    contentDigestSha256: digest(value.contentDigestSha256, 'source.contentDigestSha256'),
    provenance: value.provenance,
  } as TemporalContinuitySourceV1

  if (parsed.provenance === 'DERIVED_LEGACY') {
    if (parsed.store !== 'journal') fail('INVALID_SHAPE', 'DERIVED_LEGACY is journal-only in P1')
    if (parsed.recordId !== `legacy-journal:${parsed.contentDigestSha256}`) {
      fail('INVALID_SHAPE', 'legacy journal identity must be visibly content-derived')
    }
  }
  return parsed
}

function parseFreshness(value: unknown): TemporalContinuityFreshnessV1 {
  if (!isRecord(value)) fail('INVALID_SHAPE', 'freshness must be a plain object')
  if (value.kind === 'HISTORICAL') {
    exactKeys(value, ['kind'], 'freshness')
    return { kind: 'HISTORICAL' }
  }
  if (value.kind === 'WINDOW') {
    exactKeys(value, ['kind', 'maxAgeMs'], 'freshness')
    return { kind: 'WINDOW', maxAgeMs: timestamp(value.maxAgeMs, 'freshness.maxAgeMs') }
  }
  return fail('INVALID_SHAPE', 'freshness.kind is unsupported')
}

function parseCausation(value: unknown): TemporalContinuityCausationV1 {
  if (!isRecord(value)) fail('INVALID_CAUSATION', 'causation must be a plain object')
  if (value.kind !== 'UNPROVEN') {
    fail(
      'INVALID_CAUSATION',
      'P1 records sequence only; positive causal proof requires a later source-verification contract',
    )
  }
  exactKeys(value, ['kind'], 'causation')
  return { kind: 'UNPROVEN' }
}

function eventInput(value: unknown): TemporalContinuityEventV1Input {
  if (!isRecord(value)) fail('INVALID_SHAPE', 'temporal event input must be a plain object')
  exactKeys(value, [
    'schemaVersion', 'eventType', 'source', 'occurredAt', 'observedAt', 'knownAt',
    'freshness', 'episodeId', 'correlationId', 'causation', 'evidenceRefs',
    'eventData', 'authorityGranted',
  ], 'temporal event input')
  if (value.schemaVersion !== 1) fail('INVALID_SHAPE', 'schemaVersion must be 1')
  if (value.eventType !== 'EVIDENCE_OBSERVED' && value.eventType !== 'JOURNAL_DECISION_RECORDED') {
    fail('INVALID_SHAPE', 'eventType is unsupported')
  }
  if (value.authorityGranted !== false) {
    fail('AUTHORITY_REQUESTED', 'temporal continuity grants no execution authority')
  }

  const occurredAt = value.occurredAt === null ? null : timestamp(value.occurredAt, 'occurredAt')
  const observedAt = timestamp(value.observedAt, 'observedAt')
  const knownAt = timestamp(value.knownAt, 'knownAt')
  if (occurredAt !== null && occurredAt > observedAt) {
    fail('IMPOSSIBLE_CHRONOLOGY', 'occurredAt cannot follow observedAt')
  }
  if (observedAt > knownAt) {
    fail('IMPOSSIBLE_CHRONOLOGY', 'observedAt cannot follow knownAt')
  }

  const source = parseSource(value.source)
  const causation = parseCausation(value.causation)
  const evidenceRefs = uniqueTexts(value.evidenceRefs, 'evidenceRefs')
  if (source.store === 'evidence-snapshot' && source.provenance !== 'ORIGINAL_SOURCE_REF') {
    fail('INVALID_SHAPE', 'canonical evidence snapshots cannot be legacy-derived')
  }

  return {
    schemaVersion: 1,
    eventType: value.eventType,
    source,
    occurredAt,
    observedAt,
    knownAt,
    freshness: parseFreshness(value.freshness),
    episodeId: text(value.episodeId, 'episodeId'),
    correlationId: text(value.correlationId, 'correlationId'),
    causation,
    evidenceRefs,
    eventData: jsonValue(value.eventData),
    authorityGranted: false,
  }
}

/**
 * Canonical temporal events are immutable read artifacts. P1 does NOT create a
 * universal event store: append-only source journals/evidence remain the truth.
 */
export function createTemporalContinuityEventV1(
  value: TemporalContinuityEventV1Input | unknown,
): TemporalContinuityEventV1 {
  const input = eventInput(value)
  const body = {
    schemaVersion: 1 as const,
    artifact: TEMPORAL_CONTINUITY_EVENT_ARTIFACT,
    eventType: input.eventType,
    source: input.source,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    knownAt: input.knownAt,
    freshness: input.freshness,
    episodeId: input.episodeId,
    correlationId: input.correlationId,
    causation: input.causation,
    evidenceRefs: input.evidenceRefs,
    eventData: input.eventData,
    authorityGranted: false as const,
  }
  const eventId = digestCanonicalJson(body)
  return deepFreeze({ ...body, eventId }) as TemporalContinuityEventV1
}

/** Re-prove shape, fixed authority, and content-addressed identity. */
export function decodeTemporalContinuityEventV1(value: unknown): TemporalContinuityEventV1 {
  if (!isRecord(value)) fail('INVALID_SHAPE', 'temporal event must be a plain object')
  exactKeys(value, [
    'schemaVersion', 'artifact', 'eventId', 'eventType', 'source', 'occurredAt',
    'observedAt', 'knownAt', 'freshness', 'episodeId', 'correlationId',
    'causation', 'evidenceRefs', 'eventData', 'authorityGranted',
  ], 'temporal event')
  if (value.artifact !== TEMPORAL_CONTINUITY_EVENT_ARTIFACT) {
    fail('INVALID_SHAPE', 'temporal event artifact tag is invalid')
  }
  const suppliedId = digest(value.eventId, 'eventId')
  const rebuilt = createTemporalContinuityEventV1({
    schemaVersion: value.schemaVersion,
    eventType: value.eventType,
    source: value.source,
    occurredAt: value.occurredAt,
    observedAt: value.observedAt,
    knownAt: value.knownAt,
    freshness: value.freshness,
    episodeId: value.episodeId,
    correlationId: value.correlationId,
    causation: value.causation,
    evidenceRefs: value.evidenceRefs,
    eventData: value.eventData,
    authorityGranted: value.authorityGranted,
  })
  if (suppliedId !== rebuilt.eventId) {
    fail('EVENT_ID_MISMATCH', 'eventId does not match canonical event content')
  }
  if (serializeCanonicalJson(value) !== serializeCanonicalJson(rebuilt)) {
    fail('EVENT_ID_MISMATCH', 'temporal event derived coordinates do not match canonical reconstruction')
  }
  return rebuilt
}

/**
 * Project already-canonical evidence into the temporal lens. `knownAt` is
 * receivedAt: observation alone does not prove the desk possessed the evidence.
 */
export function projectEvidenceSnapshotTemporalEventV1(
  value: EvidenceSnapshotV1 | unknown,
): TemporalContinuityEventV1 {
  const snapshot = decodeEvidenceSnapshotV1(value)
  return createTemporalContinuityEventV1({
    schemaVersion: 1,
    eventType: 'EVIDENCE_OBSERVED',
    source: {
      store: 'evidence-snapshot',
      recordId: snapshot.evidenceId,
      contentDigestSha256: snapshot.digest,
      provenance: 'ORIGINAL_SOURCE_REF',
    },
    occurredAt: snapshot.eventTime,
    observedAt: snapshot.observedAt,
    knownAt: snapshot.receivedAt,
    freshness: {
      kind: 'WINDOW',
      maxAgeMs: snapshot.freshness.maxAgeMs,
    },
    episodeId: `evidence:${snapshot.evidenceId}`,
    correlationId: `evidence:${snapshot.instrument.instrumentId}:${snapshot.source.recordId}`,
    causation: { kind: 'UNPROVEN' },
    evidenceRefs: [snapshot.evidenceId],
    eventData: {
      evidenceId: snapshot.evidenceId,
      instrumentId: snapshot.instrument.instrumentId,
      sourceProducer: snapshot.source.producer,
      sourceProvider: snapshot.source.provider,
      sourceRecordId: snapshot.source.recordId,
      sourceAsOf: snapshot.asOf,
      sourceFitnessStatusAtSourceAsOf: snapshot.fitness.status,
    },
    authorityGranted: false,
  })
}

function journalInput(value: unknown): JournalTemporalInputV1 {
  if (!isRecord(value)) fail('INVALID_JOURNAL_ENTRY', 'journal row must be a plain object')
  onlyKeys(value, [
    'journalRef', 'ts', 'symbol', 'decision', 'outcome', 'grade', 'lesson', 'runId',
  ], 'journal row')
  const optionalText = (key: 'journalRef' | 'outcome' | 'lesson' | 'runId'): string | undefined => {
    const candidate = value[key]
    return candidate === undefined ? undefined : text(candidate, `journal.${key}`, 'INVALID_JOURNAL_ENTRY')
  }
  if (value.grade !== undefined && value.grade !== 'good-process' && value.grade !== 'bad-process') {
    fail('INVALID_JOURNAL_ENTRY', 'journal.grade is unsupported')
  }
  return {
    journalRef: optionalText('journalRef'),
    ts: timestamp(value.ts, 'journal.ts'),
    symbol: text(value.symbol, 'journal.symbol', 'INVALID_JOURNAL_ENTRY'),
    decision: text(value.decision, 'journal.decision', 'INVALID_JOURNAL_ENTRY'),
    outcome: optionalText('outcome'),
    grade: value.grade as JournalTemporalInputV1['grade'],
    lesson: optionalText('lesson'),
    runId: optionalText('runId'),
  }
}

function canonicalJournalRow(row: JournalTemporalInputV1): JsonValue {
  return {
    journalRef: row.journalRef ?? null,
    ts: row.ts,
    symbol: row.symbol,
    decision: row.decision,
    outcome: row.outcome ?? null,
    grade: row.grade ?? null,
    lesson: row.lesson ?? null,
    runId: row.runId ?? null,
  }
}

/**
 * Journal rows with a source journalRef retain it. Legacy rows are never
 * promoted: they receive a visible content-derived identity and zero evidence refs.
 */
export function projectJournalTemporalEventV1(value: JournalTemporalInputV1 | unknown): TemporalContinuityEventV1 {
  const row = journalInput(value)
  const canonicalRow = canonicalJournalRow(row)
  const contentDigestSha256 = digestCanonicalJson(canonicalRow)
  const legacy = row.journalRef === undefined
  const recordId = row.journalRef ?? `legacy-journal:${contentDigestSha256}`

  return createTemporalContinuityEventV1({
    schemaVersion: 1,
    eventType: 'JOURNAL_DECISION_RECORDED',
    source: {
      store: 'journal',
      recordId,
      contentDigestSha256,
      provenance: legacy ? 'DERIVED_LEGACY' : 'ORIGINAL_SOURCE_REF',
    },
    occurredAt: row.ts,
    observedAt: row.ts,
    knownAt: row.ts,
    freshness: { kind: 'HISTORICAL' },
    episodeId: row.runId ? `run:${row.runId}` : `journal:${recordId}`,
    correlationId: `journal:${recordId}`,
    causation: { kind: 'UNPROVEN' },
    evidenceRefs: legacy ? [] : [row.journalRef!],
    eventData: canonicalRow,
    authorityGranted: false,
  })
}

export function compareTemporalContinuityEventsV1(
  left: TemporalContinuityEventV1,
  right: TemporalContinuityEventV1,
): number {
  if (left.knownAt !== right.knownAt) return left.knownAt - right.knownAt
  if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt
  const leftOccurred = left.occurredAt ?? Number.MAX_SAFE_INTEGER
  const rightOccurred = right.occurredAt ?? Number.MAX_SAFE_INTEGER
  if (leftOccurred !== rightOccurred) return leftOccurred - rightOccurred
  return left.eventId.localeCompare(right.eventId)
}

function canonicalEvents(values: readonly unknown[]): TemporalContinuityEventV1[] {
  if (!Array.isArray(values)) fail('INVALID_SHAPE', 'events must be an array')
  const events = values.map(decodeTemporalContinuityEventV1).sort(compareTemporalContinuityEventsV1)
  const ids = events.map((event) => event.eventId)
  if (new Set(ids).size !== ids.length) fail('DUPLICATE_EVENT', 'temporal event set contains duplicates')
  return events
}

export function projectJournalTemporalEventsV1(values: readonly unknown[]): readonly TemporalContinuityEventV1[] {
  if (!Array.isArray(values)) fail('INVALID_JOURNAL_ENTRY', 'journal rows must be an array')
  return deepFreeze(values.map(projectJournalTemporalEventV1).sort(compareTemporalContinuityEventsV1))
}

function buildKnowledgeProjection(
  events: readonly TemporalContinuityEventV1[],
  asOf: number,
  strictBefore: boolean,
): TemporalKnowledgeProjectionV1 {
  const available = events.filter((event) => strictBefore ? event.knownAt < asOf : event.knownAt <= asOf)
  const future = events.filter((event) => strictBefore ? event.knownAt >= asOf : event.knownAt > asOf)
  const freshEvidence = available.filter((event) =>
    event.eventType === 'EVIDENCE_OBSERVED' &&
    event.freshness.kind === 'WINDOW' &&
    asOf - event.observedAt <= event.freshness.maxAgeMs,
  )
  const freshIds = new Set(freshEvidence.map((event) => event.eventId))
  const history = available.filter((event) => !freshIds.has(event.eventId))

  return deepFreeze({
    schemaVersion: 1 as const,
    artifact: 'TemporalKnowledgeProjectionV1' as const,
    asOf,
    known: [...available],
    freshEvidence: [...freshEvidence],
    history: [...history],
    future: [...future],
    authorityGranted: false as const,
  }) as TemporalKnowledgeProjectionV1
}

/**
 * Reconstruct what the desk can prove it knew by `asOf`. Fresh evidence remains
 * fresh; stale evidence is retained as history; not-yet-known evidence stays future.
 * `freshEvidence` is temporal freshness only and never implies EvidenceFitness READY.
 */
export function knowledgeAtV1(
  values: readonly unknown[],
  asOfValue: number | unknown,
): TemporalKnowledgeProjectionV1 {
  const asOf = timestamp(asOfValue, 'asOf')
  return buildKnowledgeProjection(canonicalEvents(values), asOf, false)
}

/**
 * Reconstruct a journal decision without projecting later knowledge backward.
 * Same-knownAt events are kept explicitly unordered instead of invented as prior context.
 */
export function reconstructDecisionTimelineV1(
  values: readonly unknown[],
  decisionEventIdValue: string | unknown,
): TemporalDecisionTimelineV1 {
  const decisionEventId = digest(decisionEventIdValue, 'decisionEventId')
  const events = canonicalEvents(values)
  const decision = events.find((event) => event.eventId === decisionEventId)
  if (!decision) fail('DECISION_NOT_FOUND', 'decision event is absent from the supplied temporal set')
  if (decision.eventType !== 'JOURNAL_DECISION_RECORDED') {
    fail('TARGET_NOT_DECISION', 'timeline target must be a journal decision event')
  }

  const before = events.filter((event) => event.knownAt < decision.knownAt)
  const coTemporalUnordered = events.filter(
    (event) => event.eventId !== decision.eventId && event.knownAt === decision.knownAt,
  )
  const after = events.filter((event) => event.knownAt > decision.knownAt)

  return deepFreeze({
    schemaVersion: 1 as const,
    artifact: 'TemporalDecisionTimelineV1' as const,
    decision,
    knowledgeBeforeDecision: buildKnowledgeProjection(events, decision.knownAt, true),
    before,
    coTemporalUnordered,
    after,
    ordering: {
      causal: false as const,
      rule: 'KNOWN_AT_OBSERVED_AT_OCCURRED_AT_EVENT_ID' as const,
      coTemporalOrder: 'UNPROVEN' as const,
    },
    authorityGranted: false as const,
  }) as TemporalDecisionTimelineV1
}

import {
  digestCanonicalJson,
  serializeCanonicalJson,
} from '../memory/developmentalMemory.js'

export const EVIDENCE_SNAPSHOT_SCHEMA_VERSION = 1 as const
export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1 as const

export type EvidenceUnitV1 =
  | { readonly kind: 'USD' }
  | { readonly kind: 'PERCENT' }
  | { readonly kind: 'BASIS_POINTS' }
  | { readonly kind: 'TIMESTAMP_MS' }
  | { readonly kind: 'PRICE_RATIO'; readonly numerator: string; readonly denominator: string }
  | { readonly kind: 'TOKEN_RAW'; readonly assetId: string }
  | { readonly kind: 'TOKEN_DECIMAL'; readonly assetId: string; readonly decimals: number }
  | { readonly kind: 'QUANTITY'; readonly assetId: string }
  | { readonly kind: 'NAMED'; readonly name: string }

export interface EvidenceInstrumentIdentityV1 {
  readonly kind: string
  readonly symbol: string
  readonly instrumentId: string
  readonly network: string | null
  readonly address: string | null
  readonly venue: string | null
}

export interface EvidenceSourceV1 {
  readonly producer: string
  readonly provider: string
  readonly recordId: string
}

export interface EvidenceQualityBlockerV1 {
  readonly code: string
  readonly detail: string
}

export type EvidenceFitnessReasonV1 =
  | 'STALE'
  | 'MISSING_REQUIRED_EVIDENCE'
  | 'UNRESOLVED_QUALITY_BLOCKER'

export type EvidenceFitnessV1 =
  | { readonly status: 'READY'; readonly reasons: readonly [] }
  | { readonly status: 'UNREADY'; readonly reasons: readonly EvidenceFitnessReasonV1[] }

export interface EvidenceSnapshotV1 {
  readonly schemaVersion: typeof EVIDENCE_SNAPSHOT_SCHEMA_VERSION
  readonly artifact: 'EvidenceSnapshotV1'
  readonly evidenceId: string
  readonly instrument: EvidenceInstrumentIdentityV1
  readonly source: EvidenceSourceV1
  readonly unit: EvidenceUnitV1
  readonly eventTime: number
  readonly observedAt: number
  readonly receivedAt: number
  readonly asOf: number
  readonly freshness: {
    readonly state: 'FRESH' | 'STALE'
    readonly ageMs: number
    readonly maxAgeMs: number
    readonly basis: 'OBSERVED_AT'
  }
  readonly completeness: {
    readonly state: 'COMPLETE' | 'INCOMPLETE'
    readonly requiredEvidence: readonly string[]
    readonly missingEvidence: readonly string[]
  }
  readonly qualityBlockers: readonly EvidenceQualityBlockerV1[]
  readonly fitness: EvidenceFitnessV1
  readonly value: JsonValue
  readonly authorityGranted: false
  readonly digest: string
}

export type EvidenceSnapshotV1Input = {
  readonly schemaVersion: 1
  readonly instrument: EvidenceInstrumentIdentityV1
  readonly source: EvidenceSourceV1
  readonly unit: EvidenceUnitV1
  readonly eventTime: number
  readonly observedAt: number
  readonly receivedAt: number
  readonly asOf: number
  readonly maxAgeMs: number
  readonly requiredEvidence: readonly string[]
  readonly missingEvidence: readonly string[]
  readonly qualityBlockers: readonly EvidenceQualityBlockerV1[]
  readonly value: JsonValue
  readonly authorityGranted: false
}

export type EvidenceBundleFitnessReasonV1 =
  | 'MISSING_REQUIRED_SLOT'
  | 'UNREADY_REQUIRED_SNAPSHOT'
  | 'UNRESOLVED_CONFLICT'

export type EvidenceBundleFitnessV1 =
  | { readonly status: 'READY'; readonly reasons: readonly [] }
  | { readonly status: 'UNREADY'; readonly reasons: readonly EvidenceBundleFitnessReasonV1[] }

export interface EvidenceConflictV1 {
  readonly slot: string
  readonly snapshotIds: readonly string[]
  readonly reason: string
}

export interface EvidenceBundleConstituentV1 {
  readonly slot: string
  readonly snapshot: EvidenceSnapshotV1
}

export interface EvidenceBundleV1 {
  readonly schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION
  readonly artifact: 'EvidenceBundleV1'
  readonly bundleId: string
  readonly asOf: number
  readonly constituents: readonly EvidenceBundleConstituentV1[]
  readonly requiredSlots: readonly string[]
  readonly missingSlots: readonly string[]
  readonly conflicts: readonly EvidenceConflictV1[]
  readonly fitness: EvidenceBundleFitnessV1
  readonly authorityGranted: false
  readonly digest: string
}

export type EvidenceBundleV1Input = {
  readonly schemaVersion: 1
  readonly asOf: number
  readonly constituents: readonly EvidenceBundleConstituentV1[]
  readonly requiredSlots: readonly string[]
  readonly conflicts: readonly EvidenceConflictV1[]
  readonly authorityGranted: false
}

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type EvidenceContractErrorCode =
  | 'INVALID_SHAPE'
  | 'UNKNOWN_SCHEMA_VERSION'
  | 'INVALID_IDENTITY'
  | 'INVALID_SOURCE'
  | 'INVALID_UNIT'
  | 'INVALID_TIME'
  | 'IMPOSSIBLE_TIMING'
  | 'INVALID_FRESHNESS_POLICY'
  | 'INVALID_COMPLETENESS'
  | 'INVALID_QUALITY_BLOCKER'
  | 'INVALID_VALUE'
  | 'AUTHORITY_REQUESTED'
  | 'INVALID_DIGEST'
  | 'DIGEST_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'FITNESS_MISMATCH'
  | 'DUPLICATE_IDENTITY'
  | 'INVALID_CONFLICT'
  | 'AMBIGUOUS_SLOT'
  | 'BUNDLE_MISMATCH'

export class EvidenceContractError extends Error {
  constructor(
    public readonly code: EvidenceContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'EvidenceContractError'
  }
}

function fail(code: EvidenceContractErrorCode, message: string): never {
  throw new EvidenceContractError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText)
  const wanted = [...expected].sort(compareCanonicalText)
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_SHAPE', `${label} must contain exactly: ${wanted.join(', ')}`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('INVALID_SHAPE', `${label} must be a plain object`)
  return value
}

function text(value: unknown, label: string, code: EvidenceContractErrorCode = 'INVALID_SHAPE'): string {
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

function nonNegativeInteger(value: unknown, label: string, code: EvidenceContractErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(code, `${label} must be a non-negative safe integer`)
  }
  return value
}

function falseAuthority(value: unknown): false {
  if (value !== false) fail('AUTHORITY_REQUESTED', 'canonical evidence grants no authority')
  return false
}

function uniqueTexts(value: unknown, label: string, code: EvidenceContractErrorCode): string[] {
  if (!Array.isArray(value)) fail(code, `${label} must be an array`)
  const items = value.map((item, index) => text(item, `${label}[${index}]`, code))
  if (new Set(items).size !== items.length) fail(code, `${label} contains duplicates`)
  return items.sort(compareCanonicalText)
}

function jsonValue(value: unknown, label = 'value'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_VALUE', `${label} contains a non-finite number`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`))
  if (!isRecord(value)) fail('INVALID_VALUE', `${label} must contain only canonical JSON values`)
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

function parseInstrument(value: unknown): EvidenceInstrumentIdentityV1 {
  const input = record(value, 'instrument')
  exactKeys(input, ['kind', 'symbol', 'instrumentId', 'network', 'address', 'venue'], 'instrument')
  const nullableText = (candidate: unknown, label: string): string | null =>
    candidate === null ? null : text(candidate, label, 'INVALID_IDENTITY')
  return {
    kind: text(input.kind, 'instrument.kind', 'INVALID_IDENTITY'),
    symbol: text(input.symbol, 'instrument.symbol', 'INVALID_IDENTITY'),
    instrumentId: text(input.instrumentId, 'instrument.instrumentId', 'INVALID_IDENTITY'),
    network: nullableText(input.network, 'instrument.network'),
    address: nullableText(input.address, 'instrument.address'),
    venue: nullableText(input.venue, 'instrument.venue'),
  }
}

/** Strict public seam for later canonical spine artifacts that reuse P2 identity. */
export function decodeEvidenceInstrumentIdentityV1(value: unknown): EvidenceInstrumentIdentityV1 {
  return deepFreeze(parseInstrument(value)) as EvidenceInstrumentIdentityV1
}

function parseSource(value: unknown): EvidenceSourceV1 {
  const input = record(value, 'source')
  exactKeys(input, ['producer', 'provider', 'recordId'], 'source')
  return {
    producer: text(input.producer, 'source.producer', 'INVALID_SOURCE'),
    provider: text(input.provider, 'source.provider', 'INVALID_SOURCE'),
    recordId: text(input.recordId, 'source.recordId', 'INVALID_SOURCE'),
  }
}

function parseUnit(value: unknown): EvidenceUnitV1 {
  const input = record(value, 'unit')
  const kind = text(input.kind, 'unit.kind', 'INVALID_UNIT')
  if (['USD', 'PERCENT', 'BASIS_POINTS', 'TIMESTAMP_MS'].includes(kind)) {
    exactKeys(input, ['kind'], 'unit')
    return { kind } as EvidenceUnitV1
  }
  if (kind === 'PRICE_RATIO') {
    exactKeys(input, ['kind', 'numerator', 'denominator'], 'unit')
    return {
      kind,
      numerator: text(input.numerator, 'unit.numerator', 'INVALID_UNIT'),
      denominator: text(input.denominator, 'unit.denominator', 'INVALID_UNIT'),
    }
  }
  if (kind === 'TOKEN_DECIMAL') {
    exactKeys(input, ['kind', 'assetId', 'decimals'], 'unit')
    return {
      kind,
      assetId: text(input.assetId, 'unit.assetId', 'INVALID_UNIT'),
      decimals: nonNegativeInteger(input.decimals, 'unit.decimals', 'INVALID_UNIT'),
    }
  }
  if (['TOKEN_RAW', 'QUANTITY'].includes(kind)) {
    exactKeys(input, ['kind', 'assetId'], 'unit')
    return { kind, assetId: text(input.assetId, 'unit.assetId', 'INVALID_UNIT') } as EvidenceUnitV1
  }
  if (kind === 'NAMED') {
    exactKeys(input, ['kind', 'name'], 'unit')
    return { kind, name: text(input.name, 'unit.name', 'INVALID_UNIT') }
  }
  return fail('INVALID_UNIT', `unit.kind ${kind} is unsupported`)
}

/** Strict public seam for later canonical spine artifacts that reuse P2 units. */
export function decodeEvidenceUnitV1(value: unknown): EvidenceUnitV1 {
  return deepFreeze(parseUnit(value)) as EvidenceUnitV1
}

function parseQualityBlockers(value: unknown): EvidenceQualityBlockerV1[] {
  if (!Array.isArray(value)) fail('INVALID_QUALITY_BLOCKER', 'qualityBlockers must be an array')
  const blockers = value.map((item, index) => {
    const blocker = record(item, `qualityBlockers[${index}]`)
    exactKeys(blocker, ['code', 'detail'], `qualityBlockers[${index}]`)
    return {
      code: text(blocker.code, `qualityBlockers[${index}].code`, 'INVALID_QUALITY_BLOCKER'),
      detail: text(blocker.detail, `qualityBlockers[${index}].detail`, 'INVALID_QUALITY_BLOCKER'),
    }
  }).sort((left, right) => compareCanonicalText(
    `${left.code}\0${left.detail}`,
    `${right.code}\0${right.detail}`,
  ))
  const keys = blockers.map((blocker) => `${blocker.code}\0${blocker.detail}`)
  if (new Set(keys).size !== keys.length) fail('INVALID_QUALITY_BLOCKER', 'qualityBlockers contains duplicates')
  return blockers
}

function snapshotFitness(
  stale: boolean,
  missing: readonly string[],
  blockers: readonly EvidenceQualityBlockerV1[],
): EvidenceFitnessV1 {
  const reasons: EvidenceFitnessReasonV1[] = []
  if (stale) reasons.push('STALE')
  if (missing.length > 0) reasons.push('MISSING_REQUIRED_EVIDENCE')
  if (blockers.length > 0) reasons.push('UNRESOLVED_QUALITY_BLOCKER')
  return reasons.length === 0
    ? { status: 'READY', reasons: [] }
    : { status: 'UNREADY', reasons }
}

function snapshotInput(value: unknown): EvidenceSnapshotV1Input {
  const input = record(value, 'snapshot input')
  exactKeys(input, [
    'schemaVersion', 'instrument', 'source', 'unit', 'eventTime', 'observedAt',
    'receivedAt', 'asOf', 'maxAgeMs', 'requiredEvidence', 'missingEvidence',
    'qualityBlockers', 'value', 'authorityGranted',
  ], 'snapshot input')
  if (input.schemaVersion !== 1) fail('UNKNOWN_SCHEMA_VERSION', 'snapshot schemaVersion must be 1')
  const eventTime = timestamp(input.eventTime, 'eventTime')
  const observedAt = timestamp(input.observedAt, 'observedAt')
  const receivedAt = timestamp(input.receivedAt, 'receivedAt')
  const asOf = timestamp(input.asOf, 'asOf')
  if (!(eventTime <= observedAt && observedAt <= receivedAt && receivedAt <= asOf)) {
    fail('IMPOSSIBLE_TIMING', 'required ordering is eventTime <= observedAt <= receivedAt <= asOf')
  }
  const requiredEvidence = uniqueTexts(input.requiredEvidence, 'requiredEvidence', 'INVALID_COMPLETENESS')
  const missingEvidence = uniqueTexts(input.missingEvidence, 'missingEvidence', 'INVALID_COMPLETENESS')
  if (missingEvidence.some((item) => !requiredEvidence.includes(item))) {
    fail('INVALID_COMPLETENESS', 'missingEvidence must name only requiredEvidence coordinates')
  }
  return {
    schemaVersion: 1,
    instrument: parseInstrument(input.instrument),
    source: parseSource(input.source),
    unit: parseUnit(input.unit),
    eventTime,
    observedAt,
    receivedAt,
    asOf,
    maxAgeMs: nonNegativeInteger(input.maxAgeMs, 'maxAgeMs', 'INVALID_FRESHNESS_POLICY'),
    requiredEvidence,
    missingEvidence,
    qualityBlockers: parseQualityBlockers(input.qualityBlockers),
    value: jsonValue(input.value),
    authorityGranted: falseAuthority(input.authorityGranted),
  }
}

/** Build one immutable, authority-free canonical evidence observation. */
export function createEvidenceSnapshotV1(value: EvidenceSnapshotV1Input | unknown): EvidenceSnapshotV1 {
  const input = snapshotInput(value)
  const ageMs = input.asOf - input.observedAt
  const freshnessState = ageMs <= input.maxAgeMs ? 'FRESH' : 'STALE'
  const evidenceId = digestCanonicalJson({
    schemaVersion: 1,
    artifact: 'EvidenceSnapshotIdentityV1',
    instrument: input.instrument,
    source: input.source,
    eventTime: input.eventTime,
  })
  const body = {
    schemaVersion: 1 as const,
    artifact: 'EvidenceSnapshotV1' as const,
    evidenceId,
    instrument: input.instrument,
    source: input.source,
    unit: input.unit,
    eventTime: input.eventTime,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt,
    asOf: input.asOf,
    freshness: {
      state: freshnessState,
      ageMs,
      maxAgeMs: input.maxAgeMs,
      basis: 'OBSERVED_AT' as const,
    },
    completeness: {
      state: input.missingEvidence.length === 0 ? 'COMPLETE' as const : 'INCOMPLETE' as const,
      requiredEvidence: input.requiredEvidence,
      missingEvidence: input.missingEvidence,
    },
    qualityBlockers: input.qualityBlockers,
    fitness: snapshotFitness(freshnessState === 'STALE', input.missingEvidence, input.qualityBlockers),
    value: input.value,
    authorityGranted: false as const,
  }
  return deepFreeze({ ...body, digest: digestCanonicalJson(body) }) as EvidenceSnapshotV1
}

function digestText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail('INVALID_DIGEST', `${label} must be a lowercase SHA-256 hex digest`)
  }
  return value
}

/** Strictly decode and re-prove identity, fitness, and digest. */
export function decodeEvidenceSnapshotV1(value: unknown): EvidenceSnapshotV1 {
  const artifact = record(value, 'snapshot')
  exactKeys(artifact, [
    'schemaVersion', 'artifact', 'evidenceId', 'instrument', 'source', 'unit',
    'eventTime', 'observedAt', 'receivedAt', 'asOf', 'freshness', 'completeness',
    'qualityBlockers', 'fitness', 'value', 'authorityGranted', 'digest',
  ], 'snapshot')
  if (artifact.schemaVersion !== 1) fail('UNKNOWN_SCHEMA_VERSION', 'snapshot schemaVersion must be 1')
  if (artifact.artifact !== 'EvidenceSnapshotV1') fail('INVALID_SHAPE', 'snapshot artifact tag is invalid')
  const freshness = record(artifact.freshness, 'freshness')
  exactKeys(freshness, ['state', 'ageMs', 'maxAgeMs', 'basis'], 'freshness')
  const completeness = record(artifact.completeness, 'completeness')
  exactKeys(completeness, ['state', 'requiredEvidence', 'missingEvidence'], 'completeness')
  const suppliedFitness = artifact.fitness
  const rebuilt = createEvidenceSnapshotV1({
    schemaVersion: 1,
    instrument: artifact.instrument,
    source: artifact.source,
    unit: artifact.unit,
    eventTime: artifact.eventTime,
    observedAt: artifact.observedAt,
    receivedAt: artifact.receivedAt,
    asOf: artifact.asOf,
    maxAgeMs: freshness.maxAgeMs,
    requiredEvidence: completeness.requiredEvidence,
    missingEvidence: completeness.missingEvidence,
    qualityBlockers: artifact.qualityBlockers,
    value: artifact.value,
    authorityGranted: artifact.authorityGranted,
  })
  digestText(artifact.evidenceId, 'evidenceId')
  digestText(artifact.digest, 'digest')
  if (artifact.evidenceId !== rebuilt.evidenceId) fail('IDENTITY_MISMATCH', 'snapshot evidenceId does not match identity coordinates')
  if (serializeCanonicalJson(suppliedFitness) !== serializeCanonicalJson(rebuilt.fitness)) {
    fail('FITNESS_MISMATCH', 'snapshot fitness does not match canonical evaluation')
  }
  if (artifact.digest !== rebuilt.digest) fail('DIGEST_MISMATCH', 'snapshot digest does not match canonical content')
  if (serializeCanonicalJson(artifact) !== serializeCanonicalJson(rebuilt)) {
    fail('FITNESS_MISMATCH', 'snapshot derived coordinates do not match canonical evaluation')
  }
  return rebuilt
}

function parseConflict(value: unknown, index: number): EvidenceConflictV1 {
  const conflict = record(value, `conflicts[${index}]`)
  exactKeys(conflict, ['slot', 'snapshotIds', 'reason'], `conflicts[${index}]`)
  const snapshotIds = uniqueTexts(conflict.snapshotIds, `conflicts[${index}].snapshotIds`, 'INVALID_CONFLICT')
  if (snapshotIds.length < 2) fail('INVALID_CONFLICT', 'a conflict must preserve at least two snapshot identities')
  for (const [idIndex, id] of snapshotIds.entries()) digestText(id, `conflicts[${index}].snapshotIds[${idIndex}]`)
  return {
    slot: text(conflict.slot, `conflicts[${index}].slot`, 'INVALID_CONFLICT'),
    snapshotIds,
    reason: text(conflict.reason, `conflicts[${index}].reason`, 'INVALID_CONFLICT'),
  }
}

function bundleFitness(
  missingSlots: readonly string[],
  unreadyRequired: boolean,
  conflicts: readonly EvidenceConflictV1[],
): EvidenceBundleFitnessV1 {
  const reasons: EvidenceBundleFitnessReasonV1[] = []
  if (missingSlots.length > 0) reasons.push('MISSING_REQUIRED_SLOT')
  if (unreadyRequired) reasons.push('UNREADY_REQUIRED_SNAPSHOT')
  if (conflicts.length > 0) reasons.push('UNRESOLVED_CONFLICT')
  return reasons.length === 0
    ? { status: 'READY', reasons: [] }
    : { status: 'UNREADY', reasons }
}

function bundleInput(value: unknown): EvidenceBundleV1Input {
  const input = record(value, 'bundle input')
  exactKeys(input, ['schemaVersion', 'asOf', 'constituents', 'requiredSlots', 'conflicts', 'authorityGranted'], 'bundle input')
  if (input.schemaVersion !== 1) fail('UNKNOWN_SCHEMA_VERSION', 'bundle schemaVersion must be 1')
  if (!Array.isArray(input.constituents)) fail('INVALID_SHAPE', 'constituents must be an array')
  const constituents = input.constituents.map((item, index) => {
    const constituent = record(item, `constituents[${index}]`)
    exactKeys(constituent, ['slot', 'snapshot'], `constituents[${index}]`)
    return {
      slot: text(constituent.slot, `constituents[${index}].slot`),
      snapshot: decodeEvidenceSnapshotV1(constituent.snapshot),
    }
  }).sort((left, right) =>
    compareCanonicalText(left.slot, right.slot) ||
    compareCanonicalText(left.snapshot.evidenceId, right.snapshot.evidenceId))
  const identities = constituents.map((item) => item.snapshot.evidenceId)
  if (new Set(identities).size !== identities.length) fail('DUPLICATE_IDENTITY', 'constituents contain a duplicate evidence identity')
  const asOf = timestamp(input.asOf, 'bundle.asOf')
  if (constituents.some((item) => item.snapshot.asOf !== asOf)) {
    fail('INVALID_TIME', 'each constituent snapshot must use the bundle asOf')
  }
  const requiredSlots = uniqueTexts(input.requiredSlots, 'requiredSlots', 'INVALID_SHAPE')
  if (!Array.isArray(input.conflicts)) fail('INVALID_CONFLICT', 'conflicts must be an array')
  const conflicts = input.conflicts.map(parseConflict)
    .sort((left, right) =>
      compareCanonicalText(left.slot, right.slot) ||
      compareCanonicalText(left.snapshotIds.join(), right.snapshotIds.join()))
  const slots = new Map<string, string[]>()
  for (const constituent of constituents) {
    const ids = slots.get(constituent.slot) ?? []
    ids.push(constituent.snapshot.evidenceId)
    slots.set(constituent.slot, ids.sort(compareCanonicalText))
  }
  const conflictedSlots = new Set<string>()
  for (const conflict of conflicts) {
    if (conflictedSlots.has(conflict.slot)) fail('INVALID_CONFLICT', `slot ${conflict.slot} has duplicate conflict declarations`)
    conflictedSlots.add(conflict.slot)
    const slotIds = slots.get(conflict.slot)
    if (slotIds === undefined || serializeCanonicalJson(slotIds) !== serializeCanonicalJson(conflict.snapshotIds)) {
      fail('INVALID_CONFLICT', `conflict ${conflict.slot} must preserve every and only constituent in that slot`)
    }
  }
  for (const [slot, ids] of slots) {
    if (ids.length > 1 && !conflictedSlots.has(slot)) {
      fail('AMBIGUOUS_SLOT', `slot ${slot} has multiple snapshots without an explicit conflict`)
    }
  }
  return {
    schemaVersion: 1,
    asOf,
    constituents,
    requiredSlots,
    conflicts,
    authorityGranted: falseAuthority(input.authorityGranted),
  }
}

/** Combine exact snapshots without selecting, averaging, or filling evidence. */
export function createEvidenceBundleV1(value: EvidenceBundleV1Input | unknown): EvidenceBundleV1 {
  const input = bundleInput(value)
  const presentSlots = new Set(input.constituents.map((item) => item.slot))
  const missingSlots = input.requiredSlots.filter((slot) => !presentSlots.has(slot))
  const unreadyRequired = input.constituents.some((item) =>
    input.requiredSlots.includes(item.slot) && item.snapshot.fitness.status !== 'READY')
  const bundleId = digestCanonicalJson({
    schemaVersion: 1,
    artifact: 'EvidenceBundleIdentityV1',
    asOf: input.asOf,
    requiredSlots: input.requiredSlots,
    constituents: input.constituents.map((item) => ({
      slot: item.slot,
      evidenceId: item.snapshot.evidenceId,
      digest: item.snapshot.digest,
    })),
  })
  const body = {
    schemaVersion: 1 as const,
    artifact: 'EvidenceBundleV1' as const,
    bundleId,
    asOf: input.asOf,
    constituents: input.constituents,
    requiredSlots: input.requiredSlots,
    missingSlots,
    conflicts: input.conflicts,
    fitness: bundleFitness(missingSlots, unreadyRequired, input.conflicts),
    authorityGranted: false as const,
  }
  return deepFreeze({ ...body, digest: digestCanonicalJson(body) }) as EvidenceBundleV1
}

/** Strictly decode and re-prove bundle membership, readiness, and digest. */
export function decodeEvidenceBundleV1(value: unknown): EvidenceBundleV1 {
  const artifact = record(value, 'bundle')
  exactKeys(artifact, [
    'schemaVersion', 'artifact', 'bundleId', 'asOf', 'constituents',
    'requiredSlots', 'missingSlots', 'conflicts', 'fitness',
    'authorityGranted', 'digest',
  ], 'bundle')
  if (artifact.schemaVersion !== 1) fail('UNKNOWN_SCHEMA_VERSION', 'bundle schemaVersion must be 1')
  if (artifact.artifact !== 'EvidenceBundleV1') fail('INVALID_SHAPE', 'bundle artifact tag is invalid')
  const rebuilt = createEvidenceBundleV1({
    schemaVersion: 1,
    asOf: artifact.asOf,
    constituents: artifact.constituents,
    requiredSlots: artifact.requiredSlots,
    conflicts: artifact.conflicts,
    authorityGranted: artifact.authorityGranted,
  })
  digestText(artifact.bundleId, 'bundleId')
  digestText(artifact.digest, 'bundle.digest')
  if (artifact.bundleId !== rebuilt.bundleId) fail('IDENTITY_MISMATCH', 'bundleId does not match canonical membership')
  if (artifact.digest !== rebuilt.digest) fail('DIGEST_MISMATCH', 'bundle digest does not match canonical content')
  if (serializeCanonicalJson(artifact) !== serializeCanonicalJson(rebuilt)) {
    fail('BUNDLE_MISMATCH', 'bundle derived coordinates do not match canonical construction')
  }
  return rebuilt
}

import type {
  ApplicabilityEvidenceFact,
  DevelopmentalMemoryApplicability,
  TradingApplicabilityScope,
} from './applicability.js'
import { assessDevelopmentalMemoryApplicability } from './applicability.js'
import type { CurrentApplicabilityEvidenceProjection } from './currentEvidence.js'
import {
  digestCanonicalJson,
  serializeCanonicalJson,
  type DevelopmentalMemoryRevision,
} from './developmentalMemory.js'

export const TEMPORAL_EVIDENCE_SCHEMA_VERSION = 1 as const
export const TEMPORAL_APPLICABILITY_ASSESSMENT_SCHEMA_VERSION = 1 as const

/** A known instant is source/caller supplied; UNKNOWN never acquires a guessed value. */
export type TemporalInstant =
  | { readonly kind: 'KNOWN'; readonly at: number }
  | { readonly kind: 'UNKNOWN' }

/**
 * Event time describes when the evidenced event occurred, if the source has
 * that fact. It is not an evaluation anchor, scheduled payload timestamp, or
 * record-creation timestamp.
 */
export type TemporalEventTime =
  | { readonly kind: 'POINT'; readonly at: number }
  | {
      readonly kind: 'INTERVAL'
      readonly startAt: number
      /** Inclusive end; null means the event remains open-ended. */
      readonly endAt: number | null
    }
  | { readonly kind: 'UNKNOWN' }

/**
 * POINT is evidence observed at one instant. It becomes temporally eligible at
 * that instant and remains a historical point thereafter; P2A freshness still
 * decides whether it is current. INTERVAL is valid on the closed range
 * [startAt, endAt]. A null end is open-ended. No TTL may be turned into one.
 */
export type TemporalValidity =
  | { readonly kind: 'POINT'; readonly at: number }
  | {
      readonly kind: 'INTERVAL'
      readonly startAt: number
      readonly endAt: number | null
    }

export interface TemporalApplicabilityEvidence {
  readonly schemaVersion: typeof TEMPORAL_EVIDENCE_SCHEMA_VERSION
  readonly applicabilityFact: ApplicabilityEvidenceFact
  readonly eventTime: TemporalEventTime
  readonly observationTime: { readonly kind: 'POINT'; readonly at: number }
  readonly receiptTime: TemporalInstant
  readonly recordingTime: TemporalInstant
  readonly validity: TemporalValidity
  /** P2B provenance is retained verbatim; retrievedAt is not recording time. */
  readonly sourceMetadata: CurrentApplicabilityEvidenceProjection['sourceMetadata']
  readonly authorityGranted: false
}

export const TEMPORAL_EVIDENCE_DISPOSITIONS = [
  'ADMISSIBLE',
  'UNAVAILABLE_AS_OF',
  'TEMPORAL_PROOF_UNAVAILABLE',
  'OUTSIDE_VALIDITY',
] as const

export type TemporalEvidenceDisposition =
  typeof TEMPORAL_EVIDENCE_DISPOSITIONS[number]

export type TemporalEvidenceReason =
  | 'EVENT_AFTER_AS_OF'
  | 'OBSERVATION_AFTER_AS_OF'
  | 'RECEIPT_AFTER_AS_OF'
  | 'RECORDING_AFTER_AS_OF'
  | 'RECEIPT_UNKNOWN'
  | 'RECORDING_UNKNOWN'
  | 'BEFORE_VALIDITY'
  | 'AFTER_VALIDITY'

export interface TemporalEvidenceAssessment {
  readonly evidence: TemporalApplicabilityEvidence
  readonly disposition: TemporalEvidenceDisposition
  readonly reasons: readonly TemporalEvidenceReason[]
  readonly availabilityAt: number | null
  readonly authorityGranted: false
}

export interface TemporalApplicabilityAsOfAssessment {
  readonly schemaVersion:
    typeof TEMPORAL_APPLICABILITY_ASSESSMENT_SCHEMA_VERSION
  readonly assessmentId: string
  /** Requested evidence cutoff and the time P2A evaluates freshness. */
  readonly asOf: number
  /** Time this P2C assessment is performed; it may be later than asOf. */
  readonly assessedAt: number
  readonly evidenceAssessments: readonly TemporalEvidenceAssessment[]
  readonly applicability: DevelopmentalMemoryApplicability
  readonly ordering: {
    readonly causal: false
    readonly rule: 'OBSERVATION_AVAILABILITY_CANONICAL_IDENTITY_INPUT_ORDER'
  }
  readonly authorityGranted: false
}

export type TemporalApplicabilityAsOfInput = {
  readonly revision: DevelopmentalMemoryRevision
  readonly latestRevisionId: string
  readonly scope: TradingApplicabilityScope | unknown
  readonly temporalEvidence: readonly TemporalApplicabilityEvidence[] | unknown
  readonly asOf: number | unknown
  readonly assessedAt: number | unknown
  readonly priorAssessment?: DevelopmentalMemoryApplicability | unknown
}

export type TemporalEvidenceErrorCode =
  | 'INVALID_AS_OF'
  | 'INVALID_ASSESSED_AT'
  | 'ASSESSMENT_BEFORE_AS_OF'
  | 'INVALID_TEMPORAL_EVIDENCE'
  | 'INCONSISTENT_P2B_PROJECTION'
  | 'IMPOSSIBLE_CHRONOLOGY'
  | 'AUTHORITY_REQUESTED'
  | 'UNSAFE_PRIOR_ASSESSMENT'

export class TemporalEvidenceError extends Error {
  constructor(
    public readonly code: TemporalEvidenceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'TemporalEvidenceError'
  }
}

function fail(code: TemporalEvidenceErrorCode, message: string): never {
  throw new TemporalEvidenceError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function validInstant(value: unknown): value is TemporalInstant {
  if (!isRecord(value)) return false
  if (value.kind === 'UNKNOWN') return hasExactKeys(value, ['kind'])
  return value.kind === 'KNOWN' &&
    hasExactKeys(value, ['kind', 'at']) &&
    isTimestamp(value.at)
}

function validEventTime(value: unknown): value is TemporalEventTime {
  if (!isRecord(value)) return false
  if (value.kind === 'UNKNOWN') return hasExactKeys(value, ['kind'])
  if (value.kind === 'POINT') {
    return hasExactKeys(value, ['kind', 'at']) && isTimestamp(value.at)
  }
  if (value.kind !== 'INTERVAL' || !hasExactKeys(value, [
    'kind', 'startAt', 'endAt',
  ])) return false
  return isTimestamp(value.startAt) &&
    (value.endAt === null || isTimestamp(value.endAt)) &&
    (value.endAt === null || value.startAt <= value.endAt)
}

function validValidity(value: unknown): value is TemporalValidity {
  if (!isRecord(value)) return false
  if (value.kind === 'POINT') {
    return hasExactKeys(value, ['kind', 'at']) && isTimestamp(value.at)
  }
  if (value.kind !== 'INTERVAL' || !hasExactKeys(value, [
    'kind', 'startAt', 'endAt',
  ])) return false
  return isTimestamp(value.startAt) &&
    (value.endAt === null || isTimestamp(value.endAt)) &&
    (value.endAt === null || value.startAt <= value.endAt)
}

function knownAt(value: TemporalInstant): number | null {
  return value.kind === 'KNOWN' ? value.at : null
}

function eventStart(value: TemporalEventTime): number | null {
  if (value.kind === 'UNKNOWN') return null
  return value.kind === 'POINT' ? value.at : value.startAt
}

function eventEnd(value: TemporalEventTime): number | null {
  if (value.kind === 'UNKNOWN') return null
  return value.kind === 'POINT' ? value.at : value.endAt
}

function validityContainsObservation(
  validity: TemporalValidity,
  observedAt: number,
): boolean {
  if (validity.kind === 'POINT') return validity.at === observedAt
  return validity.startAt <= observedAt &&
    (validity.endAt === null || observedAt <= validity.endAt)
}

function validSourceMetadata(
  value: Record<string, unknown>,
  applicabilityFact: Record<string, unknown>,
  observedAt: number,
): boolean {
  if (!hasExactKeys(value, [
    'canonicalReference',
    'observationTimeSource',
    'receivedAt',
    'retrievedAt',
    'marketProvenance',
    'signalProvenance',
    'sourceFreshness',
  ])) return false

  const factReference = applicabilityFact.evidenceReference
  const market = value.marketProvenance
  const signal = value.signalProvenance
  const freshness = value.sourceFreshness
  if (
    !isRecord(factReference) ||
    !isRecord(value.canonicalReference) ||
    serializeCanonicalJson(value.canonicalReference) !==
      serializeCanonicalJson(factReference) ||
    (value.observationTimeSource !== 'PROVIDER' &&
      value.observationTimeSource !== 'RECEIPT') ||
    !isTimestamp(value.receivedAt) ||
    !isTimestamp(value.retrievedAt) ||
    !isRecord(market) ||
    !isRecord(signal) ||
    !isRecord(freshness)
  ) return false

  const marketKeys = [
    'provider', 'endpoint', 'supportingEndpoints', 'requestType',
  ] as const
  if (
    !hasOnlyKeys(market, marketKeys) ||
    !hasText(market.provider) ||
    !isUrl(market.endpoint) ||
    market.requestType !== 'MARKET_SNAPSHOT' ||
    ('supportingEndpoints' in market && (
      !Array.isArray(market.supportingEndpoints) ||
      market.supportingEndpoints.length === 0 ||
      !market.supportingEndpoints.every(isUrl)
    ))
  ) return false
  if (
    !hasExactKeys(signal, ['provider', 'taSource']) ||
    !hasText(signal.provider) ||
    !hasText(signal.taSource)
  ) return false
  if (
    !hasExactKeys(freshness, ['state', 'ageMs', 'maxAgeMs']) ||
    (freshness.state !== 'FRESH' && freshness.state !== 'STALE') ||
    !isTimestamp(freshness.ageMs) ||
    !isTimestamp(freshness.maxAgeMs) ||
    freshness.maxAgeMs === 0 ||
    freshness.maxAgeMs !== applicabilityFact.maxAgeMs ||
    freshness.ageMs !== value.retrievedAt - observedAt ||
    freshness.state !== (
      freshness.ageMs <= freshness.maxAgeMs ? 'FRESH' : 'STALE'
    )
  ) return false
  return value.receivedAt >= observedAt &&
    value.retrievedAt >= observedAt &&
    (value.observationTimeSource !== 'RECEIPT' ||
      value.receivedAt === observedAt)
}

function validateTemporalEvidenceShape(
  value: unknown,
): TemporalApplicabilityEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'applicabilityFact',
      'eventTime',
      'observationTime',
      'receiptTime',
      'recordingTime',
      'validity',
      'sourceMetadata',
      'authorityGranted',
    ]) ||
    value.schemaVersion !== TEMPORAL_EVIDENCE_SCHEMA_VERSION
  ) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'temporal evidence envelope is malformed')
  }
  if (value.authorityGranted !== false) {
    return fail('AUTHORITY_REQUESTED', 'temporal evidence cannot grant authority')
  }
  if (!isRecord(value.applicabilityFact)) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'applicability fact is unavailable')
  }
  if (value.applicabilityFact.authorityGranted !== false) {
    return fail('AUTHORITY_REQUESTED', 'applicability evidence cannot grant authority')
  }
  const observedAt = value.applicabilityFact.observedAt
  if (!isTimestamp(observedAt)) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'observation timestamp is malformed')
  }
  if (
    !isRecord(value.observationTime) ||
    !hasExactKeys(value.observationTime, ['kind', 'at']) ||
    value.observationTime.kind !== 'POINT' ||
    !isTimestamp(value.observationTime.at) ||
    value.observationTime.at !== observedAt
  ) {
    return fail(
      'INVALID_TEMPORAL_EVIDENCE',
      'observation point must equal the P2A evidence observation',
    )
  }
  if (!validInstant(value.receiptTime) || !validInstant(value.recordingTime)) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'receipt or recording time is malformed')
  }
  if (!validEventTime(value.eventTime) || !validValidity(value.validity)) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'event time or validity is malformed')
  }
  if (!isRecord(value.sourceMetadata)) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'source metadata is unavailable')
  }

  const metadata = value.sourceMetadata
  if (!validSourceMetadata(metadata, value.applicabilityFact, observedAt)) {
    return fail(
      'INVALID_TEMPORAL_EVIDENCE',
      'retained P2B source metadata is malformed or inconsistent',
    )
  }

  const receiptAt = knownAt(value.receiptTime)
  const recordingAt = knownAt(value.recordingTime)
  const earliestEventAt = eventStart(value.eventTime)
  const latestEventAt = eventEnd(value.eventTime)
  if (receiptAt !== null && receiptAt !== metadata.receivedAt) {
    return fail(
      'IMPOSSIBLE_CHRONOLOGY',
      'receipt time must match retained P2B source metadata',
    )
  }
  if (receiptAt !== null && receiptAt < observedAt) {
    return fail('IMPOSSIBLE_CHRONOLOGY', 'receipt cannot precede observation')
  }
  if (
    recordingAt !== null &&
    (recordingAt < observedAt || (receiptAt !== null && recordingAt < receiptAt))
  ) {
    return fail(
      'IMPOSSIBLE_CHRONOLOGY',
      'recording cannot precede observation or known receipt',
    )
  }
  if (earliestEventAt !== null && receiptAt !== null && earliestEventAt > receiptAt) {
    return fail('IMPOSSIBLE_CHRONOLOGY', 'evidenced event cannot begin after receipt')
  }
  if (latestEventAt !== null && receiptAt !== null && latestEventAt > receiptAt) {
    return fail('IMPOSSIBLE_CHRONOLOGY', 'closed evidenced event cannot end after receipt')
  }
  if (!validityContainsObservation(value.validity, observedAt)) {
    return fail(
      'IMPOSSIBLE_CHRONOLOGY',
      'observation must fall within the declared validity shape',
    )
  }
  return value as unknown as TemporalApplicabilityEvidence
}

function validateProjection(
  projection: CurrentApplicabilityEvidenceProjection,
): void {
  const fact = projection.applicabilityFact
  const metadata = projection.sourceMetadata
  if (
    projection.schemaVersion !== 1 ||
    projection.authorityGranted !== false ||
    fact.authorityGranted !== false ||
    !isTimestamp(fact.observedAt) ||
    !isRecord(fact) ||
    !isRecord(metadata) ||
    !validSourceMetadata(metadata, fact, fact.observedAt)
  ) {
    return fail(
      'INCONSISTENT_P2B_PROJECTION',
      'P2B projection identity, timing, freshness, or authority is inconsistent',
    )
  }
}

/**
 * Adapt P2B without inventing time. recordingTime is mandatory and explicit:
 * pass UNKNOWN unless a caller has an independently supported durable-recording
 * observation. P2B createdAt and retrievedAt are deliberately not substitutes.
 */
export function temporalizeCurrentApplicabilityEvidence(
  projection: CurrentApplicabilityEvidenceProjection,
  recordingTime: TemporalInstant | unknown,
): Readonly<TemporalApplicabilityEvidence> {
  validateProjection(projection)
  if (!validInstant(recordingTime)) {
    return fail(
      'INVALID_TEMPORAL_EVIDENCE',
      'recording time must be explicit KNOWN or UNKNOWN',
    )
  }

  const observedAt = projection.applicabilityFact.observedAt
  const envelope: TemporalApplicabilityEvidence = {
    schemaVersion: TEMPORAL_EVIDENCE_SCHEMA_VERSION,
    applicabilityFact: clone(projection.applicabilityFact),
    eventTime: { kind: 'UNKNOWN' },
    observationTime: { kind: 'POINT', at: observedAt },
    receiptTime: { kind: 'KNOWN', at: projection.sourceMetadata.receivedAt },
    recordingTime: clone(recordingTime),
    validity: { kind: 'POINT', at: observedAt },
    sourceMetadata: clone(projection.sourceMetadata),
    authorityGranted: false,
  }
  validateTemporalEvidenceShape(envelope)
  return deepFreeze(envelope)
}

function temporalAssessment(
  evidence: TemporalApplicabilityEvidence,
  asOf: number,
): TemporalEvidenceAssessment {
  const reasons: TemporalEvidenceReason[] = []
  const start = eventStart(evidence.eventTime)
  const end = eventEnd(evidence.eventTime)
  if ((start !== null && start > asOf) || (end !== null && end > asOf)) {
    reasons.push('EVENT_AFTER_AS_OF')
  }
  if (evidence.observationTime.at > asOf) reasons.push('OBSERVATION_AFTER_AS_OF')

  const receiptAt = knownAt(evidence.receiptTime)
  const recordingAt = knownAt(evidence.recordingTime)
  if (receiptAt === null) reasons.push('RECEIPT_UNKNOWN')
  else if (receiptAt > asOf) reasons.push('RECEIPT_AFTER_AS_OF')
  if (recordingAt === null) reasons.push('RECORDING_UNKNOWN')
  else if (recordingAt > asOf) reasons.push('RECORDING_AFTER_AS_OF')

  if (evidence.validity.kind === 'POINT') {
    if (asOf < evidence.validity.at) reasons.push('BEFORE_VALIDITY')
  } else {
    if (asOf < evidence.validity.startAt) reasons.push('BEFORE_VALIDITY')
    if (evidence.validity.endAt !== null && asOf > evidence.validity.endAt) {
      reasons.push('AFTER_VALIDITY')
    }
  }

  const proofUnavailable = reasons.some((reason) =>
    reason === 'RECEIPT_UNKNOWN' || reason === 'RECORDING_UNKNOWN')
  const unavailable = reasons.some((reason) =>
    reason === 'EVENT_AFTER_AS_OF' ||
    reason === 'OBSERVATION_AFTER_AS_OF' ||
    reason === 'RECEIPT_AFTER_AS_OF' ||
    reason === 'RECORDING_AFTER_AS_OF')
  const outsideValidity = reasons.some((reason) =>
    reason === 'BEFORE_VALIDITY' || reason === 'AFTER_VALIDITY')
  const disposition: TemporalEvidenceDisposition = proofUnavailable
    ? 'TEMPORAL_PROOF_UNAVAILABLE'
    : unavailable
      ? 'UNAVAILABLE_AS_OF'
      : outsideValidity
        ? 'OUTSIDE_VALIDITY'
        : 'ADMISSIBLE'

  return {
    evidence,
    disposition,
    reasons,
    availabilityAt: receiptAt === null || recordingAt === null
      ? null
      : Math.max(receiptAt, recordingAt),
    authorityGranted: false,
  }
}

function compareAssessments(
  left: TemporalEvidenceAssessment & { inputIndex: number },
  right: TemporalEvidenceAssessment & { inputIndex: number },
): number {
  const leftFact = left.evidence.applicabilityFact
  const rightFact = right.evidence.applicabilityFact
  return numberCompare(
    left.evidence.observationTime.at,
    right.evidence.observationTime.at,
  ) || numberCompare(
    left.availabilityAt ?? Number.MAX_SAFE_INTEGER,
    right.availabilityAt ?? Number.MAX_SAFE_INTEGER,
  ) || ordinalCompare(
    leftFact.evidenceReference.source,
    rightFact.evidenceReference.source,
  ) || ordinalCompare(
    leftFact.evidenceReference.recordId,
    rightFact.evidenceReference.recordId,
  ) || ordinalCompare(
    leftFact.evidenceReference.cycleId,
    rightFact.evidenceReference.cycleId,
  ) || ordinalCompare(
    leftFact.evidenceReference.contentDigestSha256,
    rightFact.evidenceReference.contentDigestSha256,
  ) ||
    left.inputIndex - right.inputIndex
}

function numberCompare(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Explicit UTF-16 code-unit ordering; independent of host locale/ICU data. */
function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function reprovePriorAssessment(
  priorValue: unknown,
  evidence: readonly TemporalApplicabilityEvidence[],
  revision: DevelopmentalMemoryRevision,
  scope: TradingApplicabilityScope,
  asOf: number,
): DevelopmentalMemoryApplicability {
  if (!isRecord(priorValue) || !isTimestamp(priorValue.assessedAt)) {
    return fail(
      'UNSAFE_PRIOR_ASSESSMENT',
      'prior assessment is malformed or lacks a valid cutoff',
    )
  }
  if (priorValue.assessedAt > asOf) {
    return fail(
      'UNSAFE_PRIOR_ASSESSMENT',
      'prior assessment cutoff cannot be later than current asOf',
    )
  }
  if (!Array.isArray(priorValue.evidenceFacts)) {
    return fail(
      'UNSAFE_PRIOR_ASSESSMENT',
      'prior assessment evidence facts are unavailable',
    )
  }

  const availableMatches = evidence.map((item, index) => ({ item, index }))
  const matched: TemporalApplicabilityEvidence[] = []
  for (const priorFact of priorValue.evidenceFacts) {
    const identity = serializeCanonicalJson(priorFact)
    const matchIndex = availableMatches.findIndex(({ item }) =>
      serializeCanonicalJson(item.applicabilityFact) === identity)
    if (matchIndex < 0) {
      return fail(
        'UNSAFE_PRIOR_ASSESSMENT',
        'prior evidence fact has no exact temporal envelope in the current input',
      )
    }
    matched.push(availableMatches[matchIndex]!.item)
    availableMatches.splice(matchIndex, 1)
  }

  for (const item of matched) {
    if (temporalAssessment(item, priorValue.assessedAt).disposition !== 'ADMISSIBLE') {
      return fail(
        'UNSAFE_PRIOR_ASSESSMENT',
        'prior evidence was not temporally admissible at the prior cutoff',
      )
    }
  }

  let recomputed: DevelopmentalMemoryApplicability
  try {
    recomputed = assessDevelopmentalMemoryApplicability({
      revision,
      latestRevisionId: revision.revisionId,
      scope,
      evidenceFacts: priorValue.evidenceFacts,
      assessedAt: priorValue.assessedAt,
    })
  } catch {
    return fail(
      'UNSAFE_PRIOR_ASSESSMENT',
      'prior assessment cannot be independently reconstructed',
    )
  }
  if (serializeCanonicalJson(recomputed) !== serializeCanonicalJson(priorValue)) {
    return fail(
      'UNSAFE_PRIOR_ASSESSMENT',
      'prior assessment chronology or identity does not match independent reconstruction',
    )
  }
  return priorValue as unknown as DevelopmentalMemoryApplicability
}

/**
 * Assess applicability using only evidence knowable at the explicit cutoff.
 * assessedAt records when this computation happens; it never widens asOf.
 */
export function assessDevelopmentalMemoryApplicabilityAsOf(
  input: TemporalApplicabilityAsOfInput | unknown,
): Readonly<TemporalApplicabilityAsOfAssessment> {
  if (!isRecord(input)) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'assessment input must be an object')
  }
  if (!('asOf' in input) || !isTimestamp(input.asOf)) {
    return fail('INVALID_AS_OF', 'asOf must be an explicit non-negative safe integer')
  }
  if (!('assessedAt' in input) || !isTimestamp(input.assessedAt)) {
    return fail(
      'INVALID_ASSESSED_AT',
      'assessedAt must be an explicit non-negative safe integer',
    )
  }
  if (input.assessedAt < input.asOf) {
    return fail('ASSESSMENT_BEFORE_AS_OF', 'assessedAt cannot precede asOf')
  }
  if (!Array.isArray(input.temporalEvidence)) {
    return fail('INVALID_TEMPORAL_EVIDENCE', 'temporalEvidence must be an array')
  }

  const evidence = input.temporalEvidence.map((item) =>
    clone(validateTemporalEvidenceShape(item)))
  const revision = input.revision as DevelopmentalMemoryRevision
  const latestRevisionId = input.latestRevisionId as string
  const scope = input.scope as TradingApplicabilityScope
  const priorAssessment = input.priorAssessment === undefined
    ? undefined
    : reprovePriorAssessment(
        input.priorAssessment,
        evidence,
        revision,
        scope,
        input.asOf,
      )

  // Reuse P2A's complete runtime validation for every fact, including facts
  // that P2C will exclude. This probe has no I/O and its result is discarded.
  const validationAt = evidence.reduce(
    (latest, item) => Math.max(latest, item.applicabilityFact.observedAt),
    input.asOf,
  )
  assessDevelopmentalMemoryApplicability({
    revision,
    latestRevisionId,
    scope,
    evidenceFacts: evidence.map((item) => item.applicabilityFact),
    assessedAt: validationAt,
  })

  const ordered = evidence
    .map((item, inputIndex) => ({
      ...temporalAssessment(item, input.asOf as number),
      inputIndex,
    }))
    .sort(compareAssessments)
  const admittedFacts = ordered
    .filter((item) => item.disposition === 'ADMISSIBLE')
    .map((item) => item.evidence.applicabilityFact)

  const applicability = assessDevelopmentalMemoryApplicability({
    revision,
    latestRevisionId,
    scope,
    evidenceFacts: admittedFacts,
    assessedAt: input.asOf,
    ...(priorAssessment === undefined ? {} : { priorAssessment }),
  })
  const evidenceAssessments = ordered.map(({ inputIndex: _inputIndex, ...item }) => item)
  const committed = {
    schemaVersion: TEMPORAL_APPLICABILITY_ASSESSMENT_SCHEMA_VERSION,
    asOf: input.asOf,
    assessedAt: input.assessedAt,
    evidenceAssessments,
    applicability,
    ordering: {
      causal: false as const,
      rule: 'OBSERVATION_AVAILABILITY_CANONICAL_IDENTITY_INPUT_ORDER' as const,
    },
    authorityGranted: false as const,
  }
  return deepFreeze({
    ...committed,
    assessmentId: digestCanonicalJson(committed),
  }) as Readonly<TemporalApplicabilityAsOfAssessment>
}

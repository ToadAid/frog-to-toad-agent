import {
  CANONICAL_TRADING_EVIDENCE_SOURCES,
  digestCanonicalJson,
  isValidDevelopmentalMemoryRevision,
  serializeCanonicalJson,
  type CanonicalTradingEvidenceRecord,
  type DevelopmentalMemoryRevision,
} from './developmentalMemory.js'

export const DEVELOPMENTAL_MEMORY_APPLICABILITY_SCHEMA_VERSION = 1 as const

export const APPLICABILITY_STATUSES = [
  'UNKNOWN',
  'ACTIVE',
  'STALE',
  'CONTESTED',
  'SUPERSEDED',
] as const

export type ApplicabilityStatus = typeof APPLICABILITY_STATUSES[number]

export type TradingApplicabilityDirection =
  | {
      readonly domain: 'SPOT_SIGNAL'
      readonly value: 'BUY' | 'SELL' | 'HOLD'
    }
  | {
      readonly domain: 'PERP_DIRECTION'
      readonly value: 'LONG' | 'SHORT' | 'FLAT'
    }

/**
 * P2A context is intentionally sparse and exact. String fields, including
 * regimes, are opaque labels: classification and canonicalization belong to
 * a future evidence adapter, not this contract.
 */
export interface TradingApplicabilityScope {
  readonly instrument?: string
  readonly timeframe?: string
  readonly setup?: string
  readonly direction?: TradingApplicabilityDirection
  readonly venue?: string
  readonly chain?: string
  readonly volatilityRegime?: string
  readonly trendRegime?: string
  readonly liquidityRegime?: string
  readonly fundingRegime?: string
}

/**
 * A future adapter may construct these envelopes from current market senses.
 * P2A performs no I/O and does not prove that adapter binding yet.
 */
export interface ApplicabilityEvidenceFact {
  readonly evidenceReference: CanonicalTradingEvidenceRecord
  readonly observedAt: number
  readonly maxAgeMs: number
  readonly context: TradingApplicabilityScope
  readonly authorityGranted: false
}

export interface DevelopmentalMemoryApplicability {
  readonly schemaVersion:
    typeof DEVELOPMENTAL_MEMORY_APPLICABILITY_SCHEMA_VERSION
  readonly assessmentId: string
  readonly memoryId: string
  readonly revisionId: string
  readonly scope: TradingApplicabilityScope
  readonly status: ApplicabilityStatus
  readonly assessedAt: number
  readonly firstObservedAt: number | null
  readonly lastConfirmedAt: number | null
  readonly evidenceFacts: readonly ApplicabilityEvidenceFact[]
  readonly authorityGranted: false
}

export type ApplicabilityAssessmentInput = {
  readonly revision: DevelopmentalMemoryRevision
  readonly latestRevisionId: string
  readonly scope: TradingApplicabilityScope | unknown
  readonly evidenceFacts: readonly ApplicabilityEvidenceFact[] | unknown
  readonly assessedAt: number
  readonly priorAssessment?: DevelopmentalMemoryApplicability | unknown
}

export type ApplicabilityAssessmentErrorCode =
  | 'INVALID_REVISION'
  | 'INVALID_LATEST_REVISION_ID'
  | 'INVALID_SCOPE'
  | 'INVALID_EVIDENCE_FACT'
  | 'AUTHORITY_REQUESTED'
  | 'INVALID_ASSESSED_AT'
  | 'FUTURE_EVIDENCE'
  | 'INVALID_PRIOR_ASSESSMENT'
  | 'PRIOR_ASSESSMENT_MISMATCH'
  | 'ASSESSMENT_TIME_REVERSED'

export class ApplicabilityAssessmentError extends Error {
  constructor(
    public readonly code: ApplicabilityAssessmentErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ApplicabilityAssessmentError'
  }
}

const SCOPE_KEYS = [
  'instrument',
  'timeframe',
  'setup',
  'direction',
  'venue',
  'chain',
  'volatilityRegime',
  'trendRegime',
  'liquidityRegime',
  'fundingRegime',
] as const

type ScopeKey = typeof SCOPE_KEYS[number]

const TEXT_SCOPE_KEYS = SCOPE_KEYS.filter(
  (key): key is Exclude<ScopeKey, 'direction'> => key !== 'direction',
)
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const EVIDENCE_SOURCES = new Set<string>(CANONICAL_TRADING_EVIDENCE_SOURCES)
const STATUSES = new Set<string>(APPLICABILITY_STATUSES)

function fail(
  code: ApplicabilityAssessmentErrorCode,
  message: string,
): never {
  throw new ApplicabilityAssessmentError(code, message)
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

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function validDirection(value: unknown): value is TradingApplicabilityDirection {
  if (!isRecord(value) || !hasExactKeys(value, ['domain', 'value'])) {
    return false
  }
  return (
    value.domain === 'SPOT_SIGNAL' &&
    (value.value === 'BUY' || value.value === 'SELL' || value.value === 'HOLD')
  ) || (
    value.domain === 'PERP_DIRECTION' &&
    (value.value === 'LONG' || value.value === 'SHORT' || value.value === 'FLAT')
  )
}

function validScope(
  value: unknown,
  allowEmpty: boolean,
): value is TradingApplicabilityScope {
  if (!isRecord(value) || !hasOnlyKeys(value, SCOPE_KEYS)) return false
  if (!allowEmpty && Object.keys(value).length === 0) return false
  for (const key of TEXT_SCOPE_KEYS) {
    if (key in value && !hasText(value[key])) return false
  }
  return !('direction' in value) || validDirection(value.direction)
}

function validEvidenceReference(
  value: unknown,
): value is CanonicalTradingEvidenceRecord {
  return isRecord(value) &&
    hasExactKeys(value, [
      'source',
      'recordId',
      'cycleId',
      'contentDigestSha256',
    ]) &&
    typeof value.source === 'string' &&
    EVIDENCE_SOURCES.has(value.source) &&
    hasText(value.recordId) &&
    hasText(value.cycleId) &&
    typeof value.contentDigestSha256 === 'string' &&
    SHA256_PATTERN.test(value.contentDigestSha256)
}

function validEvidenceFact(
  value: unknown,
): value is ApplicabilityEvidenceFact {
  return isRecord(value) &&
    hasExactKeys(value, [
      'evidenceReference',
      'observedAt',
      'maxAgeMs',
      'context',
      'authorityGranted',
    ]) &&
    validEvidenceReference(value.evidenceReference) &&
    isNonNegativeInteger(value.observedAt) &&
    isPositiveInteger(value.maxAgeMs) &&
    validScope(value.context, true) &&
    value.authorityGranted === false
}

function assessmentCommitment(
  assessment: Omit<DevelopmentalMemoryApplicability, 'assessmentId'>,
): string {
  return digestCanonicalJson(assessment)
}

function validChronology(
  firstObservedAt: unknown,
  lastConfirmedAt: unknown,
  assessedAt: number,
): boolean {
  if (firstObservedAt === null || lastConfirmedAt === null) {
    return firstObservedAt === null && lastConfirmedAt === null
  }
  return isNonNegativeInteger(firstObservedAt) &&
    isNonNegativeInteger(lastConfirmedAt) &&
    firstObservedAt <= lastConfirmedAt &&
    lastConfirmedAt <= assessedAt
}

function validPriorAssessment(
  value: unknown,
): value is DevelopmentalMemoryApplicability {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'assessmentId',
      'memoryId',
      'revisionId',
      'scope',
      'status',
      'assessedAt',
      'firstObservedAt',
      'lastConfirmedAt',
      'evidenceFacts',
      'authorityGranted',
    ]) ||
    value.schemaVersion !== DEVELOPMENTAL_MEMORY_APPLICABILITY_SCHEMA_VERSION ||
    typeof value.assessmentId !== 'string' ||
    !SHA256_PATTERN.test(value.assessmentId) ||
    !hasText(value.memoryId) ||
    typeof value.revisionId !== 'string' ||
    !SHA256_PATTERN.test(value.revisionId) ||
    !validScope(value.scope, false) ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status) ||
    !isNonNegativeInteger(value.assessedAt) ||
    !validChronology(
      value.firstObservedAt,
      value.lastConfirmedAt,
      value.assessedAt as number,
    ) ||
    !Array.isArray(value.evidenceFacts) ||
    !value.evidenceFacts.every(validEvidenceFact) ||
    value.evidenceFacts.some(
      (fact) => fact.observedAt > (value.assessedAt as number),
    ) ||
    value.authorityGranted !== false
  ) {
    return false
  }

  if (
    value.status === 'ACTIVE' &&
    (value.firstObservedAt === null || value.lastConfirmedAt === null)
  ) {
    return false
  }

  const prior = value as unknown as DevelopmentalMemoryApplicability
  const { assessmentId, ...committed } = prior
  return assessmentCommitment(committed) === assessmentId
}

/** Reuse the complete P2A scope law without exposing its implementation. */
export function validateTradingApplicabilityScope(
  value: unknown,
): Readonly<TradingApplicabilityScope> {
  if (!validScope(value, false)) {
    throw new TypeError('invalid trading applicability scope')
  }
  return deepFreeze(clone(value)) as Readonly<TradingApplicabilityScope>
}

/** Reuse the complete P2A assessment law for supplied read-only projections. */
export function validateDevelopmentalMemoryApplicability(
  value: unknown,
): Readonly<DevelopmentalMemoryApplicability> {
  if (!validPriorAssessment(value)) {
    throw new TypeError('invalid developmental memory applicability assessment')
  }
  return deepFreeze(clone(value)) as Readonly<DevelopmentalMemoryApplicability>
}

function scopeValue(scope: TradingApplicabilityScope, key: ScopeKey): unknown {
  return scope[key]
}

function exactValueEqual(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right)
}

function makeAssessment(
  fields: Omit<
    DevelopmentalMemoryApplicability,
    'schemaVersion' | 'assessmentId' | 'authorityGranted'
  >,
): Readonly<DevelopmentalMemoryApplicability> {
  const committed = {
    schemaVersion: DEVELOPMENTAL_MEMORY_APPLICABILITY_SCHEMA_VERSION,
    ...fields,
    authorityGranted: false as const,
  }
  return deepFreeze({
    ...committed,
    assessmentId: assessmentCommitment(committed),
  }) as Readonly<DevelopmentalMemoryApplicability>
}

/**
 * Pure P2A assessment. ACTIVE says only that fresh evidence exactly matches
 * every declared scope field. It never authorizes trading or changes P1.
 */
export function assessDevelopmentalMemoryApplicability(
  input: ApplicabilityAssessmentInput,
): Readonly<DevelopmentalMemoryApplicability> {
  if (!isValidDevelopmentalMemoryRevision(input.revision)) {
    return fail('INVALID_REVISION', 'revision does not satisfy the P1 revision law')
  }
  if (
    typeof input.latestRevisionId !== 'string' ||
    !SHA256_PATTERN.test(input.latestRevisionId)
  ) {
    return fail('INVALID_LATEST_REVISION_ID', 'latest revision id must be SHA-256')
  }
  if (!validScope(input.scope, false)) {
    return fail('INVALID_SCOPE', 'scope must be non-empty and contain only valid P2A fields')
  }
  if (!isNonNegativeInteger(input.assessedAt)) {
    return fail('INVALID_ASSESSED_AT', 'assessedAt must be a non-negative safe integer')
  }
  if (!Array.isArray(input.evidenceFacts)) {
    return fail('INVALID_EVIDENCE_FACT', 'evidenceFacts must be an array')
  }
  for (const fact of input.evidenceFacts) {
    if (isRecord(fact) && fact.authorityGranted !== false) {
      return fail('AUTHORITY_REQUESTED', 'evidence facts cannot request authority')
    }
    if (!validEvidenceFact(fact)) {
      return fail('INVALID_EVIDENCE_FACT', 'evidence fact is malformed')
    }
    if (fact.observedAt > input.assessedAt) {
      return fail('FUTURE_EVIDENCE', 'assessedAt cannot precede observedAt')
    }
  }

  let prior: DevelopmentalMemoryApplicability | undefined
  if (input.priorAssessment !== undefined) {
    if (isRecord(input.priorAssessment) && input.priorAssessment.authorityGranted !== false) {
      return fail('AUTHORITY_REQUESTED', 'prior assessment cannot grant authority')
    }
    if (!validPriorAssessment(input.priorAssessment)) {
      return fail('INVALID_PRIOR_ASSESSMENT', 'prior assessment is malformed or its commitment is invalid')
    }
    if (
      input.priorAssessment.memoryId !== input.revision.memoryId ||
      input.priorAssessment.revisionId !== input.revision.revisionId ||
      serializeCanonicalJson(input.priorAssessment.scope) !==
        serializeCanonicalJson(input.scope)
    ) {
      return fail(
        'PRIOR_ASSESSMENT_MISMATCH',
        'prior assessment must match memory, revision, and exact scope',
      )
    }
    if (input.assessedAt < input.priorAssessment.assessedAt) {
      return fail(
        'ASSESSMENT_TIME_REVERSED',
        'assessedAt cannot precede the prior assessment time',
      )
    }
    prior = input.priorAssessment
  }

  const scope = clone(input.scope)
  const evidenceFacts = clone(input.evidenceFacts)
  const priorFirst = prior?.firstObservedAt ?? null
  const priorLast = prior?.lastConfirmedAt ?? null
  const base = {
    memoryId: input.revision.memoryId,
    revisionId: input.revision.revisionId,
    scope,
    assessedAt: input.assessedAt,
    evidenceFacts,
  }

  if (input.revision.revisionId !== input.latestRevisionId) {
    return makeAssessment({
      ...base,
      status: 'SUPERSEDED',
      firstObservedAt: priorFirst,
      lastConfirmedAt: priorLast,
    })
  }

  const fresh = evidenceFacts.filter(
    (fact) => input.assessedAt - fact.observedAt <= fact.maxAgeMs,
  )
  const requiredKeys = SCOPE_KEYS.filter((key) => key in scope)
  let insufficient = false
  let contested = false

  for (const key of requiredKeys) {
    const assertions = fresh
      .filter((fact) => key in fact.context)
      .map((fact) => scopeValue(fact.context, key))
    if (assertions.length === 0) insufficient = true
    if (assertions.some((value) => !exactValueEqual(value, scopeValue(scope, key)))) {
      contested = true
    }
  }

  if (contested) {
    return makeAssessment({
      ...base,
      status: 'CONTESTED',
      firstObservedAt: priorFirst,
      lastConfirmedAt: priorLast,
    })
  }

  if (!insufficient) {
    const qualifyingObservedAt = fresh
      .filter((fact) => requiredKeys.some((key) => key in fact.context))
      .map((fact) => fact.observedAt)
    const currentFirst = Math.min(...qualifyingObservedAt)
    const currentLast = Math.max(...qualifyingObservedAt)
    return makeAssessment({
      ...base,
      status: 'ACTIVE',
      firstObservedAt: priorFirst === null
        ? currentFirst
        : priorFirst,
      lastConfirmedAt: priorLast === null
        ? currentLast
        : Math.max(priorLast, currentLast),
    })
  }

  if (priorFirst !== null && priorLast !== null) {
    return makeAssessment({
      ...base,
      status: 'STALE',
      firstObservedAt: priorFirst,
      lastConfirmedAt: priorLast,
    })
  }

  return makeAssessment({
    ...base,
    status: 'UNKNOWN',
    firstObservedAt: null,
    lastConfirmedAt: null,
  })
}

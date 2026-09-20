import {
  DEVELOPMENTAL_MEMORY_KINDS,
  DEVELOPMENTAL_MEMORY_MATURITIES,
  digestCanonicalJson,
  projectDevelopmentalMemories,
  serializeCanonicalJson,
  validateDevelopmentalMemoryStore,
  type CanonicalTradingEvidenceSource,
  type DevelopmentalMemoryKind,
  type DevelopmentalMemoryMaturity,
  type DevelopmentalMemoryStore,
} from './developmentalMemory.js'
import {
  APPLICABILITY_STATUSES,
  validateDevelopmentalMemoryApplicability,
  validateTradingApplicabilityScope,
  type ApplicabilityStatus,
  type DevelopmentalMemoryApplicability,
  type TradingApplicabilityScope,
} from './applicability.js'

export const DEVELOPMENTAL_MEMORY_RETRIEVAL_REQUEST_SCHEMA_VERSION = 1 as const
export const DEVELOPMENTAL_MEMORY_RETRIEVAL_RESULT_SCHEMA_VERSION = 1 as const
export const DEVELOPMENTAL_MEMORY_RETRIEVAL_ITEM_SCHEMA_VERSION = 1 as const

export const DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS = Object.freeze({
  maximumQueryCharacters: 4_096,
  maximumCandidates: 256,
  maximumProjectionItems: 32,
  maximumProjectionCharacters: 32_768,
  maximumStoreRevisions: 4_096,
  maximumSummaryCharactersPerRevision: 32_768,
  maximumApplicabilityAssessments: 4_096,
})

export interface DevelopmentalMemoryRetrievalFilters {
  readonly kinds?: readonly DevelopmentalMemoryKind[]
  readonly maturities?: readonly DevelopmentalMemoryMaturity[]
  readonly applicabilityStatuses?: readonly ApplicabilityStatus[]
}

export interface DevelopmentalMemoryRetrievalBudget {
  readonly maximumCandidates: number
  readonly maximumProjectionItems: number
  readonly maximumProjectionCharacters: number
}

export interface DevelopmentalMemoryRetrievalRequest {
  readonly schemaVersion:
    typeof DEVELOPMENTAL_MEMORY_RETRIEVAL_REQUEST_SCHEMA_VERSION
  readonly queryText: string
  readonly asOf: number
  readonly filters: DevelopmentalMemoryRetrievalFilters
  readonly context: TradingApplicabilityScope
  readonly budget: DevelopmentalMemoryRetrievalBudget
  readonly authorityGranted: false
}

export interface DevelopmentalMemoryRetrievalEvidenceReference {
  readonly source: CanonicalTradingEvidenceSource
  readonly recordId: string
}

export interface DevelopmentalMemoryRetrievalApplicability {
  readonly assessmentId: string
  readonly status: ApplicabilityStatus
  readonly scope: TradingApplicabilityScope
  readonly assessedAt: number
  readonly lastConfirmedAt: number | null
  readonly assessmentAgeAtAsOfMs: number
}

export interface DevelopmentalMemoryRetrievalItem {
  readonly schemaVersion:
    typeof DEVELOPMENTAL_MEMORY_RETRIEVAL_ITEM_SCHEMA_VERSION
  readonly memoryId: string
  readonly revisionId: string
  readonly revision: number
  readonly kind: DevelopmentalMemoryKind
  readonly maturity: DevelopmentalMemoryMaturity
  readonly summary: string
  readonly lexical: {
    readonly matchedQueryTokenCount: number
    readonly totalQueryTokenCount: number
  }
  readonly context: {
    readonly exactMatchCount: number
    readonly matchedScopeKeys: readonly string[]
  }
  readonly applicability: DevelopmentalMemoryRetrievalApplicability | null
  readonly evidenceCount: number
  readonly evidenceReferences: readonly DevelopmentalMemoryRetrievalEvidenceReference[]
}

export interface DevelopmentalMemoryRetrievalResult {
  readonly schemaVersion:
    typeof DEVELOPMENTAL_MEMORY_RETRIEVAL_RESULT_SCHEMA_VERSION
  readonly retrievalId: string
  readonly requestDigestSha256: string
  readonly asOf: number
  readonly lexicalMatchCount: number
  readonly candidateCount: number
  readonly projectedCount: number
  readonly omittedCount: number
  readonly omissions: {
    readonly candidateBudget: number
    readonly projectionItemBudget: number
    readonly projectionCharacterBudget: number
  }
  readonly projectionCharacters: number
  readonly items: readonly DevelopmentalMemoryRetrievalItem[]
  readonly referencesOnly: true
  readonly establishesNow: false
  readonly grantsAuthority: false
}

export type DevelopmentalMemoryRetrievalErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTHORITY_REQUESTED'
  | 'INVALID_QUERY'
  | 'INVALID_AS_OF'
  | 'INVALID_FILTERS'
  | 'INVALID_CONTEXT'
  | 'INVALID_BUDGET'
  | 'INVALID_STORE'
  | 'INVALID_APPLICABILITY'
  | 'APPLICABILITY_BINDING_MISMATCH'
  | 'FUTURE_APPLICABILITY'
  | 'AMBIGUOUS_APPLICABILITY'

export class DevelopmentalMemoryRetrievalError extends Error {
  constructor(
    public readonly code: DevelopmentalMemoryRetrievalErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'DevelopmentalMemoryRetrievalError'
  }
}

const REQUEST_KEYS = [
  'schemaVersion',
  'queryText',
  'asOf',
  'filters',
  'context',
  'budget',
  'authorityGranted',
] as const
const FILTER_KEYS = ['kinds', 'maturities', 'applicabilityStatuses'] as const
const BUDGET_KEYS = [
  'maximumCandidates',
  'maximumProjectionItems',
  'maximumProjectionCharacters',
] as const
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
const KIND_SET = new Set<string>(DEVELOPMENTAL_MEMORY_KINDS)
const MATURITY_SET = new Set<string>(DEVELOPMENTAL_MEMORY_MATURITIES)
const STATUS_SET = new Set<string>(APPLICABILITY_STATUSES)

function fail(
  code: DevelopmentalMemoryRetrievalErrorCode,
  message: string,
): never {
  throw new DevelopmentalMemoryRetrievalError(code, message)
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

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function canonicalFilter<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  order: readonly T[],
): readonly T[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > order.length ||
    value.some((entry) => typeof entry !== 'string' || !allowed.has(entry)) ||
    new Set(value).size !== value.length
  ) {
    fail('INVALID_FILTERS', 'filters must be non-empty unique canonical enum arrays')
  }
  const present = new Set(value as string[])
  return order.filter((entry) => present.has(entry))
}

/** Validate, canonicalize, clone, and deeply freeze a P4A request. */
export function validateDevelopmentalMemoryRetrievalRequest(
  value: unknown,
): Readonly<DevelopmentalMemoryRetrievalRequest> {
  if (isRecord(value) && value.authorityGranted !== false) {
    fail('AUTHORITY_REQUESTED', 'retrieval cannot grant authority')
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, REQUEST_KEYS) ||
    value.schemaVersion !== DEVELOPMENTAL_MEMORY_RETRIEVAL_REQUEST_SCHEMA_VERSION
  ) {
    fail('INVALID_REQUEST', 'retrieval request has an invalid schema or keys')
  }
  if (
    typeof value.queryText !== 'string' ||
    value.queryText.length === 0 ||
    value.queryText.length > DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS.maximumQueryCharacters ||
    value.queryText.trim() !== value.queryText ||
    tokenize(value.queryText).length === 0
  ) {
    fail('INVALID_QUERY', 'queryText must be canonical non-empty tokenizable text')
  }
  if (
    typeof value.asOf !== 'number' ||
    !Number.isSafeInteger(value.asOf) ||
    value.asOf < 0
  ) {
    fail('INVALID_AS_OF', 'asOf must be a non-negative safe integer')
  }
  if (!isRecord(value.filters) || !hasOnlyKeys(value.filters, FILTER_KEYS)) {
    fail('INVALID_FILTERS', 'filters contain invalid keys')
  }
  const filters: DevelopmentalMemoryRetrievalFilters = {
    ...(value.filters.kinds === undefined
      ? {}
      : { kinds: canonicalFilter(value.filters.kinds, KIND_SET, DEVELOPMENTAL_MEMORY_KINDS) }),
    ...(value.filters.maturities === undefined
      ? {}
      : { maturities: canonicalFilter(value.filters.maturities, MATURITY_SET, DEVELOPMENTAL_MEMORY_MATURITIES) }),
    ...(value.filters.applicabilityStatuses === undefined
      ? {}
      : { applicabilityStatuses: canonicalFilter(value.filters.applicabilityStatuses, STATUS_SET, APPLICABILITY_STATUSES) }),
  }

  let context: Readonly<TradingApplicabilityScope>
  try {
    context = validateTradingApplicabilityScope(value.context)
  } catch {
    fail('INVALID_CONTEXT', 'context must satisfy the exact non-empty P2 scope law')
  }

  if (
    !isRecord(value.budget) ||
    !hasExactKeys(value.budget, BUDGET_KEYS) ||
    !positiveSafeInteger(value.budget.maximumCandidates) ||
    !positiveSafeInteger(value.budget.maximumProjectionItems) ||
    !positiveSafeInteger(value.budget.maximumProjectionCharacters) ||
    value.budget.maximumProjectionItems > value.budget.maximumCandidates ||
    value.budget.maximumCandidates > DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS.maximumCandidates ||
    value.budget.maximumProjectionItems > DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS.maximumProjectionItems ||
    value.budget.maximumProjectionCharacters > DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS.maximumProjectionCharacters
  ) {
    fail('INVALID_BUDGET', 'retrieval budget is invalid or exceeds an absolute ceiling')
  }

  return deepFreeze({
    schemaVersion: DEVELOPMENTAL_MEMORY_RETRIEVAL_REQUEST_SCHEMA_VERSION,
    queryText: value.queryText,
    asOf: value.asOf,
    filters,
    context: clone(context),
    budget: {
      maximumCandidates: value.budget.maximumCandidates,
      maximumProjectionItems: value.budget.maximumProjectionItems,
      maximumProjectionCharacters: value.budget.maximumProjectionCharacters,
    },
    authorityGranted: false,
  }) as Readonly<DevelopmentalMemoryRetrievalRequest>
}

/** Unicode NFKC + lowercase + Unicode letter/number runs; duplicates removed. */
export function tokenizeDevelopmentalMemoryQuery(value: string): readonly string[] {
  return deepFreeze(tokenize(value))
}

function tokenize(value: string): string[] {
  const runs = value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(runs)]
}

function exactScopeMatches(
  requested: TradingApplicabilityScope,
  assessed: TradingApplicabilityScope,
): readonly string[] {
  return SCOPE_KEYS.filter((key) =>
    key in requested && key in assessed &&
    serializeCanonicalJson(requested[key]) === serializeCanonicalJson(assessed[key]),
  )
}

type RankedCandidate = {
  readonly revision: ReturnType<typeof projectDevelopmentalMemories>[number]
  readonly matchedQueryTokenCount: number
  readonly totalQueryTokenCount: number
  readonly assessment: Readonly<DevelopmentalMemoryApplicability> | null
  readonly matchedScopeKeys: readonly string[]
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  const context = right.matchedScopeKeys.length - left.matchedScopeKeys.length
  if (context !== 0) return context
  const matches = right.matchedQueryTokenCount - left.matchedQueryTokenCount
  if (matches !== 0) return matches
  const coverage =
    right.matchedQueryTokenCount * left.totalQueryTokenCount -
    left.matchedQueryTokenCount * right.totalQueryTokenCount
  if (coverage !== 0) return coverage
  const presence = Number(right.assessment !== null) - Number(left.assessment !== null)
  if (presence !== 0) return presence
  const leftAge = left.assessment === null
    ? Number.MAX_SAFE_INTEGER
    : left.assessment.assessedAt
  const rightAge = right.assessment === null
    ? Number.MAX_SAFE_INTEGER
    : right.assessment.assessedAt
  if (leftAge !== rightAge) return rightAge - leftAge
  return compareCanonicalText(left.revision.revisionId, right.revision.revisionId)
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function evidenceReferences(
  candidate: RankedCandidate,
): readonly DevelopmentalMemoryRetrievalEvidenceReference[] {
  return candidate.revision.evidence
    .map(({ source, recordId }) => ({ source, recordId }))
    .sort((left, right) =>
      compareCanonicalText(left.source, right.source) ||
      compareCanonicalText(left.recordId, right.recordId),
    )
}

/**
 * Pure P4A bounded scan. Inputs are caller-supplied; no I/O, clock, random,
 * model, persistence, index, prompt, tool, or execution path is reachable.
 */
export function retrieveDevelopmentalMemories(
  requestInput: unknown,
  storeInput: unknown,
  applicabilityInput: unknown = [],
): Readonly<DevelopmentalMemoryRetrievalResult> {
  const request = validateDevelopmentalMemoryRetrievalRequest(requestInput)

  let store: Readonly<DevelopmentalMemoryStore>
  if (
    !isRecord(storeInput) ||
    !Array.isArray(storeInput.revisions) ||
    storeInput.revisions.length > DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS.maximumStoreRevisions ||
    storeInput.revisions.some((revision) =>
      isRecord(revision) &&
      typeof revision.summary === 'string' &&
      revision.summary.length > DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS.maximumSummaryCharactersPerRevision
    )
  ) {
    fail('INVALID_STORE', 'developmental store exceeds a bounded scan limit')
  }
  try {
    store = validateDevelopmentalMemoryStore(clone(storeInput))
  } catch {
    fail('INVALID_STORE', 'developmental store does not satisfy the P1 chain law')
  }
  const allRevisions = new Map(store.revisions.map((revision) => [
    revision.revisionId,
    revision,
  ]))

  if (!Array.isArray(applicabilityInput)) {
    fail('INVALID_APPLICABILITY', 'applicability input must be an array')
  }
  if (applicabilityInput.length > DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS.maximumApplicabilityAssessments) {
    fail('INVALID_APPLICABILITY', 'applicability input exceeds the bounded scan limit')
  }
  const assessments: Readonly<DevelopmentalMemoryApplicability>[] = []
  const boundaries = new Set<string>()
  for (const input of applicabilityInput) {
    let assessment: Readonly<DevelopmentalMemoryApplicability>
    try {
      assessment = validateDevelopmentalMemoryApplicability(input)
    } catch {
      fail('INVALID_APPLICABILITY', 'assessment does not satisfy the P2 law')
    }
    const revision = allRevisions.get(assessment.revisionId)
    if (revision === undefined || revision.memoryId !== assessment.memoryId) {
      fail('APPLICABILITY_BINDING_MISMATCH', 'assessment must bind an exact supplied revision')
    }
    if (assessment.assessedAt > request.asOf) {
      fail('FUTURE_APPLICABILITY', 'assessment cannot be later than retrieval asOf')
    }
    const boundary = `${assessment.memoryId}:${assessment.revisionId}:${serializeCanonicalJson(assessment.scope)}`
    if (boundaries.has(boundary)) {
      fail('AMBIGUOUS_APPLICABILITY', 'multiple assessments govern one revision/context boundary')
    }
    boundaries.add(boundary)
    assessments.push(assessment)
  }

  const queryTokens = tokenize(request.queryText)
  const queryTokenSet = new Set(queryTokens)
  const candidates: RankedCandidate[] = []
  const latest = projectDevelopmentalMemories(store)

  for (const revision of latest) {
    if (request.filters.kinds !== undefined && !request.filters.kinds.includes(revision.kind)) continue
    if (request.filters.maturities !== undefined && !request.filters.maturities.includes(revision.maturity)) continue

    let bound = assessments
      .filter((assessment) => assessment.revisionId === revision.revisionId)
      .map((assessment) => ({
        assessment,
        matchedScopeKeys: exactScopeMatches(request.context, assessment.scope),
      }))
    if (request.filters.applicabilityStatuses !== undefined) {
      bound = bound.filter(({ assessment }) =>
        request.filters.applicabilityStatuses!.includes(assessment.status),
      )
      if (bound.length === 0) continue
    }
    bound.sort((left, right) =>
      right.matchedScopeKeys.length - left.matchedScopeKeys.length ||
      right.assessment.assessedAt - left.assessment.assessedAt ||
      compareCanonicalText(left.assessment.assessmentId, right.assessment.assessmentId),
    )
    const selected = bound[0] ?? null

    const summaryTokens = new Set(tokenize(revision.summary))
    const matchedQueryTokenCount = queryTokens.filter((token) => summaryTokens.has(token)).length
    if (matchedQueryTokenCount === 0) continue
    candidates.push({
      revision,
      matchedQueryTokenCount,
      totalQueryTokenCount: queryTokenSet.size,
      assessment: selected?.assessment ?? null,
      matchedScopeKeys: selected?.matchedScopeKeys ?? [],
    })
  }

  candidates.sort(compareCandidates)
  const lexicalMatchCount = candidates.length
  const boundedCandidates = candidates.slice(0, request.budget.maximumCandidates)
  const candidateBudgetOmitted = candidates.length - boundedCandidates.length
  const items: DevelopmentalMemoryRetrievalItem[] = []
  let projectionCharacters = 0
  let projectionItemBudget = 0
  let projectionCharacterBudget = 0

  for (const candidate of boundedCandidates) {
    if (items.length >= request.budget.maximumProjectionItems) {
      projectionItemBudget += 1
      continue
    }
    if (
      projectionCharacters + candidate.revision.summary.length >
      request.budget.maximumProjectionCharacters
    ) {
      projectionCharacterBudget += 1
      continue
    }
    const assessment = candidate.assessment
    items.push({
      schemaVersion: DEVELOPMENTAL_MEMORY_RETRIEVAL_ITEM_SCHEMA_VERSION,
      memoryId: candidate.revision.memoryId,
      revisionId: candidate.revision.revisionId,
      revision: candidate.revision.revision,
      kind: candidate.revision.kind,
      maturity: candidate.revision.maturity,
      summary: candidate.revision.summary,
      lexical: {
        matchedQueryTokenCount: candidate.matchedQueryTokenCount,
        totalQueryTokenCount: candidate.totalQueryTokenCount,
      },
      context: {
        exactMatchCount: candidate.matchedScopeKeys.length,
        matchedScopeKeys: [...candidate.matchedScopeKeys],
      },
      applicability: assessment === null
        ? null
        : {
            assessmentId: assessment.assessmentId,
            status: assessment.status,
            scope: clone(assessment.scope),
            assessedAt: assessment.assessedAt,
            lastConfirmedAt: assessment.lastConfirmedAt,
            assessmentAgeAtAsOfMs: request.asOf - assessment.assessedAt,
          },
      evidenceCount: candidate.revision.evidence.length,
      evidenceReferences: evidenceReferences(candidate),
    })
    projectionCharacters += candidate.revision.summary.length
  }

  const committed = {
    schemaVersion: DEVELOPMENTAL_MEMORY_RETRIEVAL_RESULT_SCHEMA_VERSION,
    requestDigestSha256: digestCanonicalJson(request),
    asOf: request.asOf,
    lexicalMatchCount,
    candidateCount: boundedCandidates.length,
    projectedCount: items.length,
    omittedCount: candidateBudgetOmitted + projectionItemBudget + projectionCharacterBudget,
    omissions: {
      candidateBudget: candidateBudgetOmitted,
      projectionItemBudget,
      projectionCharacterBudget,
    },
    projectionCharacters,
    items,
    referencesOnly: true as const,
    establishesNow: false as const,
    grantsAuthority: false as const,
  }
  return deepFreeze({
    ...committed,
    retrievalId: digestCanonicalJson(committed),
  }) as Readonly<DevelopmentalMemoryRetrievalResult>
}

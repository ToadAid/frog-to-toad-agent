import { createHash } from 'node:crypto'

export const DEVELOPMENTAL_MEMORY_SCHEMA_VERSION = 1 as const
export const DEVELOPMENTAL_MEMORY_PROPOSAL_SCHEMA_VERSION = 1 as const
export const DEVELOPMENTAL_MEMORY_REVISION_SCHEMA_VERSION = 1 as const

/**
 * P1A is intentionally narrow: these are the first Frog-to-Toad kinds from
 * BUILD_LIST.md. Principal policy, user preferences, relationships, external
 * facts, applicability, retrieval, and runtime activation remain later cuts.
 */
export const DEVELOPMENTAL_MEMORY_KINDS = [
  'lesson',
  'hypothesis',
  'open_thread',
] as const

export type DevelopmentalMemoryKind =
  typeof DEVELOPMENTAL_MEMORY_KINDS[number]

export const DEVELOPMENTAL_MEMORY_MATURITIES = [
  'tentative',
  'reinforced',
  'consolidated',
  'contested',
] as const

export type DevelopmentalMemoryMaturity =
  typeof DEVELOPMENTAL_MEMORY_MATURITIES[number]

export type DevelopmentalEvidenceRole = 'supports' | 'contradicts'

/**
 * Only already-durable Frog-to-Toad evidence stores are admitted in P1A.
 * These names deliberately match the logical IDs in the durability manifest.
 * Working-memory Markdown, transcripts, caches, lessons.md, sandbox command
 * audit, and live provider responses are not canonical trading evidence.
 */
export const CANONICAL_TRADING_EVIDENCE_SOURCES = [
  'spot-ledger',
  'journal',
  'signal-lifecycle',
  'signal-grades-ta',
  'forecast-records',
  'paper-perps-ledger',
  'perps-signal-journal',
  'perps-signal-grades',
] as const

export type CanonicalTradingEvidenceSource =
  typeof CANONICAL_TRADING_EVIDENCE_SOURCES[number]

export interface CanonicalTradingEvidenceRecord {
  readonly source: CanonicalTradingEvidenceSource
  readonly recordId: string
  readonly cycleId: string
  readonly contentDigestSha256: string
}

/**
 * A revision never embeds mutable source content. It binds the stable source
 * identity, cycle identity, and digest that an activation adapter later proves
 * against the canonical record.
 */
export interface DevelopmentalMemoryEvidence {
  readonly source: CanonicalTradingEvidenceSource
  readonly recordId: string
  readonly cycleId: string
  readonly contentDigestSha256: string
  readonly role: DevelopmentalEvidenceRole
}

export interface DevelopmentalMemoryProposal {
  readonly schemaVersion:
    typeof DEVELOPMENTAL_MEMORY_PROPOSAL_SCHEMA_VERSION
  readonly proposalId: string
  readonly memoryId: string
  readonly previousRevisionId: string | null
  readonly kind: DevelopmentalMemoryKind
  readonly summary: string
  readonly supportingEvidence: readonly DevelopmentalMemoryEvidence[]
  readonly contradictingEvidence: readonly DevelopmentalMemoryEvidence[]
  readonly authorityGranted: false
}

export interface DevelopmentalMemoryRevision {
  readonly schemaVersion:
    typeof DEVELOPMENTAL_MEMORY_REVISION_SCHEMA_VERSION
  readonly revisionId: string
  readonly revision: number
  readonly proposalId: string
  readonly memoryId: string
  readonly previousRevisionId: string | null
  readonly kind: DevelopmentalMemoryKind
  readonly summary: string
  readonly maturity: DevelopmentalMemoryMaturity
  readonly evidence: readonly DevelopmentalMemoryEvidence[]
  readonly authorityGranted: false
}

export interface DevelopmentalMemoryStore {
  readonly schemaVersion: typeof DEVELOPMENTAL_MEMORY_SCHEMA_VERSION
  readonly revisions: readonly DevelopmentalMemoryRevision[]
}

export interface DevelopmentalMemoryBudget {
  readonly maximumMemories: number
  readonly maximumRevisions: number
  readonly maximumEvidencePerMemory: number
  readonly maximumSummaryCharacters: number
}

export type DevelopmentalMemoryRefusalReason =
  | 'invalid_store'
  | 'invalid_evidence_catalog'
  | 'invalid_proposal'
  | 'authority_requested'
  | 'unknown_evidence'
  | 'evidence_mismatch'
  | 'duplicate_evidence'
  | 'duplicate_proposal'
  | 'insufficient_grounding'
  | 'stale_revision'
  | 'kind_mismatch'
  | 'no_new_evidence'
  | 'memory_budget_exceeded'

export type DevelopmentalMemoryOutcome =
  | {
      readonly status: 'developed'
      readonly store: Readonly<DevelopmentalMemoryStore>
      readonly revision: Readonly<DevelopmentalMemoryRevision>
    }
  | {
      readonly status: 'refused'
      readonly reason: DevelopmentalMemoryRefusalReason
    }

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MEMORY_KINDS = new Set<string>(DEVELOPMENTAL_MEMORY_KINDS)
const MATURITIES = new Set<string>(DEVELOPMENTAL_MEMORY_MATURITIES)
const EVIDENCE_SOURCES = new Set<string>(CANONICAL_TRADING_EVIDENCE_SOURCES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
  }
  return value
}

function evidenceIdentity(
  evidence: Pick<DevelopmentalMemoryEvidence, 'source' | 'recordId'>,
): string {
  return `${evidence.source}:${evidence.recordId}`
}

function validEvidenceBase(
  value: unknown,
  includeRole: boolean,
): boolean {
  if (!isRecord(value)) return false
  const expected = includeRole
    ? ['source', 'recordId', 'cycleId', 'contentDigestSha256', 'role']
    : ['source', 'recordId', 'cycleId', 'contentDigestSha256']

  return hasExactKeys(value, expected) &&
    typeof value.source === 'string' &&
    EVIDENCE_SOURCES.has(value.source) &&
    hasText(value.recordId) &&
    hasText(value.cycleId) &&
    typeof value.contentDigestSha256 === 'string' &&
    SHA256_PATTERN.test(value.contentDigestSha256) &&
    (!includeRole ||
      value.role === 'supports' ||
      value.role === 'contradicts')
}

function validEvidence(
  value: unknown,
): value is DevelopmentalMemoryEvidence {
  return validEvidenceBase(value, true)
}

function validCanonicalEvidenceRecord(
  value: unknown,
): value is CanonicalTradingEvidenceRecord {
  return validEvidenceBase(value, false)
}

function maturityFor(
  evidence: readonly DevelopmentalMemoryEvidence[],
): DevelopmentalMemoryMaturity {
  if (evidence.some(({ role }) => role === 'contradicts')) {
    return 'contested'
  }

  const supportingCycles = new Set(
    evidence
      .filter(({ role }) => role === 'supports')
      .map(({ cycleId }) => cycleId),
  ).size

  if (supportingCycles >= 3) return 'consolidated'
  if (supportingCycles === 2) return 'reinforced'
  return 'tentative'
}

function validRevision(
  value: unknown,
): value is DevelopmentalMemoryRevision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'revisionId',
      'revision',
      'proposalId',
      'memoryId',
      'previousRevisionId',
      'kind',
      'summary',
      'maturity',
      'evidence',
      'authorityGranted',
    ]) ||
    value.schemaVersion !== DEVELOPMENTAL_MEMORY_REVISION_SCHEMA_VERSION ||
    typeof value.revisionId !== 'string' ||
    !SHA256_PATTERN.test(value.revisionId) ||
    !isNonNegativeInteger(value.revision) ||
    !hasText(value.proposalId) ||
    !hasText(value.memoryId) ||
    !(value.previousRevisionId === null || hasText(value.previousRevisionId)) ||
    typeof value.kind !== 'string' ||
    !MEMORY_KINDS.has(value.kind) ||
    !hasText(value.summary) ||
    typeof value.maturity !== 'string' ||
    !MATURITIES.has(value.maturity) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(validEvidence) ||
    value.authorityGranted !== false
  ) {
    return false
  }

  const revision = value as unknown as DevelopmentalMemoryRevision
  const evidence = revision.evidence
  const identities = evidence.map(evidenceIdentity)
  return new Set(identities).size === identities.length &&
    maturityFor(evidence) === revision.maturity &&
    revisionIdFor(revision) === revision.revisionId
}

/** Reuse the complete P1 revision law without exposing its implementation. */
export function isValidDevelopmentalMemoryRevision(
  value: unknown,
): value is DevelopmentalMemoryRevision {
  return validRevision(value)
}

function validStore(value: unknown): value is DevelopmentalMemoryStore {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'revisions']) ||
    value.schemaVersion !== DEVELOPMENTAL_MEMORY_SCHEMA_VERSION ||
    !Array.isArray(value.revisions) ||
    !value.revisions.every(validRevision)
  ) {
    return false
  }

  const revisions = value.revisions as DevelopmentalMemoryRevision[]
  const revisionIds = new Set<string>()
  const proposalIds = new Set<string>()
  const latestByMemory = new Map<string, DevelopmentalMemoryRevision>()

  for (const revision of revisions) {
    if (
      revisionIds.has(revision.revisionId) ||
      proposalIds.has(revision.proposalId)
    ) {
      return false
    }

    const previous = latestByMemory.get(revision.memoryId)
    if (previous === undefined) {
      if (revision.revision !== 0 || revision.previousRevisionId !== null) {
        return false
      }
    } else {
      if (
        revision.revision !== previous.revision + 1 ||
        revision.previousRevisionId !== previous.revisionId ||
        revision.kind !== previous.kind
      ) {
        return false
      }

      const currentByIdentity = new Map(
        revision.evidence.map((evidence) => [
          evidenceIdentity(evidence),
          evidence,
        ]),
      )
      for (const prior of previous.evidence) {
        const current = currentByIdentity.get(evidenceIdentity(prior))
        if (
          current === undefined ||
          current.role !== prior.role ||
          current.cycleId !== prior.cycleId ||
          current.contentDigestSha256 !== prior.contentDigestSha256
        ) {
          return false
        }
      }
    }

    revisionIds.add(revision.revisionId)
    proposalIds.add(revision.proposalId)
    latestByMemory.set(revision.memoryId, revision)
  }

  return true
}

function validProposal(
  value: unknown,
): value is DevelopmentalMemoryProposal {
  return isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'proposalId',
      'memoryId',
      'previousRevisionId',
      'kind',
      'summary',
      'supportingEvidence',
      'contradictingEvidence',
      'authorityGranted',
    ]) &&
    value.schemaVersion === DEVELOPMENTAL_MEMORY_PROPOSAL_SCHEMA_VERSION &&
    hasText(value.proposalId) &&
    hasText(value.memoryId) &&
    (value.previousRevisionId === null || hasText(value.previousRevisionId)) &&
    typeof value.kind === 'string' &&
    MEMORY_KINDS.has(value.kind) &&
    hasText(value.summary) &&
    Array.isArray(value.supportingEvidence) &&
    value.supportingEvidence.every(validEvidence) &&
    value.supportingEvidence.every(
      (evidence) => evidence.role === 'supports',
    ) &&
    Array.isArray(value.contradictingEvidence) &&
    value.contradictingEvidence.every(validEvidence) &&
    value.contradictingEvidence.every(
      (evidence) => evidence.role === 'contradicts',
    ) &&
    value.authorityGranted === false
}

function validBudget(budget: DevelopmentalMemoryBudget): boolean {
  return isPositiveInteger(budget.maximumMemories) &&
    isPositiveInteger(budget.maximumRevisions) &&
    isPositiveInteger(budget.maximumEvidencePerMemory) &&
    isPositiveInteger(budget.maximumSummaryCharacters)
}

function latestRevisionFor(
  store: DevelopmentalMemoryStore,
  memoryId: string,
): DevelopmentalMemoryRevision | undefined {
  for (let index = store.revisions.length - 1; index >= 0; index -= 1) {
    const revision = store.revisions[index]
    if (revision?.memoryId === memoryId) return revision
  }
  return undefined
}

function revisionIdFor(
  revision: Pick<
    DevelopmentalMemoryRevision,
    | 'proposalId'
    | 'memoryId'
    | 'previousRevisionId'
    | 'revision'
    | 'kind'
    | 'summary'
    | 'evidence'
  >,
): string {
  return createHash('sha256')
    .update(serializeCanonicalJson({
      proposalId: revision.proposalId,
      memoryId: revision.memoryId,
      previousRevisionId: revision.previousRevisionId,
      revision: revision.revision,
      kind: revision.kind,
      summary: revision.summary,
      evidence: revision.evidence,
      authorityGranted: false,
    }), 'utf8')
    .digest('hex')
}

/** Deterministic JSON for content-bound evidence and revision commitments. */
export function serializeCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key])}`)
    .join(',')}}`
}

export function digestCanonicalJson(value: unknown): string {
  return createHash('sha256')
    .update(serializeCanonicalJson(value), 'utf8')
    .digest('hex')
}

export function createDevelopmentalMemoryStore():
Readonly<DevelopmentalMemoryStore> {
  return deepFreeze({
    schemaVersion: DEVELOPMENTAL_MEMORY_SCHEMA_VERSION,
    revisions: [],
  }) as Readonly<DevelopmentalMemoryStore>
}

export function projectDevelopmentalMemories(
  store: DevelopmentalMemoryStore,
): readonly Readonly<DevelopmentalMemoryRevision>[] {
  if (!validStore(store)) {
    throw new TypeError('invalid developmental memory store')
  }

  const latest = new Map<string, DevelopmentalMemoryRevision>()
  for (const revision of store.revisions) {
    latest.set(revision.memoryId, revision)
  }

  return deepFreeze(
    [...latest.values()].sort((left, right) =>
      left.memoryId.localeCompare(right.memoryId),
    ),
  )
}

export function serializeDevelopmentalMemoryCanonical(
  store: DevelopmentalMemoryStore,
): string {
  if (!validStore(store)) {
    throw new TypeError('invalid developmental memory store')
  }
  return serializeCanonicalJson(store)
}

export function digestDevelopmentalMemory(
  store: DevelopmentalMemoryStore,
): string {
  return createHash('sha256')
    .update(serializeDevelopmentalMemoryCanonical(store), 'utf8')
    .digest('hex')
}

/** Validate and freeze a store reconstructed from durable revision records. */
export function validateDevelopmentalMemoryStore(
  store: unknown,
): Readonly<DevelopmentalMemoryStore> {
  if (!validStore(store)) {
    throw new TypeError('invalid developmental memory store')
  }
  return deepFreeze(store) as Readonly<DevelopmentalMemoryStore>
}

export function developMemory(
  store: unknown,
  evidenceCatalog: readonly CanonicalTradingEvidenceRecord[],
  proposal: unknown,
  budget: DevelopmentalMemoryBudget,
): DevelopmentalMemoryOutcome {
  if (!validStore(store)) {
    return { status: 'refused', reason: 'invalid_store' }
  }

  if (
    !Array.isArray(evidenceCatalog) ||
    !evidenceCatalog.every(validCanonicalEvidenceRecord)
  ) {
    return { status: 'refused', reason: 'invalid_evidence_catalog' }
  }

  const catalog = new Map<string, CanonicalTradingEvidenceRecord>()
  for (const record of evidenceCatalog) {
    const identity = evidenceIdentity(record)
    if (catalog.has(identity)) {
      return { status: 'refused', reason: 'invalid_evidence_catalog' }
    }
    catalog.set(identity, record)
  }

  if (isRecord(proposal) && proposal.authorityGranted !== false) {
    return { status: 'refused', reason: 'authority_requested' }
  }
  if (!validProposal(proposal)) {
    return { status: 'refused', reason: 'invalid_proposal' }
  }
  if (store.revisions.some(
    ({ proposalId }) => proposalId === proposal.proposalId,
  )) {
    return { status: 'refused', reason: 'duplicate_proposal' }
  }
  if (!validBudget(budget)) {
    return { status: 'refused', reason: 'memory_budget_exceeded' }
  }
  if (proposal.summary.length > budget.maximumSummaryCharacters) {
    return { status: 'refused', reason: 'memory_budget_exceeded' }
  }

  const proposedEvidence = [
    ...proposal.supportingEvidence,
    ...proposal.contradictingEvidence,
  ]
  const identities = proposedEvidence.map(evidenceIdentity)
  if (new Set(identities).size !== identities.length) {
    return { status: 'refused', reason: 'duplicate_evidence' }
  }

  for (const evidence of proposedEvidence) {
    const canonical = catalog.get(evidenceIdentity(evidence))
    if (canonical === undefined) {
      return { status: 'refused', reason: 'unknown_evidence' }
    }
    if (
      canonical.cycleId !== evidence.cycleId ||
      canonical.contentDigestSha256 !== evidence.contentDigestSha256
    ) {
      return { status: 'refused', reason: 'evidence_mismatch' }
    }
  }

  const previous = latestRevisionFor(store, proposal.memoryId)
  if (previous === undefined) {
    if (proposal.previousRevisionId !== null) {
      return { status: 'refused', reason: 'stale_revision' }
    }
  } else {
    if (proposal.previousRevisionId !== previous.revisionId) {
      return { status: 'refused', reason: 'stale_revision' }
    }
    if (proposal.kind !== previous.kind) {
      return { status: 'refused', reason: 'kind_mismatch' }
    }
  }

  const priorByIdentity = new Map(
    (previous?.evidence ?? []).map((evidence) => [
      evidenceIdentity(evidence),
      evidence,
    ]),
  )

  for (const evidence of proposedEvidence) {
    const prior = priorByIdentity.get(evidenceIdentity(evidence))
    if (prior !== undefined) {
      if (
        prior.role !== evidence.role ||
        prior.cycleId !== evidence.cycleId ||
        prior.contentDigestSha256 !== evidence.contentDigestSha256
      ) {
        return { status: 'refused', reason: 'duplicate_evidence' }
      }
    }
  }

  const newEvidence = proposedEvidence.filter(
    (evidence) => !priorByIdentity.has(evidenceIdentity(evidence)),
  )
  if (previous !== undefined && newEvidence.length === 0) {
    return { status: 'refused', reason: 'no_new_evidence' }
  }

  const cumulativeEvidence = [
    ...(previous?.evidence ?? []),
    ...newEvidence,
  ]

  if (!cumulativeEvidence.some(({ role }) => role === 'supports')) {
    return { status: 'refused', reason: 'insufficient_grounding' }
  }
  if (cumulativeEvidence.length > budget.maximumEvidencePerMemory) {
    return { status: 'refused', reason: 'memory_budget_exceeded' }
  }

  const currentMemoryIds = new Set(
    store.revisions.map(({ memoryId }) => memoryId),
  )
  if (
    previous === undefined &&
    currentMemoryIds.size >= budget.maximumMemories
  ) {
    return { status: 'refused', reason: 'memory_budget_exceeded' }
  }
  if (store.revisions.length >= budget.maximumRevisions) {
    return { status: 'refused', reason: 'memory_budget_exceeded' }
  }

  const revisionNumber = previous === undefined ? 0 : previous.revision + 1
  const revisionId = revisionIdFor({
    proposalId: proposal.proposalId,
    memoryId: proposal.memoryId,
    previousRevisionId: proposal.previousRevisionId,
    revision: revisionNumber,
    kind: proposal.kind,
    summary: proposal.summary,
    evidence: cumulativeEvidence,
  })

  const revision = deepFreeze({
    schemaVersion: DEVELOPMENTAL_MEMORY_REVISION_SCHEMA_VERSION,
    revisionId,
    revision: revisionNumber,
    proposalId: proposal.proposalId,
    memoryId: proposal.memoryId,
    previousRevisionId: proposal.previousRevisionId,
    kind: proposal.kind,
    summary: proposal.summary,
    maturity: maturityFor(cumulativeEvidence),
    evidence: cumulativeEvidence,
    authorityGranted: false as const,
  }) as Readonly<DevelopmentalMemoryRevision>

  const nextStore = deepFreeze({
    schemaVersion: DEVELOPMENTAL_MEMORY_SCHEMA_VERSION,
    revisions: [...store.revisions, revision],
  }) as Readonly<DevelopmentalMemoryStore>

  return {
    status: 'developed',
    store: nextStore,
    revision,
  }
}

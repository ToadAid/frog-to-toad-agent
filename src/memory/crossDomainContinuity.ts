import type { ReceiptFinalityRecord } from '../safety/receiptFinality.js'
import type { Task } from '../store/tasks.js'
import {
  decodeEvidenceSnapshotV1,
  type EvidenceSnapshotV1,
} from '../spine/evidence.js'
import {
  validatePrincipalLifecycleEvent,
  type PrincipalLifecycleEvent,
} from './principalLifecycle.js'
import type { ConversationEpisodeV1 } from './conversationEpisodes.js'
import { digestCanonicalJson } from './developmentalMemory.js'

export const CROSS_DOMAIN_CONTINUITY_SCHEMA_VERSION = 1 as const

export const CROSS_DOMAIN_KINDS = [
  'CONVERSATION_EPISODE',
  'PRINCIPAL_CEREMONY',
  'RESEARCH_EVIDENCE',
  'TASK',
  'TRADE_FINALITY',
] as const

export type CrossDomainKindV1 = typeof CROSS_DOMAIN_KINDS[number]

export type CrossDomainSourceStoreV1 =
  | 'transcript/conversation-episodes'
  | 'memory/principal-lifecycle'
  | 'spine/evidence-snapshot'
  | 'tasks'
  | 'execution/receipt-finality'

export type CrossDomainTemporalCoordinateKindV1 =
  | 'STARTED_AT'
  | 'LAST_MESSAGE_AT'
  | 'CLOSURE_RECORDED_AT'
  | 'EVENT_TIME'
  | 'OBSERVED_AT'
  | 'RECEIVED_AT'
  | 'AS_OF'
  | 'SUBMITTED_AT'
  | 'ASSESSED_AT'

export interface CrossDomainTemporalCoordinateV1 {
  readonly kind: CrossDomainTemporalCoordinateKindV1
  readonly at: number
}

export interface CrossDomainReferenceNodeV1 {
  readonly schemaVersion: 1
  readonly artifact: 'CrossDomainReferenceNodeV1'
  /** P5-owned stable identity over domain + source store + source-owned ref. */
  readonly nodeId: string
  readonly domain: CrossDomainKindV1
  readonly sourceStore: CrossDomainSourceStoreV1
  /** Exact identity already owned by the source domain. */
  readonly sourceRef: string
  /** Current source state fingerprint. It may change while nodeId stays stable. */
  readonly sourceFingerprintSha256: string
  /** Structural status/classification only; never free-form source prose. */
  readonly sourceStatus: string
  /** Only source-proven time coordinates. Missing source time stays missing. */
  readonly temporalCoordinates: readonly CrossDomainTemporalCoordinateV1[]
  readonly sourceStoreBoundaryPreserved: true
  readonly authorityGranted: false
}

export interface CrossDomainSourceCatalogV1 {
  readonly tradeFinality?: readonly ReceiptFinalityRecord[]
  readonly researchEvidence?: readonly EvidenceSnapshotV1[]
  readonly principalCeremonies?: readonly PrincipalLifecycleEvent[]
  readonly tasks?: readonly Task[]
  readonly conversationEpisodes?: readonly ConversationEpisodeV1[]
}

export interface CrossDomainContinuityIndexV1 {
  readonly schemaVersion: 1
  readonly artifact: 'CrossDomainContinuityIndexV1'
  readonly indexId: string
  readonly nodes: readonly CrossDomainReferenceNodeV1[]
  readonly sourceStoreBoundariesPreserved: true
  readonly temporalProximityIsNotCausation: true
  readonly sourceTruth: false
  readonly rebuildable: true
  readonly authorityGranted: false
}

export interface CrossDomainJoinRefV1 {
  readonly domain: CrossDomainKindV1
  readonly sourceRef: string
}

export interface CrossDomainContinuityBundleV1 {
  readonly schemaVersion: 1
  readonly artifact: 'CrossDomainContinuityBundleV1'
  readonly bundleId: string
  readonly sourceIndexId: string
  readonly correlationBasis: 'EXPLICIT_TYPED_REFERENCE_SET'
  readonly members: readonly CrossDomainReferenceNodeV1[]
  readonly domains: readonly CrossDomainKindV1[]
  readonly relationshipProven: false
  readonly causationProven: false
  readonly temporalProximityUsedAsEvidence: false
  readonly sourceStoreBoundariesPreserved: true
  readonly sourceTruth: false
  readonly rebuildable: true
  readonly authorityGranted: false
}

export type CrossDomainContinuityErrorCode =
  | 'INVALID_SOURCE_ARTIFACT'
  | 'AUTHORITY_REQUESTED'
  | 'DUPLICATE_SOURCE_REF'
  | 'INVALID_JOIN_REF'
  | 'DUPLICATE_JOIN_REF'
  | 'MISSING_SOURCE_REF'
  | 'CROSS_DOMAIN_REQUIRED'

export class CrossDomainContinuityError extends Error {
  constructor(
    public readonly code: CrossDomainContinuityErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'CrossDomainContinuityError'
  }
}

const SHA256 = /^[a-f0-9]{64}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TX_HASH = /^0x[0-9a-f]{64}$/
const TASK_ID = /^\d+$/
const RECEIPT_FINALITY_STATUSES = new Set([
  'CONFIRMED',
  'REVERTED',
  'TIMEOUT',
  'REORG',
  'BALANCE_UNAVAILABLE',
  'BALANCE_MISMATCH',
  'RPC_UNAVAILABLE',
  'INVALID_RECEIPT',
])
const CATALOG_KEYS = new Set([
  'tradeFinality',
  'researchEvidence',
  'principalCeremonies',
  'tasks',
  'conversationEpisodes',
])

function fail(code: CrossDomainContinuityErrorCode, message: string): never {
  throw new CrossDomainContinuityError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\u0000')
  ) {
    fail('INVALID_SOURCE_ARTIFACT', `${label} must be non-empty canonical text`)
  }
  return value
}

function safeTime(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_SOURCE_ARTIFACT', `${label} must be a non-negative safe integer`)
  }
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('INVALID_SOURCE_ARTIFACT', `${label} must be lowercase SHA-256 hex`)
  }
  return value
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareNodes(left: CrossDomainReferenceNodeV1, right: CrossDomainReferenceNodeV1): number {
  return compareText(left.domain, right.domain) ||
    compareText(left.sourceRef, right.sourceRef)
}

function nodeIdentity(
  domain: CrossDomainKindV1,
  sourceStore: CrossDomainSourceStoreV1,
  sourceRef: string,
): string {
  return digestCanonicalJson({
    schemaVersion: CROSS_DOMAIN_CONTINUITY_SCHEMA_VERSION,
    artifact: 'CrossDomainStableIdentityV1',
    domain,
    sourceStore,
    sourceRef,
  })
}

function makeNode(
  domain: CrossDomainKindV1,
  sourceStore: CrossDomainSourceStoreV1,
  sourceRef: string,
  sourceFingerprintSha256: string,
  sourceStatus: string,
  temporalCoordinates: readonly CrossDomainTemporalCoordinateV1[],
): CrossDomainReferenceNodeV1 {
  const canonicalRef = canonicalText(sourceRef, `${domain}.sourceRef`)
  const fingerprint = digest(sourceFingerprintSha256, `${domain}.sourceFingerprintSha256`)
  const coordinates = temporalCoordinates.map((coordinate) => ({
    kind: coordinate.kind,
    at: safeTime(coordinate.at, `${domain}.${coordinate.kind}`),
  }))
  return deepFreeze({
    schemaVersion: CROSS_DOMAIN_CONTINUITY_SCHEMA_VERSION,
    artifact: 'CrossDomainReferenceNodeV1',
    nodeId: nodeIdentity(domain, sourceStore, canonicalRef),
    domain,
    sourceStore,
    sourceRef: canonicalRef,
    sourceFingerprintSha256: fingerprint,
    sourceStatus: canonicalText(sourceStatus, `${domain}.sourceStatus`),
    temporalCoordinates: coordinates,
    sourceStoreBoundaryPreserved: true,
    authorityGranted: false,
  }) as CrossDomainReferenceNodeV1
}

function adaptTradeFinality(record: ReceiptFinalityRecord): CrossDomainReferenceNodeV1 {
  if (!isRecord(record) || record.authorityGranted !== false) {
    if (isRecord(record) && record.authorityGranted !== false) {
      fail('AUTHORITY_REQUESTED', 'trade finality source cannot grant P5 authority')
    }
    fail('INVALID_SOURCE_ARTIFACT', 'trade finality record must be an object')
  }
  if (
    record.schemaVersion !== 1 ||
    (record.chain !== 'base' && record.chain !== 'ethereum') ||
    !RECEIPT_FINALITY_STATUSES.has(record.status)
  ) {
    fail('INVALID_SOURCE_ARTIFACT', 'trade finality schema, chain, or status is invalid')
  }
  if (!TX_HASH.test(record.txHash)) {
    fail('INVALID_SOURCE_ARTIFACT', 'trade finality txHash must be canonical lowercase 32-byte hex')
  }
  const expectedKey = `${record.chain}:${record.txHash}`
  if (record.key !== expectedKey) {
    fail('INVALID_SOURCE_ARTIFACT', 'trade finality key must equal exact chain:txHash')
  }
  const submittedAt = safeTime(record.submittedAt, 'trade.submittedAt')
  const assessedAt = safeTime(record.assessedAt, 'trade.assessedAt')
  if (assessedAt < submittedAt) {
    fail('INVALID_SOURCE_ARTIFACT', 'trade assessedAt cannot precede submittedAt')
  }
  // Commit to the complete source-owned finality record. P5 node identity stays
  // stable at chain:txHash, while any later canonical receipt/balance/finality
  // evidence changes the source fingerprint.
  const sourceFingerprintSha256 = digestCanonicalJson(record)
  return makeNode(
    'TRADE_FINALITY',
    'execution/receipt-finality',
    record.key,
    sourceFingerprintSha256,
    record.status,
    [
      { kind: 'SUBMITTED_AT', at: submittedAt },
      { kind: 'ASSESSED_AT', at: assessedAt },
    ],
  )
}

function adaptResearchEvidence(snapshot: EvidenceSnapshotV1): CrossDomainReferenceNodeV1 {
  let decoded: EvidenceSnapshotV1
  try {
    decoded = decodeEvidenceSnapshotV1(snapshot)
  } catch (error) {
    if (isRecord(snapshot) && snapshot.authorityGranted !== false) {
      fail('AUTHORITY_REQUESTED', 'research evidence cannot grant P5 authority')
    }
    fail(
      'INVALID_SOURCE_ARTIFACT',
      `research evidence failed canonical decode: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return makeNode(
    'RESEARCH_EVIDENCE',
    'spine/evidence-snapshot',
    decoded.evidenceId,
    decoded.digest,
    decoded.fitness.status,
    [
      { kind: 'EVENT_TIME', at: decoded.eventTime },
      { kind: 'OBSERVED_AT', at: decoded.observedAt },
      { kind: 'RECEIVED_AT', at: decoded.receivedAt },
      { kind: 'AS_OF', at: decoded.asOf },
    ],
  )
}

function adaptPrincipalCeremony(event: PrincipalLifecycleEvent): CrossDomainReferenceNodeV1 {
  let validated: Readonly<PrincipalLifecycleEvent>
  try {
    validated = validatePrincipalLifecycleEvent(event)
  } catch (error) {
    if (isRecord(event) && event.authorityGranted !== false) {
      fail('AUTHORITY_REQUESTED', 'principal ceremony cannot grant P5 authority')
    }
    fail(
      'INVALID_SOURCE_ARTIFACT',
      `principal ceremony failed canonical validation: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // This source contract currently carries no event timestamp. P5 must not
  // fabricate one from file position, wall-clock observation, or neighboring rows.
  return makeNode(
    'PRINCIPAL_CEREMONY',
    'memory/principal-lifecycle',
    validated.lifecycleEventId,
    digestCanonicalJson(validated),
    validated.lifecycleKind,
    [],
  )
}

function adaptTask(task: Task): CrossDomainReferenceNodeV1 {
  if (!isRecord(task)) {
    fail('INVALID_SOURCE_ARTIFACT', 'task must be an object')
  }
  if (
    typeof task.id !== 'string' ||
    !TASK_ID.test(task.id) ||
    (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'completed') ||
    !Array.isArray(task.blocks) ||
    !Array.isArray(task.blockedBy)
  ) {
    fail('INVALID_SOURCE_ARTIFACT', 'task identity or state is malformed')
  }
  if (
    !task.blocks.every((item) => typeof item === 'string' && TASK_ID.test(item)) ||
    !task.blockedBy.every((item) => typeof item === 'string' && TASK_ID.test(item))
  ) {
    fail('INVALID_SOURCE_ARTIFACT', 'task dependency refs must be numeric task ids')
  }
  const sourceFingerprintSha256 = digestCanonicalJson({
    id: task.id,
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm ?? null,
    owner: task.owner ?? null,
    status: task.status,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    metadata: task.metadata ?? null,
  })
  // The task source has no timestamp field. P5 preserves that absence.
  return makeNode(
    'TASK',
    'tasks',
    task.id,
    sourceFingerprintSha256,
    task.status,
    [],
  )
}

function validateConversationEpisode(
  episode: ConversationEpisodeV1,
): ConversationEpisodeV1 {
  if (!isRecord(episode)) {
    fail('INVALID_SOURCE_ARTIFACT', 'conversation episode must be an object')
  }
  if (episode.authorityGranted !== false) {
    fail('AUTHORITY_REQUESTED', 'conversation episode cannot grant P5 authority')
  }
  if (
    episode.schemaVersion !== 1 ||
    episode.artifact !== 'ConversationEpisodeV1' ||
    !SHA256.test(episode.episodeId) ||
    !SHA256.test(episode.projectionId) ||
    !SHA256.test(episode.chatScopeRef) ||
    !SHA256.test(episode.firstSourceRecordRef) ||
    !UUID_V4.test(episode.conversationRunId) ||
    episode.messageTextCanEstablishIdentity !== false ||
    episode.summaryReusableAsDoctrine !== false ||
    episode.transcriptCompletenessProven !== false
  ) {
    fail('INVALID_SOURCE_ARTIFACT', 'conversation episode identity or authority boundary is malformed')
  }
  const expectedEpisodeId = digestCanonicalJson({
    chatScopeRef: episode.chatScopeRef,
    conversationRunId: episode.conversationRunId,
    firstSourceRecordRef: episode.firstSourceRecordRef,
  })
  if (episode.episodeId !== expectedEpisodeId) {
    fail('INVALID_SOURCE_ARTIFACT', 'conversation episodeId does not match P4 identity coordinates')
  }
  const { projectionId, ...body } = episode
  if (digestCanonicalJson(body) !== projectionId) {
    fail('INVALID_SOURCE_ARTIFACT', 'conversation projectionId does not match P4 canonical body')
  }
  for (const message of episode.messages) {
    if (
      message.conversationRunId !== episode.conversationRunId ||
      message.authorityGranted !== false ||
      message.messageTextCanEstablishIdentity !== false
    ) {
      fail('INVALID_SOURCE_ARTIFACT', 'conversation message binding is incoherent with episode')
    }
  }
  if (
    episode.closure !== null &&
    episode.closure.conversationRunId !== episode.conversationRunId
  ) {
    fail('INVALID_SOURCE_ARTIFACT', 'conversation closure binding is incoherent with episode')
  }
  return episode
}

function adaptConversationEpisode(episode: ConversationEpisodeV1): CrossDomainReferenceNodeV1 {
  const validated = validateConversationEpisode(episode)
  const coordinates: CrossDomainTemporalCoordinateV1[] = [
    { kind: 'STARTED_AT', at: safeTime(validated.startedAt, 'conversation.startedAt') },
  ]
  if (validated.lastMessageAt !== null) {
    coordinates.push({
      kind: 'LAST_MESSAGE_AT',
      at: safeTime(validated.lastMessageAt, 'conversation.lastMessageAt'),
    })
  }
  if (validated.closure !== null) {
    coordinates.push({
      kind: 'CLOSURE_RECORDED_AT',
      at: safeTime(validated.closure.recordedAt, 'conversation.closure.recordedAt'),
    })
  }
  return makeNode(
    'CONVERSATION_EPISODE',
    'transcript/conversation-episodes',
    validated.episodeId,
    validated.projectionId,
    validated.closureStatus,
    coordinates,
  )
}

function sourceKey(domain: CrossDomainKindV1, sourceRef: string): string {
  return `${domain}\u0000${sourceRef}`
}

/**
 * Build a deterministic, authority-free cross-domain reference index from
 * canonical source artifacts. The index owns no source state and persists
 * nothing. It never joins artifacts by text, adjacency, timestamp, or sequence.
 */
export function projectCrossDomainContinuityIndexV1(
  catalog: CrossDomainSourceCatalogV1,
): CrossDomainContinuityIndexV1 {
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
    fail('INVALID_SOURCE_ARTIFACT', 'cross-domain source catalog must be an object')
  }
  for (const key of Object.keys(catalog)) {
    if (!CATALOG_KEYS.has(key)) {
      fail('INVALID_SOURCE_ARTIFACT', `cross-domain source catalog has unsupported field ${key}`)
    }
  }
  const lane = <T>(value: readonly T[] | undefined, label: string): readonly T[] => {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      fail('INVALID_SOURCE_ARTIFACT', `${label} must be an array when present`)
    }
    return value
  }
  const nodes: CrossDomainReferenceNodeV1[] = [
    ...lane(catalog.tradeFinality, 'tradeFinality').map(adaptTradeFinality),
    ...lane(catalog.researchEvidence, 'researchEvidence').map(adaptResearchEvidence),
    ...lane(catalog.principalCeremonies, 'principalCeremonies').map(adaptPrincipalCeremony),
    ...lane(catalog.tasks, 'tasks').map(adaptTask),
    ...lane(catalog.conversationEpisodes, 'conversationEpisodes').map(adaptConversationEpisode),
  ].sort(compareNodes)

  const seen = new Set<string>()
  for (const node of nodes) {
    const key = sourceKey(node.domain, node.sourceRef)
    if (seen.has(key)) {
      fail('DUPLICATE_SOURCE_REF', `${node.domain} source ref ${node.sourceRef} appears more than once`)
    }
    seen.add(key)
  }

  const body = {
    schemaVersion: CROSS_DOMAIN_CONTINUITY_SCHEMA_VERSION,
    artifact: 'CrossDomainContinuityIndexV1' as const,
    nodes,
    sourceStoreBoundariesPreserved: true as const,
    temporalProximityIsNotCausation: true as const,
    sourceTruth: false as const,
    rebuildable: true as const,
    authorityGranted: false as const,
  }
  return deepFreeze({
    ...body,
    indexId: digestCanonicalJson(body),
  }) as CrossDomainContinuityIndexV1
}

function validateJoinRef(value: CrossDomainJoinRefV1 | unknown): CrossDomainJoinRefV1 {
  if (!isRecord(value)) fail('INVALID_JOIN_REF', 'join ref must be an object')
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'domain' || keys[1] !== 'sourceRef') {
    fail('INVALID_JOIN_REF', 'join ref must contain exactly domain + sourceRef')
  }
  if (!CROSS_DOMAIN_KINDS.includes(value.domain as CrossDomainKindV1)) {
    fail('INVALID_JOIN_REF', 'join ref domain is unsupported')
  }
  return {
    domain: value.domain as CrossDomainKindV1,
    sourceRef: canonicalText(value.sourceRef, 'joinRef.sourceRef'),
  }
}

/**
 * Explicitly select exact typed source refs from an index.
 *
 * Membership says only "these exact source artifacts were requested together".
 * It NEVER proves semantic relationship, causal relationship, or authority.
 */
export function projectCrossDomainContinuityBundleV1(
  index: CrossDomainContinuityIndexV1,
  requested: readonly CrossDomainJoinRefV1[],
): CrossDomainContinuityBundleV1 {
  if (!isRecord(index) || index.authorityGranted !== false || index.sourceTruth !== false) {
    fail('INVALID_SOURCE_ARTIFACT', 'P5 index is malformed or requests authority')
  }
  const { indexId, ...indexBody } = index
  if (!SHA256.test(indexId) || digestCanonicalJson(indexBody) !== indexId) {
    fail('INVALID_SOURCE_ARTIFACT', 'P5 index digest does not match its canonical body')
  }
  if (!Array.isArray(requested) || requested.length < 2) {
    fail('CROSS_DOMAIN_REQUIRED', 'a cross-domain bundle requires at least two typed refs')
  }

  const refs = requested.map(validateJoinRef)
  const requestedKeys = refs.map((ref) => sourceKey(ref.domain, ref.sourceRef))
  if (new Set(requestedKeys).size !== requestedKeys.length) {
    fail('DUPLICATE_JOIN_REF', 'cross-domain join request contains duplicate typed refs')
  }

  const byKey = new Map(index.nodes.map((node) => [
    sourceKey(node.domain, node.sourceRef),
    node,
  ]))
  const members = refs.map((ref) => {
    const node = byKey.get(sourceKey(ref.domain, ref.sourceRef))
    if (!node) {
      fail('MISSING_SOURCE_REF', `${ref.domain} source ref ${ref.sourceRef} is absent from the index`)
    }
    return node
  }).sort(compareNodes)

  const domains = [...new Set(members.map((member) => member.domain))]
    .sort(compareText) as CrossDomainKindV1[]
  if (domains.length < 2) {
    fail('CROSS_DOMAIN_REQUIRED', 'bundle members must span at least two source domains')
  }

  const body = {
    schemaVersion: CROSS_DOMAIN_CONTINUITY_SCHEMA_VERSION,
    artifact: 'CrossDomainContinuityBundleV1' as const,
    sourceIndexId: index.indexId,
    correlationBasis: 'EXPLICIT_TYPED_REFERENCE_SET' as const,
    members,
    domains,
    relationshipProven: false as const,
    causationProven: false as const,
    temporalProximityUsedAsEvidence: false as const,
    sourceStoreBoundariesPreserved: true as const,
    sourceTruth: false as const,
    rebuildable: true as const,
    authorityGranted: false as const,
  }
  return deepFreeze({
    ...body,
    bundleId: digestCanonicalJson(body),
  }) as CrossDomainContinuityBundleV1
}

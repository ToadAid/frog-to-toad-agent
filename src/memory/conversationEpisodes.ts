import type { Config } from '../config.js'
import { readTranscriptSnapshot } from '../loop/context.js'
import { digestCanonicalJson } from './developmentalMemory.js'

export const CONVERSATION_EPISODE_SCHEMA_VERSION = 1 as const

export type ConversationActorAttributionV1 =
  | {
      readonly kind: 'AUTHENTICATED_PRINCIPAL'
      readonly source: 'telegram_user'
      readonly principalProvider: 'telegram'
      readonly principalId: 'telegram:system-owner'
      readonly principalRole: 'SYSTEM_OWNER'
      readonly identityEvidence: 'UPSTREAM_TRANSPORT_AUTHENTICATED_CONTEXT'
      readonly authorityGranted: false
    }
  | {
      readonly kind: 'AUTHENTICATED_PRINCIPAL'
      readonly source: 'principal_operator'
      readonly principalProvider: 'local'
      readonly principalId: 'local:principal-operator'
      readonly principalRole: 'SYSTEM_OWNER'
      readonly identityEvidence: 'CODE_OWNED_OPERATOR_CONTEXT'
      readonly authorityGranted: false
    }
  | {
      readonly kind: 'UNAUTHENTICATED_SPEAKER'
      readonly source: 'telegram_user'
      readonly identityContinuity: 'UNPROVEN'
      readonly authorityGranted: false
    }
  | {
      readonly kind: 'AUTHENTICATION_CLAIM_REFUSED'
      readonly source: 'telegram_user'
      readonly identityContinuity: 'UNPROVEN'
      readonly authorityGranted: false
    }
  | {
      readonly kind: 'SYSTEM_ORIGIN'
      readonly source: 'scheduled_system' | 'system_internal'
      readonly identityContinuity: 'CODE_OWNED_SOURCE_CLASS_ONLY'
      readonly authorityGranted: false
    }
  | {
      readonly kind: 'UNATTRIBUTED_USER_ROLE'
      readonly source: 'legacy_or_unknown'
      readonly identityContinuity: 'UNPROVEN'
      readonly authorityGranted: false
    }

export interface ConversationMessageMetadataV1 {
  readonly recordRef: string
  readonly recordedAt: number
  readonly conversationRunId: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly kind:
    | 'USER_ROLE_MESSAGE'
    | 'ASSISTANT_MESSAGE'
    | 'TOOL_RESULT'
    | 'REBUILDABLE_SUMMARY_BOUNDARY'
  readonly contentDigestSha256: string
  readonly contentChars: number
  readonly actor: ConversationActorAttributionV1 | null
  readonly messageTextCanEstablishIdentity: false
  readonly authorityGranted: false
}

export interface ConversationRunClosureV1 {
  readonly recordRef: string
  readonly recordedAt: number
  readonly conversationRunId: string
  /** Short operator-facing runtime id; not an episode identity key. */
  readonly runId: string
  readonly agent: string
  readonly turns: number
  readonly toolCalls: number
  readonly aborted: boolean
  readonly termination:
    | 'FINAL'
    | 'FINAL_FOLLOWUP_CAP'
    | 'BRAIN_EMPTY'
    | 'TURN_BUDGET'
    | 'TURN_BUDGET_BUDGET_CAP'
    | 'ABORTED'
    | 'ERROR'
}

export interface ConversationEpisodeV1 {
  readonly schemaVersion: 1
  readonly artifact: 'ConversationEpisodeV1'
  readonly projectionId: string
  readonly episodeId: string
  readonly chatScopeRef: string
  readonly conversationRunId: string
  readonly firstSourceRecordRef: string
  readonly messages: readonly ConversationMessageMetadataV1[]
  readonly closureStatus: 'RUN_SUMMARY_OBSERVED' | 'RUN_SUMMARY_NOT_OBSERVED'
  readonly closure: ConversationRunClosureV1 | null
  readonly startedAt: number
  readonly lastMessageAt: number | null
  readonly counts: {
    readonly messages: number
    readonly authenticatedPrincipalUserMessages: number
    readonly unauthenticatedUserMessages: number
    readonly refusedAuthenticationClaims: number
    readonly systemOriginUserMessages: number
    readonly unattributedUserRoleMessages: number
    readonly assistantMessages: number
    readonly toolResults: number
    readonly rebuildableSummaryBoundaries: number
  }
  /**
   * Transcript append is currently best-effort, so observing a run-summary close
   * never proves that every message emitted by the run reached the transcript.
   */
  readonly transcriptCompletenessProven: false
  readonly messageTextCanEstablishIdentity: false
  readonly summaryReusableAsDoctrine: false
  readonly authorityGranted: false
}

export interface ConversationEpisodeSummaryProjectionV1 {
  readonly schemaVersion: 1
  readonly artifact: 'ConversationEpisodeSummaryProjectionV1'
  readonly projectionId: string
  readonly sourceEpisodeId: string
  readonly sourceEpisodeProjectionId: string
  readonly closureStatus: ConversationEpisodeV1['closureStatus']
  readonly termination: ConversationRunClosureV1['termination'] | null
  readonly messageCount: number
  readonly actorCounts: {
    readonly authenticatedPrincipal: number
    readonly unauthenticated: number
    readonly refusedAuthenticationClaims: number
    readonly systemOrigin: number
    readonly unattributed: number
  }
  readonly sourceTruth: false
  readonly rebuildable: true
  readonly reusableAsDoctrine: false
  readonly authorityGranted: false
}

export interface ConversationTranscriptProjectionV1 {
  readonly schemaVersion: 1
  readonly artifact: 'ConversationTranscriptProjectionV1'
  readonly projectionId: string
  readonly chatScopeRef: string
  readonly episodes: readonly ConversationEpisodeV1[]
  /** Message rows written before P4 (or by a lane without run binding) stay unbound. */
  readonly unboundMessageRecordRefs: readonly string[]
  /** Pre-P4 terminal summaries have only short runId and cannot close a P4 episode. */
  readonly unboundRunSummaryRecordRefs: readonly string[]
  /** Autocompact prose is context overlay only; it never authenticates or becomes doctrine. */
  readonly rebuildableSummaryBoundaryRefs: readonly string[]
  readonly transcriptCompletenessProven: false
  readonly messageTextCanEstablishIdentity: false
  readonly authorityGranted: false
}

export type ConversationTranscriptProjectionResultV1 =
  | {
      readonly ok: true
      readonly projection: ConversationTranscriptProjectionV1
    }
  | {
      readonly ok: false
      readonly artifact: 'ConversationTranscriptProjectionFailureV1'
      readonly reason: 'TRANSCRIPT_OBSERVATION_FAILED' | 'TRANSCRIPT_PROJECTION_REFUSED'
      readonly error: string
      readonly authorityGranted: false
    }

export type ConversationEpisodeErrorCode =
  | 'INVALID_CHAT_SCOPE_REF'
  | 'INVALID_TRANSCRIPT_RECORD'
  | 'INVALID_TIME'
  | 'INVALID_RUN_ID'
  | 'INVALID_RUN_SUMMARY'
  | 'DUPLICATE_RUN_SUMMARY'
  | 'MESSAGE_AFTER_RUN_SUMMARY'

export class ConversationEpisodeError extends Error {
  constructor(
    public readonly code: ConversationEpisodeErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ConversationEpisodeError'
  }
}

const SHA256 = /^[a-f0-9]{64}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Terminal reasons (src/types.ts RunTermination). Additive widening (Tier 2
// #12): the ledger's guard reasons are accepted alongside the originals —
// validation only, no migration needed.
const TERMINATIONS = new Set([
  'FINAL',
  'FINAL_FOLLOWUP_CAP',
  'BRAIN_EMPTY',
  'TURN_BUDGET',
  'TURN_BUDGET_BUDGET_CAP',
  'ABORTED',
  'ERROR',
])

type JsonRecord = Record<string, unknown>

type EpisodeBuilder = {
  runId: string
  firstOrdinal: number
  firstSourceRecordRef: string
  messages: ConversationMessageMetadataV1[]
  closure: ConversationRunClosureV1 | null
}

function fail(code: ConversationEpisodeErrorCode, message: string): never {
  throw new ConversationEpisodeError(code, message)
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalText(value: unknown, label: string, code: ConversationEpisodeErrorCode): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\u0000')
  ) {
    fail(code, `${label} must be non-empty canonical text`)
  }
  return value
}

function parseConversationRunId(value: unknown): string {
  const parsed = canonicalText(value, 'conversationRunId', 'INVALID_RUN_ID')
  if (!UUID_V4.test(parsed)) {
    fail(
      'INVALID_RUN_ID',
      'conversationRunId must be canonical lowercase UUIDv4 emitted by runtime code',
    )
  }
  return parsed
}

function safeTime(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_TIME', `${label} must be a non-negative safe integer`)
  }
  return value
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_RUN_SUMMARY', `${label} must be a non-negative safe integer`)
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

function chatScopeRef(chatId: number): string {
  if (!Number.isSafeInteger(chatId)) {
    fail('INVALID_CHAT_SCOPE_REF', 'chatId must be a safe integer')
  }
  // Pseudonymous binding, not a secrecy claim.
  return digestCanonicalJson({ source: 'transcript-chat', chatId })
}

function parseActor(value: unknown): ConversationActorAttributionV1 {
  if (!isRecord(value)) {
    return {
      kind: 'UNATTRIBUTED_USER_ROLE',
      source: 'legacy_or_unknown',
      identityContinuity: 'UNPROVEN',
      authorityGranted: false,
    }
  }

  if (value.source === 'telegram_user') {
    if (
      value.principalAuthenticated === true &&
      value.principalProvider === 'telegram' &&
      value.principalId === 'telegram:system-owner' &&
      value.principalRole === 'SYSTEM_OWNER' &&
      value.ownerBindingConfigured === true &&
      value.transportIdentityPresent === true &&
      value.ownerIdentityMatch === true &&
      value.authorityGranted === false
    ) {
      return {
        kind: 'AUTHENTICATED_PRINCIPAL',
        source: 'telegram_user',
        principalProvider: 'telegram',
        principalId: 'telegram:system-owner',
        principalRole: 'SYSTEM_OWNER',
        identityEvidence: 'UPSTREAM_TRANSPORT_AUTHENTICATED_CONTEXT',
        authorityGranted: false,
      }
    }

    if (value.principalAuthenticated === true) {
      return {
        kind: 'AUTHENTICATION_CLAIM_REFUSED',
        source: 'telegram_user',
        identityContinuity: 'UNPROVEN',
        authorityGranted: false,
      }
    }

    return {
      kind: 'UNAUTHENTICATED_SPEAKER',
      source: 'telegram_user',
      identityContinuity: 'UNPROVEN',
      authorityGranted: false,
    }
  }

  if (value.source === 'principal_operator' && value.displayName === 'Principal operator') {
    return {
      kind: 'AUTHENTICATED_PRINCIPAL',
      source: 'principal_operator',
      principalProvider: 'local',
      principalId: 'local:principal-operator',
      principalRole: 'SYSTEM_OWNER',
      identityEvidence: 'CODE_OWNED_OPERATOR_CONTEXT',
      authorityGranted: false,
    }
  }

  if (value.source === 'scheduled_system' || value.source === 'system_internal') {
    return {
      kind: 'SYSTEM_ORIGIN',
      source: value.source,
      identityContinuity: 'CODE_OWNED_SOURCE_CLASS_ONLY',
      authorityGranted: false,
    }
  }

  return {
    kind: 'UNATTRIBUTED_USER_ROLE',
    source: 'legacy_or_unknown',
    identityContinuity: 'UNPROVEN',
    authorityGranted: false,
  }
}

function recordRef(previousRecordRef: string, line: string): string {
  return digestCanonicalJson({
    previousRecordRef,
    rawRecordDigestSha256: digestCanonicalJson({ rawTranscriptRecord: line }),
  })
}

function parseMessageMetadata(
  messageValue: unknown,
  record: JsonRecord,
  sourceRecordRef: string,
  recordedAt: number,
  runId: string,
): ConversationMessageMetadataV1 {
  if (!isRecord(messageValue)) {
    fail('INVALID_TRANSCRIPT_RECORD', 'message must be a plain object')
  }

  const role = messageValue.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
    fail('INVALID_TRANSCRIPT_RECORD', 'persisted conversation message role is unsupported')
  }

  let content: string
  if (role === 'assistant') {
    if (messageValue.content !== null && typeof messageValue.content !== 'string') {
      fail('INVALID_TRANSCRIPT_RECORD', 'assistant content must be string or null')
    }
    content = typeof messageValue.content === 'string' ? messageValue.content : ''
  } else {
    if (typeof messageValue.content !== 'string') {
      fail('INVALID_TRANSCRIPT_RECORD', `${role} content must be a string`)
    }
    content = messageValue.content
  }

  const rebuildableSummary = isRecord(record.autocompact)
  const actor =
    role === 'user'
      ? parseActor(messageValue.actor)
      : null

  return {
    recordRef: sourceRecordRef,
    recordedAt,
    conversationRunId: runId,
    role,
    kind: rebuildableSummary
      ? 'REBUILDABLE_SUMMARY_BOUNDARY'
      : role === 'user'
        ? 'USER_ROLE_MESSAGE'
        : role === 'assistant'
          ? 'ASSISTANT_MESSAGE'
          : 'TOOL_RESULT',
    contentDigestSha256: digestCanonicalJson({ content }),
    contentChars: content.length,
    actor,
    messageTextCanEstablishIdentity: false,
    authorityGranted: false,
  }
}

function parseClosure(
  record: JsonRecord,
  sourceRecordRef: string,
): ConversationRunClosureV1 {
  const conversationRunId = parseConversationRunId(record.conversationRunId)
  const runId = canonicalText(record.runId, 'runId', 'INVALID_RUN_ID')
  const agent = canonicalText(record.agent, 'agent', 'INVALID_RUN_SUMMARY')
  const recordedAt = safeTime(record.ts, 'run summary ts')

  if (!isRecord(record.summary)) {
    fail('INVALID_RUN_SUMMARY', 'run summary must be a plain object')
  }
  const summary = record.summary
  const termination = summary.termination
  if (typeof termination !== 'string' || !TERMINATIONS.has(termination)) {
    fail('INVALID_RUN_SUMMARY', 'run summary termination is unsupported')
  }
  if (typeof summary.aborted !== 'boolean') {
    fail('INVALID_RUN_SUMMARY', 'run summary aborted must be boolean')
  }

  return {
    recordRef: sourceRecordRef,
    recordedAt,
    conversationRunId,
    runId,
    agent,
    turns: nonNegativeInt(summary.turns, 'summary.turns'),
    toolCalls: nonNegativeInt(summary.toolCalls, 'summary.toolCalls'),
    aborted: summary.aborted,
    termination: termination as ConversationRunClosureV1['termination'],
  }
}

function buildCounts(messages: readonly ConversationMessageMetadataV1[]): ConversationEpisodeV1['counts'] {
  let authenticatedPrincipalUserMessages = 0
  let unauthenticatedUserMessages = 0
  let refusedAuthenticationClaims = 0
  let systemOriginUserMessages = 0
  let unattributedUserRoleMessages = 0
  let assistantMessages = 0
  let toolResults = 0
  let rebuildableSummaryBoundaries = 0

  for (const message of messages) {
    if (message.kind === 'REBUILDABLE_SUMMARY_BOUNDARY') rebuildableSummaryBoundaries += 1
    if (message.role === 'assistant') assistantMessages += 1
    if (message.role === 'tool') toolResults += 1
    if (message.role !== 'user' || message.actor === null) continue

    if (message.actor.kind === 'AUTHENTICATED_PRINCIPAL') authenticatedPrincipalUserMessages += 1
    else if (message.actor.kind === 'UNAUTHENTICATED_SPEAKER') unauthenticatedUserMessages += 1
    else if (message.actor.kind === 'AUTHENTICATION_CLAIM_REFUSED') refusedAuthenticationClaims += 1
    else if (message.actor.kind === 'SYSTEM_ORIGIN') systemOriginUserMessages += 1
    else unattributedUserRoleMessages += 1
  }

  return {
    messages: messages.length,
    authenticatedPrincipalUserMessages,
    unauthenticatedUserMessages,
    refusedAuthenticationClaims,
    systemOriginUserMessages,
    unattributedUserRoleMessages,
    assistantMessages,
    toolResults,
    rebuildableSummaryBoundaries,
  }
}

function buildEpisode(chatScope: string, builder: EpisodeBuilder): ConversationEpisodeV1 {
  const firstMessage = builder.messages[0]
  const startedAt = firstMessage?.recordedAt ?? builder.closure?.recordedAt
  if (startedAt === undefined) {
    fail('INVALID_TRANSCRIPT_RECORD', 'episode has neither message nor closure')
  }

  const firstSourceRecordRef =
    builder.firstSourceRecordRef
  const episodeId = digestCanonicalJson({
    chatScopeRef: chatScope,
    conversationRunId: builder.runId,
    firstSourceRecordRef,
  })
  const closureStatus = builder.closure
    ? 'RUN_SUMMARY_OBSERVED' as const
    : 'RUN_SUMMARY_NOT_OBSERVED' as const

  const body = {
    schemaVersion: CONVERSATION_EPISODE_SCHEMA_VERSION,
    artifact: 'ConversationEpisodeV1' as const,
    episodeId,
    chatScopeRef: chatScope,
    conversationRunId: builder.runId,
    firstSourceRecordRef,
    messages: [...builder.messages],
    closureStatus,
    closure: builder.closure,
    startedAt,
    lastMessageAt: builder.messages.length > 0
      ? builder.messages[builder.messages.length - 1]!.recordedAt
      : null,
    counts: buildCounts(builder.messages),
    transcriptCompletenessProven: false as const,
    messageTextCanEstablishIdentity: false as const,
    summaryReusableAsDoctrine: false as const,
    authorityGranted: false as const,
  }
  const projectionId = digestCanonicalJson(body)
  return deepFreeze({ ...body, projectionId }) as ConversationEpisodeV1
}

/**
 * Build conversation episodes only from code-owned conversationRunId bindings.
 * Adjacency, time proximity, usernames, display names, and message text never
 * create episode membership or principal identity.
 */
export function projectConversationTranscriptRecordsV1(
  records: readonly string[],
  chatScopeValue: string,
): ConversationTranscriptProjectionV1 {
  if (!SHA256.test(chatScopeValue)) {
    fail('INVALID_CHAT_SCOPE_REF', 'chatScopeRef must be lowercase SHA-256 hex')
  }

  const builders = new Map<string, EpisodeBuilder>()
  const unboundMessageRecordRefs: string[] = []
  const unboundRunSummaryRecordRefs: string[] = []
  const rebuildableSummaryBoundaryRefs: string[] = []
  let previousRecordRef = '0'.repeat(64)

  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    const line = records[ordinal]
    if (typeof line !== 'string' || line.length === 0) {
      fail('INVALID_TRANSCRIPT_RECORD', `record ${ordinal + 1} must be a non-empty string`)
    }

    const sourceRecordRef = recordRef(previousRecordRef, line)
    previousRecordRef = sourceRecordRef

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      fail('INVALID_TRANSCRIPT_RECORD', `record ${ordinal + 1} is invalid JSON`)
    }
    if (!isRecord(parsed)) {
      fail('INVALID_TRANSCRIPT_RECORD', `record ${ordinal + 1} must decode to a plain object`)
    }

    const hasMessage = Object.prototype.hasOwnProperty.call(parsed, 'message')
    if (hasMessage) {
      const recordedAt = safeTime(parsed.ts, `record ${ordinal + 1} ts`)
      const isSummaryBoundary = isRecord(parsed.autocompact)
      if (isSummaryBoundary) rebuildableSummaryBoundaryRefs.push(sourceRecordRef)

      if (typeof parsed.conversationRunId !== 'string') {
        // Legacy pre-P4 messages and separately persisted context overlays never
        // gain episode membership from adjacency.
        unboundMessageRecordRefs.push(sourceRecordRef)
      } else {
        const runId = parseConversationRunId(parsed.conversationRunId)
        let builder = builders.get(runId)
        if (!builder) {
          builder = {
            runId,
            firstOrdinal: ordinal,
            firstSourceRecordRef: sourceRecordRef,
            messages: [],
            closure: null,
          }
          builders.set(runId, builder)
        }
        if (builder.closure) {
          fail(
            'MESSAGE_AFTER_RUN_SUMMARY',
            `run ${runId} has a message after its terminal run-summary record`,
          )
        }
        builder.messages.push(
          parseMessageMetadata(parsed.message, parsed, sourceRecordRef, recordedAt, runId),
        )
      }
    }

    if (
      typeof parsed.runId === 'string' &&
      isRecord(parsed.summary) &&
      typeof parsed.agent === 'string'
    ) {
      if (typeof parsed.conversationRunId !== 'string') {
        // Legacy pre-P4 terminal summaries prove that a historical run ended,
        // but they cannot bind any message row to a P4 conversation episode.
        unboundRunSummaryRecordRefs.push(sourceRecordRef)
      } else {
        const closure = parseClosure(parsed, sourceRecordRef)
        let builder = builders.get(closure.conversationRunId)
        if (!builder) {
          builder = {
            runId: closure.conversationRunId,
            firstOrdinal: ordinal,
            firstSourceRecordRef: sourceRecordRef,
            messages: [],
            closure: null,
          }
          builders.set(closure.conversationRunId, builder)
        }
        if (builder.closure) {
          fail(
            'DUPLICATE_RUN_SUMMARY',
            `conversation run ${closure.conversationRunId} has multiple terminal summaries`,
          )
        }
        builder.closure = closure
      }
    }
  }

  const episodes = [...builders.values()]
    .sort((left, right) =>
      left.firstOrdinal - right.firstOrdinal ||
      left.runId.localeCompare(right.runId))
    .map((builder) => buildEpisode(chatScopeValue, builder))

  const body = {
    schemaVersion: CONVERSATION_EPISODE_SCHEMA_VERSION,
    artifact: 'ConversationTranscriptProjectionV1' as const,
    chatScopeRef: chatScopeValue,
    episodes,
    unboundMessageRecordRefs,
    unboundRunSummaryRecordRefs,
    rebuildableSummaryBoundaryRefs,
    transcriptCompletenessProven: false as const,
    messageTextCanEstablishIdentity: false as const,
    authorityGranted: false as const,
  }

  return deepFreeze({
    ...body,
    projectionId: digestCanonicalJson(body),
  }) as ConversationTranscriptProjectionV1
}

/**
 * Read the canonical transcript snapshot. Observation failure is distinct from
 * an observed empty transcript and never collapses to "no conversation".
 */
export function projectConversationTranscriptV1(
  cfg: Config,
  chatId: number,
): ConversationTranscriptProjectionResultV1 {
  const snapshot = readTranscriptSnapshot(cfg, chatId)
  if (!snapshot.ok) {
    return {
      ok: false,
      artifact: 'ConversationTranscriptProjectionFailureV1',
      reason: 'TRANSCRIPT_OBSERVATION_FAILED',
      error: snapshot.error,
      authorityGranted: false,
    }
  }

  try {
    return {
      ok: true,
      projection: projectConversationTranscriptRecordsV1(
        snapshot.records,
        chatScopeRef(chatId),
      ),
    }
  } catch (error) {
    return {
      ok: false,
      artifact: 'ConversationTranscriptProjectionFailureV1',
      reason: 'TRANSCRIPT_PROJECTION_REFUSED',
      error: error instanceof Error ? error.message : String(error),
      authorityGranted: false,
    }
  }
}

/**
 * Deterministic structural summary only. No free-form transcript prose is
 * promoted into source truth, principal policy, obligation status, or authority.
 */
export function projectConversationEpisodeSummaryV1(
  episode: ConversationEpisodeV1,
): ConversationEpisodeSummaryProjectionV1 {
  const actorCounts = {
    authenticatedPrincipal: episode.counts.authenticatedPrincipalUserMessages,
    unauthenticated: episode.counts.unauthenticatedUserMessages,
    refusedAuthenticationClaims: episode.counts.refusedAuthenticationClaims,
    systemOrigin: episode.counts.systemOriginUserMessages,
    unattributed: episode.counts.unattributedUserRoleMessages,
  }
  const body = {
    schemaVersion: CONVERSATION_EPISODE_SCHEMA_VERSION,
    artifact: 'ConversationEpisodeSummaryProjectionV1' as const,
    sourceEpisodeId: episode.episodeId,
    sourceEpisodeProjectionId: episode.projectionId,
    closureStatus: episode.closureStatus,
    termination: episode.closure?.termination ?? null,
    messageCount: episode.counts.messages,
    actorCounts,
    sourceTruth: false as const,
    rebuildable: true as const,
    reusableAsDoctrine: false as const,
    authorityGranted: false as const,
  }
  return deepFreeze({
    ...body,
    projectionId: digestCanonicalJson(body),
  }) as ConversationEpisodeSummaryProjectionV1
}

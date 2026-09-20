import { digestCanonicalJson, serializeCanonicalJson } from './developmentalMemory.js'
import type { TurnActorContext } from '../types.js'

export const REQUEST_OBLIGATION_SCHEMA_VERSION = 1 as const
export const REQUEST_OBLIGATION_EVENT_ARTIFACT = 'RequestObligationEventV1' as const
export const REQUEST_OBLIGATION_STATUSES = [
  'OPEN', 'IN_PROGRESS', 'RESOLVED', 'DEFERRED', 'REFUSED',
] as const
export type RequestObligationStatusV1 = typeof REQUEST_OBLIGATION_STATUSES[number]

export type RequestPrincipalAttributionV1 =
  | {
      readonly source: 'UPSTREAM_AUTHENTICATED_TURN_ACTOR'
      readonly provider: 'telegram'
      readonly principalId: 'telegram:system-owner'
      readonly principalRole: 'SYSTEM_OWNER'
      readonly trustBoundary: 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE'
      readonly authorityGranted: false
    }
  | {
      readonly source: 'UPSTREAM_AUTHENTICATED_TURN_ACTOR'
      readonly provider: 'local'
      readonly principalId: 'local:principal-operator'
      readonly principalRole: 'SYSTEM_OWNER'
      readonly trustBoundary: 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE'
      readonly authorityGranted: false
    }

export interface RequestOpenedEventV1 {
  readonly schemaVersion: 1
  readonly artifact: 'RequestObligationEventV1'
  readonly eventId: string
  readonly eventKind: 'REQUEST_OPENED'
  readonly obligationId: string
  readonly recordedAt: number
  readonly principal: RequestPrincipalAttributionV1
  readonly sourceRequestRef: string
  readonly requestText: string
  readonly requestDigestSha256: string
  readonly status: 'OPEN'
  readonly previousEventId: null
  readonly responseRef: null
  readonly authorityGranted: false
  readonly historicalRequestReusableAsAuthority: false
}

export interface RequestStatusChangedEventV1 {
  readonly schemaVersion: 1
  readonly artifact: 'RequestObligationEventV1'
  readonly eventId: string
  readonly eventKind: 'STATUS_CHANGED'
  readonly obligationId: string
  readonly recordedAt: number
  readonly fromStatus: RequestObligationStatusV1
  readonly status: Exclude<RequestObligationStatusV1, 'OPEN'>
  readonly previousEventId: string
  readonly responseRef: string | null
  readonly authorityGranted: false
  readonly historicalRequestReusableAsAuthority: false
}

export type RequestObligationEventV1 = RequestOpenedEventV1 | RequestStatusChangedEventV1

export interface RequestObligationStateV1 {
  readonly schemaVersion: 1
  readonly artifact: 'RequestObligationStateV1'
  readonly obligationId: string
  readonly principal: RequestPrincipalAttributionV1
  readonly sourceRequestRef: string
  readonly requestText: string
  readonly requestDigestSha256: string
  readonly requestedAt: number
  readonly currentStatus: RequestObligationStatusV1
  readonly lastEventId: string
  readonly lastRecordedAt: number
  readonly latestResponseRef: string | null
  readonly terminal: boolean
  readonly history: readonly RequestObligationEventV1[]
  readonly authorityGranted: false
  readonly historicalRequestReusableAsAuthority: false
}

export interface UnresolvedPrincipalObligationsV1 {
  readonly schemaVersion: 1
  readonly artifact: 'UnresolvedPrincipalObligationsV1'
  readonly principalId: RequestPrincipalAttributionV1['principalId']
  readonly limit: number
  readonly totalUnresolved: number
  readonly truncated: boolean
  readonly obligations: readonly RequestObligationStateV1[]
  readonly authorityGranted: false
  readonly historicalRequestReusableAsAuthority: false
}

export type RequestObligationErrorCode =
  | 'UNAUTHENTICATED_PRINCIPAL'
  | 'INVALID_PRINCIPAL_ATTRIBUTION'
  | 'INVALID_REQUEST'
  | 'INVALID_TIME'
  | 'INVALID_EVENT'
  | 'EVENT_ID_MISMATCH'
  | 'DUPLICATE_EVENT'
  | 'DUPLICATE_OBLIGATION'
  | 'MISSING_OPEN_EVENT'
  | 'PREVIOUS_EVENT_MISMATCH'
  | 'STATUS_DRIFT'
  | 'INVALID_TRANSITION'
  | 'TIME_REGRESSION'
  | 'RESPONSE_REF_REQUIRED'
  | 'RESPONSE_REF_REFUSED'
  | 'INVALID_QUERY_LIMIT'
  | 'INVALID_PRINCIPAL_ID'
  | 'OBLIGATION_NOT_FOUND'
  | 'AUTHORITY_REQUESTED'

export class RequestObligationError extends Error {
  constructor(public readonly code: RequestObligationErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RequestObligationError'
  }
}

const SHA256 = /^[a-f0-9]{64}$/
function fail(code: RequestObligationErrorCode, message: string): never {
  throw new RequestObligationError(code, message)
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
    fail('INVALID_EVENT', `${label} must contain exactly: ${wanted.join(', ')}`)
  }
}
function canonicalText(
  value: unknown,
  label: string,
  code: RequestObligationErrorCode = 'INVALID_EVENT',
): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
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
    fail('INVALID_EVENT', `${label} must be lowercase SHA-256 hex`)
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
function rejectAuthority(value: unknown, label: string): void {
  if (isRecord(value) && 'authorityGranted' in value && value.authorityGranted !== false) {
    fail('AUTHORITY_REQUESTED', `${label} cannot grant authority`)
  }
  if (
    isRecord(value) &&
    'historicalRequestReusableAsAuthority' in value &&
    value.historicalRequestReusableAsAuthority !== false
  ) {
    fail('AUTHORITY_REQUESTED', `${label} cannot make historical requests reusable as authority`)
  }
}

function parsePrincipalAttribution(value: unknown): RequestPrincipalAttributionV1 {
  rejectAuthority(value, 'principal attribution')
  if (!isRecord(value)) fail('INVALID_PRINCIPAL_ATTRIBUTION', 'principal attribution must be a plain object')
  exactKeys(value, [
    'source', 'provider', 'principalId', 'principalRole', 'trustBoundary', 'authorityGranted',
  ], 'principal attribution')
  if (
    value.source !== 'UPSTREAM_AUTHENTICATED_TURN_ACTOR' ||
    value.principalRole !== 'SYSTEM_OWNER' ||
    value.trustBoundary !== 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE' ||
    value.authorityGranted !== false
  ) {
    fail('INVALID_PRINCIPAL_ATTRIBUTION', 'principal attribution trust fields are invalid')
  }
  if (value.provider === 'telegram' && value.principalId === 'telegram:system-owner') {
    return {
      source: 'UPSTREAM_AUTHENTICATED_TURN_ACTOR',
      provider: 'telegram',
      principalId: 'telegram:system-owner',
      principalRole: 'SYSTEM_OWNER',
      trustBoundary: 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE',
      authorityGranted: false,
    }
  }
  if (value.provider === 'local' && value.principalId === 'local:principal-operator') {
    return {
      source: 'UPSTREAM_AUTHENTICATED_TURN_ACTOR',
      provider: 'local',
      principalId: 'local:principal-operator',
      principalRole: 'SYSTEM_OWNER',
      trustBoundary: 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE',
      authorityGranted: false,
    }
  }
  return fail('INVALID_PRINCIPAL_ATTRIBUTION', 'principal provider/id binding is unsupported')
}

/** Bind only code-owned upstream authentication; persist no raw Telegram identity. */
export function bindAuthenticatedRequestPrincipalV1(
  actor: TurnActorContext | undefined,
): RequestPrincipalAttributionV1 {
  if (
    actor?.source === 'telegram_user' &&
    actor.principalAuthenticated === true &&
    actor.principalProvider === 'telegram' &&
    actor.principalId === 'telegram:system-owner' &&
    actor.principalRole === 'SYSTEM_OWNER' &&
    actor.ownerBindingConfigured === true &&
    actor.transportIdentityPresent === true &&
    actor.ownerIdentityMatch === true &&
    actor.authorityGranted === false
  ) {
    return deepFreeze({
      source: 'UPSTREAM_AUTHENTICATED_TURN_ACTOR' as const,
      provider: 'telegram' as const,
      principalId: 'telegram:system-owner' as const,
      principalRole: 'SYSTEM_OWNER' as const,
      trustBoundary: 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE' as const,
      authorityGranted: false as const,
    }) as RequestPrincipalAttributionV1
  }
  if (actor?.source === 'principal_operator' && actor.displayName === 'Principal operator') {
    return deepFreeze({
      source: 'UPSTREAM_AUTHENTICATED_TURN_ACTOR' as const,
      provider: 'local' as const,
      principalId: 'local:principal-operator' as const,
      principalRole: 'SYSTEM_OWNER' as const,
      trustBoundary: 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE' as const,
      authorityGranted: false as const,
    }) as RequestPrincipalAttributionV1
  }
  return fail('UNAUTHENTICATED_PRINCIPAL', 'request ledger accepts only an authenticated principal turn')
}

function requestDigest(requestText: string): string {
  return digestCanonicalJson({ requestText })
}
function obligationIdentity(input: {
  principalId: RequestPrincipalAttributionV1['principalId']
  sourceRequestRef: string
}): string {
  return digestCanonicalJson({
    principalId: input.principalId,
    sourceRequestRef: input.sourceRequestRef,
  })
}
function eventIdentity(value: Omit<RequestObligationEventV1, 'eventId'>): string {
  return digestCanonicalJson(value)
}
function allowedTransition(
  from: RequestObligationStatusV1,
  to: Exclude<RequestObligationStatusV1, 'OPEN'>,
): boolean {
  if (from === 'RESOLVED' || from === 'REFUSED') return false
  if (from === 'OPEN') return ['IN_PROGRESS', 'RESOLVED', 'DEFERRED', 'REFUSED'].includes(to)
  if (from === 'IN_PROGRESS') return ['RESOLVED', 'DEFERRED', 'REFUSED'].includes(to)
  return ['IN_PROGRESS', 'RESOLVED', 'REFUSED'].includes(to)
}
function responseRefForStatus(
  status: Exclude<RequestObligationStatusV1, 'OPEN'>,
  value: unknown,
): string | null {
  if (status === 'IN_PROGRESS') {
    if (value !== null && value !== undefined) {
      fail('RESPONSE_REF_REFUSED', 'IN_PROGRESS cannot claim a completed response reference')
    }
    return null
  }
  return canonicalText(value, 'responseRef', 'RESPONSE_REF_REQUIRED')
}

export function createRequestOpenedEventV1(input: {
  actor: TurnActorContext | undefined
  sourceRequestRef: string
  requestText: string
  recordedAt: number
}): RequestOpenedEventV1 {
  const principal = bindAuthenticatedRequestPrincipalV1(input.actor)
  const sourceRequestRef = canonicalText(input.sourceRequestRef, 'sourceRequestRef', 'INVALID_REQUEST')
  const requestText = canonicalText(input.requestText, 'requestText', 'INVALID_REQUEST')
  const recordedAt = timestamp(input.recordedAt, 'recordedAt')
  const requestDigestSha256 = requestDigest(requestText)
  // Stable ingress identity: replaying the same authenticated source request at a
  // later recording time must target the same obligation, never create another one.
  const obligationId = obligationIdentity({
    principalId: principal.principalId,
    sourceRequestRef,
  })
  const body = {
    schemaVersion: 1 as const,
    artifact: REQUEST_OBLIGATION_EVENT_ARTIFACT,
    eventKind: 'REQUEST_OPENED' as const,
    obligationId,
    recordedAt,
    principal,
    sourceRequestRef,
    requestText,
    requestDigestSha256,
    status: 'OPEN' as const,
    previousEventId: null,
    responseRef: null,
    authorityGranted: false as const,
    historicalRequestReusableAsAuthority: false as const,
  }
  return deepFreeze({ ...body, eventId: eventIdentity(body) }) as RequestOpenedEventV1
}

export function createRequestStatusChangedEventV1(input: {
  current: RequestObligationStateV1
  status: Exclude<RequestObligationStatusV1, 'OPEN'>
  recordedAt: number
  responseRef?: string | null
}): RequestStatusChangedEventV1 {
  const current = validateRequestObligationStateV1(input.current)
  const recordedAt = timestamp(input.recordedAt, 'recordedAt')
  if (recordedAt < current.lastRecordedAt) fail('TIME_REGRESSION', 'status change time regresses')
  if (!allowedTransition(current.currentStatus, input.status)) {
    fail('INVALID_TRANSITION', `status transition ${current.currentStatus} -> ${input.status} is refused`)
  }
  const body = {
    schemaVersion: 1 as const,
    artifact: REQUEST_OBLIGATION_EVENT_ARTIFACT,
    eventKind: 'STATUS_CHANGED' as const,
    obligationId: current.obligationId,
    recordedAt,
    fromStatus: current.currentStatus,
    status: input.status,
    previousEventId: current.lastEventId,
    responseRef: responseRefForStatus(input.status, input.responseRef),
    authorityGranted: false as const,
    historicalRequestReusableAsAuthority: false as const,
  }
  return deepFreeze({ ...body, eventId: eventIdentity(body) }) as RequestStatusChangedEventV1
}

export function decodeRequestObligationEventV1(value: unknown): RequestObligationEventV1 {
  rejectAuthority(value, 'request obligation event')
  if (!isRecord(value)) fail('INVALID_EVENT', 'request obligation event must be a plain object')

  if (value.eventKind === 'REQUEST_OPENED') {
    exactKeys(value, [
      'schemaVersion','artifact','eventId','eventKind','obligationId','recordedAt','principal',
      'sourceRequestRef','requestText','requestDigestSha256','status','previousEventId',
      'responseRef','authorityGranted','historicalRequestReusableAsAuthority',
    ], 'REQUEST_OPENED event')
    if (
      value.schemaVersion !== 1 || value.artifact !== REQUEST_OBLIGATION_EVENT_ARTIFACT ||
      value.status !== 'OPEN' || value.previousEventId !== null || value.responseRef !== null ||
      value.authorityGranted !== false || value.historicalRequestReusableAsAuthority !== false
    ) fail('INVALID_EVENT', 'REQUEST_OPENED fixed fields are invalid')

    const principal = parsePrincipalAttribution(value.principal)
    const sourceRequestRef = canonicalText(value.sourceRequestRef, 'sourceRequestRef', 'INVALID_REQUEST')
    const requestText = canonicalText(value.requestText, 'requestText', 'INVALID_REQUEST')
    const recordedAt = timestamp(value.recordedAt, 'recordedAt')
    const requestDigestSha256 = digest(value.requestDigestSha256, 'requestDigestSha256')
    if (requestDigestSha256 !== requestDigest(requestText)) {
      fail('EVENT_ID_MISMATCH', 'request digest does not match exact request text')
    }
    const obligationId = digest(value.obligationId, 'obligationId')
    if (obligationId !== obligationIdentity({
      principalId: principal.principalId,
      sourceRequestRef,
    })) fail('EVENT_ID_MISMATCH', 'obligationId does not match authenticated source request identity')

    const body = {
      schemaVersion: 1 as const,
      artifact: REQUEST_OBLIGATION_EVENT_ARTIFACT,
      eventKind: 'REQUEST_OPENED' as const,
      obligationId,
      recordedAt,
      principal,
      sourceRequestRef,
      requestText,
      requestDigestSha256,
      status: 'OPEN' as const,
      previousEventId: null,
      responseRef: null,
      authorityGranted: false as const,
      historicalRequestReusableAsAuthority: false as const,
    }
    const suppliedId = digest(value.eventId, 'eventId')
    if (suppliedId !== eventIdentity(body)) fail('EVENT_ID_MISMATCH', 'opening eventId mismatch')
    const rebuilt = deepFreeze({ ...body, eventId: suppliedId }) as RequestOpenedEventV1
    if (serializeCanonicalJson(value) !== serializeCanonicalJson(rebuilt)) {
      fail('EVENT_ID_MISMATCH', 'opening event canonical content mismatch')
    }
    return rebuilt
  }

  if (value.eventKind === 'STATUS_CHANGED') {
    exactKeys(value, [
      'schemaVersion','artifact','eventId','eventKind','obligationId','recordedAt','fromStatus',
      'status','previousEventId','responseRef','authorityGranted','historicalRequestReusableAsAuthority',
    ], 'STATUS_CHANGED event')
    if (
      value.schemaVersion !== 1 || value.artifact !== REQUEST_OBLIGATION_EVENT_ARTIFACT ||
      !REQUEST_OBLIGATION_STATUSES.includes(value.fromStatus as RequestObligationStatusV1) ||
      value.status === 'OPEN' ||
      !REQUEST_OBLIGATION_STATUSES.includes(value.status as RequestObligationStatusV1) ||
      value.authorityGranted !== false || value.historicalRequestReusableAsAuthority !== false
    ) fail('INVALID_EVENT', 'STATUS_CHANGED fixed fields are invalid')

    const status = value.status as Exclude<RequestObligationStatusV1, 'OPEN'>
    const body = {
      schemaVersion: 1 as const,
      artifact: REQUEST_OBLIGATION_EVENT_ARTIFACT,
      eventKind: 'STATUS_CHANGED' as const,
      obligationId: digest(value.obligationId, 'obligationId'),
      recordedAt: timestamp(value.recordedAt, 'recordedAt'),
      fromStatus: value.fromStatus as RequestObligationStatusV1,
      status,
      previousEventId: digest(value.previousEventId, 'previousEventId'),
      responseRef: responseRefForStatus(status, value.responseRef),
      authorityGranted: false as const,
      historicalRequestReusableAsAuthority: false as const,
    }
    const suppliedId = digest(value.eventId, 'eventId')
    if (suppliedId !== eventIdentity(body)) fail('EVENT_ID_MISMATCH', 'status eventId mismatch')
    const rebuilt = deepFreeze({ ...body, eventId: suppliedId }) as RequestStatusChangedEventV1
    if (serializeCanonicalJson(value) !== serializeCanonicalJson(rebuilt)) {
      fail('EVENT_ID_MISMATCH', 'status event canonical content mismatch')
    }
    return rebuilt
  }

  return fail('INVALID_EVENT', 'request obligation event kind is unsupported')
}

function stateFromHistory(history: readonly RequestObligationEventV1[]): RequestObligationStateV1 {
  const open = history[0]
  if (!open || open.eventKind !== 'REQUEST_OPENED') {
    fail('MISSING_OPEN_EVENT', 'obligation history must begin with REQUEST_OPENED')
  }
  const last = history[history.length - 1]!
  const latestResponseRef = [...history].reverse()
    .find((event) => event.responseRef !== null)?.responseRef ?? null
  return deepFreeze({
    schemaVersion: 1 as const,
    artifact: 'RequestObligationStateV1' as const,
    obligationId: open.obligationId,
    principal: open.principal,
    sourceRequestRef: open.sourceRequestRef,
    requestText: open.requestText,
    requestDigestSha256: open.requestDigestSha256,
    requestedAt: open.recordedAt,
    currentStatus: last.status,
    lastEventId: last.eventId,
    lastRecordedAt: last.recordedAt,
    latestResponseRef,
    terminal: last.status === 'RESOLVED' || last.status === 'REFUSED',
    history: [...history],
    authorityGranted: false as const,
    historicalRequestReusableAsAuthority: false as const,
  }) as RequestObligationStateV1
}

export function replayRequestObligationLedgerV1(values: readonly unknown[]): readonly RequestObligationStateV1[] {
  if (!Array.isArray(values)) fail('INVALID_EVENT', 'request obligation ledger must be an array')
  const events = values.map(decodeRequestObligationEventV1)
  const eventIds = new Set<string>()
  const histories = new Map<string, RequestObligationEventV1[]>()

  for (const event of events) {
    if (eventIds.has(event.eventId)) fail('DUPLICATE_EVENT', 'duplicate request obligation event')
    eventIds.add(event.eventId)
    const history = histories.get(event.obligationId) ?? []

    if (event.eventKind === 'REQUEST_OPENED') {
      if (history.length > 0) fail('DUPLICATE_OBLIGATION', 'more than one opening event')
      histories.set(event.obligationId, [event])
      continue
    }
    if (history.length === 0) fail('MISSING_OPEN_EVENT', 'status event appears before opening request')
    const current = stateFromHistory(history)
    if (event.previousEventId !== current.lastEventId) {
      fail('PREVIOUS_EVENT_MISMATCH', 'status event does not bind latest event')
    }
    if (event.fromStatus !== current.currentStatus) {
      fail('STATUS_DRIFT', 'status event fromStatus does not match replayed state')
    }
    if (event.recordedAt < current.lastRecordedAt) fail('TIME_REGRESSION', 'status event time regresses')
    if (!allowedTransition(current.currentStatus, event.status)) {
      fail('INVALID_TRANSITION', `replay refuses ${current.currentStatus} -> ${event.status}`)
    }
    histories.set(event.obligationId, [...history, event])
  }

  return deepFreeze([...histories.values()]
    .map(stateFromHistory)
    .sort((a, b) => a.requestedAt - b.requestedAt || a.obligationId.localeCompare(b.obligationId)))
}

export function validateRequestObligationStateV1(value: RequestObligationStateV1 | unknown): RequestObligationStateV1 {
  rejectAuthority(value, 'obligation state')
  if (!isRecord(value) || value.schemaVersion !== 1 || value.artifact !== 'RequestObligationStateV1' || !Array.isArray(value.history)) {
    fail('INVALID_EVENT', 'obligation state fixed fields are invalid')
  }
  const replayed = replayRequestObligationLedgerV1(value.history)
  if (replayed.length !== 1) fail('INVALID_EVENT', 'state history must replay to exactly one obligation')
  const canonical = replayed[0]!
  if (serializeCanonicalJson(value) !== serializeCanonicalJson(canonical)) {
    fail('INVALID_EVENT', 'obligation state does not match canonical replay')
  }
  return canonical
}

export function getRequestObligationV1(values: readonly unknown[], obligationIdValue: string | unknown): RequestObligationStateV1 {
  const obligationId = digest(obligationIdValue, 'obligationId')
  const state = replayRequestObligationLedgerV1(values).find((item) => item.obligationId === obligationId)
  if (!state) fail('OBLIGATION_NOT_FOUND', 'obligation is absent from supplied ledger')
  return state
}

/** Bounded unresolved-work query. OPEN, IN_PROGRESS, and DEFERRED remain unresolved. */
export function queryUnresolvedPrincipalObligationsV1(
  values: readonly unknown[],
  principalIdValue: RequestPrincipalAttributionV1['principalId'] | unknown,
  limitValue: number | unknown,
): UnresolvedPrincipalObligationsV1 {
  if (principalIdValue !== 'telegram:system-owner' && principalIdValue !== 'local:principal-operator') {
    fail('INVALID_PRINCIPAL_ID', 'unsupported unresolved-query principal id')
  }
  if (typeof limitValue !== 'number' || !Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    fail('INVALID_QUERY_LIMIT', 'query limit must be an integer in [1,100]')
  }
  const unresolved = replayRequestObligationLedgerV1(values)
    .filter((state) =>
      state.principal.principalId === principalIdValue &&
      state.currentStatus !== 'RESOLVED' &&
      state.currentStatus !== 'REFUSED')
    .sort((a, b) => a.requestedAt - b.requestedAt || a.obligationId.localeCompare(b.obligationId))

  return deepFreeze({
    schemaVersion: 1 as const,
    artifact: 'UnresolvedPrincipalObligationsV1' as const,
    principalId: principalIdValue,
    limit: limitValue,
    totalUnresolved: unresolved.length,
    truncated: unresolved.length > limitValue,
    obligations: unresolved.slice(0, limitValue),
    authorityGranted: false as const,
    historicalRequestReusableAsAuthority: false as const,
  }) as UnresolvedPrincipalObligationsV1
}

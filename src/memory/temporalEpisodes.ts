import { digestCanonicalJson } from './developmentalMemory.js'
import {
  compareTemporalContinuityEventsV1,
  decodeTemporalContinuityEventV1,
  knowledgeAtV1,
  type TemporalContinuityEventV1,
  type TemporalKnowledgeProjectionV1,
} from './temporalContinuity.js'

export const TEMPORAL_EPISODE_SCHEMA_VERSION = 1 as const

export type TemporalEpisodeMomentOrderV1 =
  | 'SINGLE_EVENT'
  | 'COTEMPORAL_UNORDERED'

export interface TemporalEpisodeMomentV1 {
  readonly knownAt: number
  readonly order: TemporalEpisodeMomentOrderV1
  readonly events: readonly TemporalContinuityEventV1[]
}

export interface TemporalEpisodeSourceCoverageV1 {
  readonly store: TemporalContinuityEventV1['source']['store']
  readonly provenance: TemporalContinuityEventV1['source']['provenance']
  readonly eventCount: number
  readonly recordIds: readonly string[]
}

export interface TemporalEpisodeGapV1 {
  readonly kind: 'EXPECTED_EVENT_MISSING'
  readonly expectedEventId: string
  /** Explicit query expectation only; never inferred from elapsed time or prose. */
  readonly basis: 'EXPLICIT_EXPECTATION'
}

export interface TemporalEpisodeGapAssessmentV1 {
  readonly basis: 'NONE' | 'EXPLICIT_EXPECTATION'
  readonly status: 'NOT_ASSESSED' | 'EXPECTATION_SATISFIED' | 'EXPLICIT_GAPS_PRESENT'
  readonly gaps: readonly TemporalEpisodeGapV1[]
  /** P2 never upgrades a caller expectation into proof that an episode is complete. */
  readonly completenessProven: false
}

export interface TemporalEpisodeProjectionV1 {
  readonly schemaVersion: typeof TEMPORAL_EPISODE_SCHEMA_VERSION
  readonly artifact: 'TemporalEpisodeProjectionV1'
  readonly projectionId: string
  readonly episodeId: string
  readonly eventIds: readonly string[]
  readonly events: readonly TemporalContinuityEventV1[]
  readonly moments: readonly TemporalEpisodeMomentV1[]
  readonly sourceCoverage: readonly TemporalEpisodeSourceCoverageV1[]
  readonly knownAtRange: {
    readonly first: number
    readonly last: number
  }
  readonly occurredAtRange: {
    readonly firstKnown: number | null
    readonly lastKnown: number | null
    readonly unknownCount: number
  }
  readonly gapAssessment: TemporalEpisodeGapAssessmentV1
  readonly causation: 'UNPROVEN'
  readonly authorityGranted: false
}

export interface HistoricalEpisodeStateV1 {
  readonly schemaVersion: typeof TEMPORAL_EPISODE_SCHEMA_VERSION
  readonly artifact: 'HistoricalEpisodeStateV1'
  readonly episodeId: string
  readonly asOf: number
  /** P1 epistemic partition restricted to this episode. Future events remain explicitly unavailable. */
  readonly knowledge: TemporalKnowledgeProjectionV1
  readonly knownMoments: readonly TemporalEpisodeMomentV1[]
  readonly gapAssessment: TemporalEpisodeGapAssessmentV1
  readonly causation: 'UNPROVEN'
  readonly authorityGranted: false
}

export interface TemporalEpisodeAroundEventV1 {
  readonly schemaVersion: typeof TEMPORAL_EPISODE_SCHEMA_VERSION
  readonly artifact: 'TemporalEpisodeAroundEventV1'
  readonly episodeId: string
  readonly anchor: TemporalContinuityEventV1
  readonly before: readonly TemporalContinuityEventV1[]
  readonly coTemporalUnordered: readonly TemporalContinuityEventV1[]
  readonly after: readonly TemporalContinuityEventV1[]
  readonly gapAssessment: TemporalEpisodeGapAssessmentV1
  readonly ordering: {
    readonly causal: false
    readonly rule: 'KNOWN_AT_OBSERVED_AT_OCCURRED_AT_EVENT_ID'
    readonly coTemporalOrder: 'UNPROVEN'
  }
  readonly authorityGranted: false
}

export type TemporalEpisodeErrorCode =
  | 'INVALID_EVENTS'
  | 'DUPLICATE_EVENT'
  | 'INVALID_EPISODE_ID'
  | 'EPISODE_NOT_FOUND'
  | 'INVALID_EXPECTED_EVENT_ID'
  | 'DUPLICATE_EXPECTED_EVENT_ID'
  | 'ANCHOR_NOT_FOUND'

export class TemporalEpisodeError extends Error {
  constructor(
    public readonly code: TemporalEpisodeErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'TemporalEpisodeError'
  }
}

const SHA256 = /^[a-f0-9]{64}$/

function fail(code: TemporalEpisodeErrorCode, message: string): never {
  throw new TemporalEpisodeError(code, message)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('INVALID_EPISODE_ID', `${label} must be non-empty canonical text`)
  }
  return value
}

function safeTime(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_EVENTS', `${label} must be a non-negative safe integer`)
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

function canonicalEvents(values: readonly unknown[]): TemporalContinuityEventV1[] {
  if (!Array.isArray(values)) fail('INVALID_EVENTS', 'events must be an array')
  const events = values.map((value) => decodeTemporalContinuityEventV1(value))
    .sort(compareTemporalContinuityEventsV1)
  const ids = events.map((event) => event.eventId)
  if (new Set(ids).size !== ids.length) {
    fail('DUPLICATE_EVENT', 'episode projection refuses duplicate temporal events')
  }
  return events
}

function expectedIds(values: readonly unknown[] | undefined): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) {
    fail('INVALID_EXPECTED_EVENT_ID', 'expectedEventIds must be an array when supplied')
  }
  const ids = values.map((value, index) => {
    if (typeof value !== 'string' || !SHA256.test(value)) {
      fail('INVALID_EXPECTED_EVENT_ID', `expectedEventIds[${index}] must be lowercase SHA-256 hex`)
    }
    return value
  }).sort()
  if (new Set(ids).size !== ids.length) {
    fail('DUPLICATE_EXPECTED_EVENT_ID', 'expectedEventIds contains duplicates')
  }
  return ids
}

function buildMoments(events: readonly TemporalContinuityEventV1[]): TemporalEpisodeMomentV1[] {
  const byKnownAt = new Map<number, TemporalContinuityEventV1[]>()
  for (const event of events) {
    const group = byKnownAt.get(event.knownAt) ?? []
    group.push(event)
    byKnownAt.set(event.knownAt, group)
  }

  return [...byKnownAt.entries()]
    .sort(([left], [right]) => left - right)
    .map(([knownAt, members]) => {
      const ordered = [...members].sort(compareTemporalContinuityEventsV1)
      return {
        knownAt,
        order: ordered.length === 1 ? 'SINGLE_EVENT' : 'COTEMPORAL_UNORDERED',
        events: ordered,
      } as TemporalEpisodeMomentV1
    })
}

function buildSourceCoverage(events: readonly TemporalContinuityEventV1[]): TemporalEpisodeSourceCoverageV1[] {
  const groups = new Map<string, {
    store: TemporalContinuityEventV1['source']['store']
    provenance: TemporalContinuityEventV1['source']['provenance']
    recordIds: string[]
  }>()

  for (const event of events) {
    const key = `${event.source.store}\u0000${event.source.provenance}`
    const existing = groups.get(key) ?? {
      store: event.source.store,
      provenance: event.source.provenance,
      recordIds: [],
    }
    existing.recordIds.push(event.source.recordId)
    groups.set(key, existing)
  }

  return [...groups.values()]
    .map((group) => ({
      store: group.store,
      provenance: group.provenance,
      eventCount: group.recordIds.length,
      recordIds: [...group.recordIds].sort(),
    }))
    .sort((left, right) =>
      left.store.localeCompare(right.store) || left.provenance.localeCompare(right.provenance))
}

function assessGaps(
  events: readonly TemporalContinuityEventV1[],
  expectedEventIds: readonly unknown[] | undefined,
): TemporalEpisodeGapAssessmentV1 {
  const expected = expectedIds(expectedEventIds)
  if (expectedEventIds === undefined) {
    return {
      basis: 'NONE',
      status: 'NOT_ASSESSED',
      gaps: [],
      completenessProven: false,
    }
  }

  const present = new Set(events.map((event) => event.eventId))
  const gaps = expected
    .filter((eventId) => !present.has(eventId))
    .map((eventId) => ({
      kind: 'EXPECTED_EVENT_MISSING' as const,
      expectedEventId: eventId,
      basis: 'EXPLICIT_EXPECTATION' as const,
    }))

  return {
    basis: 'EXPLICIT_EXPECTATION',
    status: gaps.length === 0 ? 'EXPECTATION_SATISFIED' : 'EXPLICIT_GAPS_PRESENT',
    gaps,
    completenessProven: false,
  }
}

function buildEpisode(
  events: readonly TemporalContinuityEventV1[],
  episodeId: string,
  expectedEventIds?: readonly unknown[],
): TemporalEpisodeProjectionV1 {
  if (events.length === 0) fail('EPISODE_NOT_FOUND', `episode not found: ${episodeId}`)
  const ordered = [...events].sort(compareTemporalContinuityEventsV1)
  const occurred = ordered
    .map((event) => event.occurredAt)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)

  const body = {
    schemaVersion: TEMPORAL_EPISODE_SCHEMA_VERSION,
    artifact: 'TemporalEpisodeProjectionV1' as const,
    episodeId,
    eventIds: ordered.map((event) => event.eventId),
    events: ordered,
    moments: buildMoments(ordered),
    sourceCoverage: buildSourceCoverage(ordered),
    knownAtRange: {
      first: ordered[0]!.knownAt,
      last: ordered[ordered.length - 1]!.knownAt,
    },
    occurredAtRange: {
      firstKnown: occurred[0] ?? null,
      lastKnown: occurred[occurred.length - 1] ?? null,
      unknownCount: ordered.length - occurred.length,
    },
    gapAssessment: assessGaps(ordered, expectedEventIds),
    causation: 'UNPROVEN' as const,
    authorityGranted: false as const,
  }

  const projectionId = digestCanonicalJson(body)
  return deepFreeze({ ...body, projectionId }) as TemporalEpisodeProjectionV1
}

/**
 * Group canonical P1 events by their already-established episodeId.
 * P2 never invents episode membership from prose, time distance, correlation, or similarity.
 */
export function stitchTemporalEpisodesV1(
  values: readonly unknown[],
): readonly TemporalEpisodeProjectionV1[] {
  const events = canonicalEvents(values)
  const groups = new Map<string, TemporalContinuityEventV1[]>()
  for (const event of events) {
    const group = groups.get(event.episodeId) ?? []
    group.push(event)
    groups.set(event.episodeId, group)
  }

  return deepFreeze(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([episodeId, members]) => buildEpisode(members, episodeId)),
  )
}

/**
 * Rebuild one episode, optionally assessing only caller-declared expected event ids.
 * Satisfied expectations still do not prove episode completeness.
 */
export function stitchTemporalEpisodeV1(
  values: readonly unknown[],
  episodeIdValue: string | unknown,
  expectedEventIds?: readonly unknown[],
): TemporalEpisodeProjectionV1 {
  const episodeId = text(episodeIdValue, 'episodeId')
  const events = canonicalEvents(values).filter((event) => event.episodeId === episodeId)
  return buildEpisode(events, episodeId, expectedEventIds)
}

/**
 * Historical epistemic state for one episode. This reuses P1 knowledgeAtV1, so events
 * learned after asOf remain in the explicit future partition and cannot enter known state.
 */
export function historicalEpisodeStateAtV1(
  values: readonly unknown[],
  episodeIdValue: string | unknown,
  asOfValue: number | unknown,
  expectedEventIds?: readonly unknown[],
): HistoricalEpisodeStateV1 {
  const episodeId = text(episodeIdValue, 'episodeId')
  const asOf = safeTime(asOfValue, 'asOf')
  const episode = stitchTemporalEpisodeV1(values, episodeId, expectedEventIds)
  const knowledge = knowledgeAtV1(episode.events, asOf)

  return deepFreeze({
    schemaVersion: TEMPORAL_EPISODE_SCHEMA_VERSION,
    artifact: 'HistoricalEpisodeStateV1' as const,
    episodeId,
    asOf,
    knowledge,
    knownMoments: buildMoments(knowledge.known),
    gapAssessment: episode.gapAssessment,
    causation: 'UNPROVEN' as const,
    authorityGranted: false as const,
  }) as HistoricalEpisodeStateV1
}

/**
 * Answer "what happened around X?" structurally, not narratively.
 * Same-knownAt events remain unordered and temporal position never implies causation.
 */
export function reconstructEpisodeAroundEventV1(
  values: readonly unknown[],
  anchorEventIdValue: string | unknown,
  expectedEventIds?: readonly unknown[],
): TemporalEpisodeAroundEventV1 {
  if (typeof anchorEventIdValue !== 'string' || !SHA256.test(anchorEventIdValue)) {
    fail('ANCHOR_NOT_FOUND', 'anchorEventId must be lowercase SHA-256 hex')
  }

  const events = canonicalEvents(values)
  const anchor = events.find((event) => event.eventId === anchorEventIdValue)
  if (!anchor) fail('ANCHOR_NOT_FOUND', 'anchor event is absent from supplied temporal events')

  const episode = buildEpisode(
    events.filter((event) => event.episodeId === anchor.episodeId),
    anchor.episodeId,
    expectedEventIds,
  )

  return deepFreeze({
    schemaVersion: TEMPORAL_EPISODE_SCHEMA_VERSION,
    artifact: 'TemporalEpisodeAroundEventV1' as const,
    episodeId: anchor.episodeId,
    anchor,
    before: episode.events.filter((event) => event.knownAt < anchor.knownAt),
    coTemporalUnordered: episode.events.filter(
      (event) => event.eventId !== anchor.eventId && event.knownAt === anchor.knownAt,
    ),
    after: episode.events.filter((event) => event.knownAt > anchor.knownAt),
    gapAssessment: episode.gapAssessment,
    ordering: {
      causal: false as const,
      rule: 'KNOWN_AT_OBSERVED_AT_OCCURRED_AT_EVENT_ID' as const,
      coTemporalOrder: 'UNPROVEN' as const,
    },
    authorityGranted: false as const,
  }) as TemporalEpisodeAroundEventV1
}

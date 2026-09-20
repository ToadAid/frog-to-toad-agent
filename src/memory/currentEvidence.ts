import type { Config } from '../config.js'
import {
  calculateFreshness,
  perpsMarketSnapshotSchema,
  type PerpsMarketSnapshot,
  type PerpsDirection,
  type PerpsSetup,
} from './perpsEvidenceModel.js'
import type { ApplicabilityEvidenceFact } from './applicability.js'
import {
  resolveValidatedCanonicalEvidence,
} from './canonicalEvidence.js'
import {
  CANONICAL_TRADING_EVIDENCE_SOURCES,
  type CanonicalTradingEvidenceRecord,
} from './developmentalMemory.js'

export const CURRENT_APPLICABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION = 1 as const

export const SUPPORTED_CURRENT_EVIDENCE_SOURCES = [
  'perps-signal-journal',
] as const

export type SupportedCurrentEvidenceSource =
  typeof SUPPORTED_CURRENT_EVIDENCE_SOURCES[number]

export interface CurrentApplicabilityEvidenceSourceMetadata {
  readonly canonicalReference: CanonicalTradingEvidenceRecord
  readonly observationTimeSource: PerpsMarketSnapshot['observationTimeSource']
  readonly receivedAt: number
  readonly retrievedAt: number
  readonly marketProvenance: PerpsMarketSnapshot['provenance']
  readonly signalProvenance: {
    readonly provider: string
    readonly taSource: string
  }
  readonly sourceFreshness: PerpsMarketSnapshot['freshness']
}

export interface CurrentApplicabilityEvidenceProjection {
  readonly schemaVersion:
    typeof CURRENT_APPLICABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION
  readonly applicabilityFact: ApplicabilityEvidenceFact
  readonly sourceMetadata: CurrentApplicabilityEvidenceSourceMetadata
  readonly authorityGranted: false
}

export type CurrentEvidenceProjectionErrorCode =
  | 'UNSUPPORTED_CURRENT_EVIDENCE_SOURCE'
  | 'INCONSISTENT_SOURCE_FRESHNESS'
  | 'INCONSISTENT_CURRENT_EVIDENCE_RECORD'

export class CurrentEvidenceProjectionError extends Error {
  constructor(
    public readonly code: CurrentEvidenceProjectionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'CurrentEvidenceProjectionError'
  }
}

const CANONICAL_SOURCES = new Set<string>(CANONICAL_TRADING_EVIDENCE_SOURCES)

function fail(code: CurrentEvidenceProjectionErrorCode, message: string): never {
  throw new CurrentEvidenceProjectionError(code, message)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSignalProvenance(value: unknown): {
  readonly provider: string
  readonly taSource: string
} {
  if (
    !isRecord(value) ||
    typeof value.provider !== 'string' ||
    value.provider.trim() === '' ||
    typeof value.taSource !== 'string' ||
    value.taSource.trim() === ''
  ) {
    return fail(
      'INCONSISTENT_CURRENT_EVIDENCE_RECORD',
      'validated perps signal provenance is unavailable',
    )
  }
  return { provider: value.provider, taSource: value.taSource }
}

function readDirection(value: unknown): PerpsDirection {
  if (value !== 'LONG' && value !== 'SHORT' && value !== 'FLAT') {
    return fail(
      'INCONSISTENT_CURRENT_EVIDENCE_RECORD',
      'validated perps signal direction is unavailable',
    )
  }
  return value
}

function readSetup(value: unknown): PerpsSetup {
  if (value !== 'A' && value !== 'B' && value !== 'NONE') {
    return fail(
      'INCONSISTENT_CURRENT_EVIDENCE_RECORD',
      'validated perps signal setup is unavailable',
    )
  }
  return value
}

/**
 * Project one already-canonical perps signal journal record into the exact P2A
 * evidence envelope. This adapter performs no network access, clock reads, or
 * writes and grants no trading authority.
 */
export function projectCurrentApplicabilityEvidence(
  cfg: Config,
  sourceValue: unknown,
  recordId: string,
): Readonly<CurrentApplicabilityEvidenceProjection> {
  if (
    typeof sourceValue === 'string' &&
    CANONICAL_SOURCES.has(sourceValue) &&
    sourceValue !== 'perps-signal-journal'
  ) {
    return fail(
      'UNSUPPORTED_CURRENT_EVIDENCE_SOURCE',
      `${sourceValue} does not contain a canonical current-market freshness contract`,
    )
  }

  const resolved = resolveValidatedCanonicalEvidence(cfg, sourceValue, recordId)
  if (resolved.reference.source !== 'perps-signal-journal') {
    return fail(
      'UNSUPPORTED_CURRENT_EVIDENCE_SOURCE',
      `${resolved.reference.source} is not supported for current applicability evidence`,
    )
  }

  const snapshotResult = perpsMarketSnapshotSchema.safeParse(
    resolved.value.marketSense,
  )
  if (!snapshotResult.success) {
    return fail(
      'INCONSISTENT_CURRENT_EVIDENCE_RECORD',
      'validated perps signal market sense is unavailable',
    )
  }
  const snapshot = snapshotResult.data
  const instrument = resolved.value.instrument
  if (typeof instrument !== 'string' || instrument !== snapshot.instrument) {
    return fail(
      'INCONSISTENT_CURRENT_EVIDENCE_RECORD',
      'signal instrument must exactly match its market-sense instrument',
    )
  }

  const expectedFreshness = calculateFreshness(
    snapshot.observedAt,
    snapshot.retrievedAt,
    snapshot.freshness.maxAgeMs,
  )
  if (
    snapshot.freshness.state !== expectedFreshness.state ||
    snapshot.freshness.ageMs !== expectedFreshness.ageMs ||
    snapshot.freshness.maxAgeMs !== expectedFreshness.maxAgeMs
  ) {
    return fail(
      'INCONSISTENT_SOURCE_FRESHNESS',
      'stored snapshot freshness disagrees with deterministic recomputation',
    )
  }

  const direction = readDirection(resolved.value.direction)
  const setup = readSetup(resolved.value.setup)
  const signalProvenance = readSignalProvenance(resolved.value.provenance)
  const applicabilityFact: ApplicabilityEvidenceFact = {
    evidenceReference: resolved.reference,
    observedAt: snapshot.observedAt,
    maxAgeMs: snapshot.freshness.maxAgeMs,
    context: {
      instrument,
      direction: { domain: 'PERP_DIRECTION', value: direction },
      setup,
    },
    authorityGranted: false,
  }

  return deepFreeze({
    schemaVersion: CURRENT_APPLICABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION,
    applicabilityFact,
    sourceMetadata: {
      canonicalReference: resolved.reference,
      observationTimeSource: snapshot.observationTimeSource,
      receivedAt: snapshot.receivedAt,
      retrievedAt: snapshot.retrievedAt,
      marketProvenance: snapshot.provenance,
      signalProvenance,
      sourceFreshness: snapshot.freshness,
    },
    authorityGranted: false,
  })
}

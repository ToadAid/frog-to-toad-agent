import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { assessDevelopmentalMemoryApplicability } from '../src/memory/applicability.js'
import type { CurrentApplicabilityEvidenceProjection } from '../src/memory/currentEvidence.js'
import { projectCurrentApplicabilityEvidence } from '../src/memory/currentEvidence.js'
import {
  TemporalEvidenceError,
  assessDevelopmentalMemoryApplicabilityAsOf,
  temporalizeCurrentApplicabilityEvidence,
  type TemporalApplicabilityAsOfInput,
  type TemporalApplicabilityEvidence,
  type TemporalInstant,
} from '../src/memory/temporalEvidence.js'
import {
  createDevelopmentalMemoryStore,
  developMemory,
  type CanonicalTradingEvidenceRecord,
  type DevelopmentalMemoryRevision,
} from '../src/memory/developmentalMemory.js'

const OBSERVED_AT = 1_000
const RECEIVED_AT = 1_010
const RECORDED_AT = 1_030
const MAX_AGE_MS = 1_000
const HASH = 'a'.repeat(64)

let root: string
let cfg: Config

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-temporal-evidence-'))
  process.env.TRADING_DESK_DIR = root
  process.env.SELFTEST = '1'
  cfg = loadConfig()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fs.rmSync(root, { recursive: true, force: true })
})

function reference(recordId = 'perps:BTC-PERP:900'): CanonicalTradingEvidenceRecord {
  return {
    source: 'perps-signal-journal',
    recordId,
    cycleId: recordId,
    contentDigestSha256: HASH,
  }
}

function revision(): DevelopmentalMemoryRevision {
  const historical = {
    source: 'journal' as const,
    recordId: 'journal:1',
    cycleId: 'historical-cycle',
    contentDigestSha256: 'b'.repeat(64),
  }
  const outcome = developMemory(
    createDevelopmentalMemoryStore(),
    [historical],
    {
      schemaVersion: 1,
      proposalId: 'proposal-temporal-contract',
      memoryId: 'memory-temporal-contract',
      previousRevisionId: null,
      kind: 'lesson',
      summary: 'Apply only evidence available at the requested cutoff.',
      supportingEvidence: [{ ...historical, role: 'supports' }],
      contradictingEvidence: [],
      authorityGranted: false,
    },
    {
      maximumMemories: 1,
      maximumRevisions: 1,
      maximumEvidencePerMemory: 1,
      maximumSummaryCharacters: 100,
    },
  )
  if (outcome.status !== 'developed') throw new Error(outcome.reason)
  return outcome.revision
}

function projection(overrides: {
  observedAt?: number
  receivedAt?: number
  retrievedAt?: number
  maxAgeMs?: number
  recordId?: string
  cycleId?: string
  contentDigestSha256?: string
} = {}): CurrentApplicabilityEvidenceProjection {
  const observedAt = overrides.observedAt ?? OBSERVED_AT
  const receivedAt = overrides.receivedAt ?? RECEIVED_AT
  const retrievedAt = overrides.retrievedAt ?? receivedAt
  const maxAgeMs = overrides.maxAgeMs ?? MAX_AGE_MS
  const canonicalReference = {
    ...reference(overrides.recordId),
    ...(overrides.cycleId === undefined ? {} : { cycleId: overrides.cycleId }),
    ...(overrides.contentDigestSha256 === undefined
      ? {}
      : { contentDigestSha256: overrides.contentDigestSha256 }),
  }
  return {
    schemaVersion: 1,
    applicabilityFact: {
      evidenceReference: canonicalReference,
      observedAt,
      maxAgeMs,
      context: {
        instrument: 'BTC-PERP',
        direction: { domain: 'PERP_DIRECTION', value: 'LONG' },
        setup: 'A',
      },
      authorityGranted: false,
    },
    sourceMetadata: {
      canonicalReference,
      observationTimeSource: observedAt === receivedAt ? 'RECEIPT' : 'PROVIDER',
      receivedAt,
      retrievedAt,
      marketProvenance: {
        provider: 'fixture-market',
        endpoint: 'https://example.test/market',
        requestType: 'MARKET_SNAPSHOT',
      },
      signalProvenance: { provider: 'fixture-signal', taSource: 'fixture-ta' },
      sourceFreshness: {
        state: retrievedAt - observedAt <= maxAgeMs ? 'FRESH' : 'STALE',
        ageMs: retrievedAt - observedAt,
        maxAgeMs,
      },
    },
    authorityGranted: false,
  }
}

function temporal(
  recordingTime: TemporalInstant = { kind: 'KNOWN', at: RECORDED_AT },
  projectionValue = projection(),
): TemporalApplicabilityEvidence {
  return temporalizeCurrentApplicabilityEvidence(
    projectionValue,
    recordingTime,
  )
}

function request(
  evidence: TemporalApplicabilityEvidence[] = [temporal()],
  overrides: Partial<TemporalApplicabilityAsOfInput> = {},
): TemporalApplicabilityAsOfInput {
  const assessedRevision = revision()
  return {
    revision: assessedRevision,
    latestRevisionId: assessedRevision.revisionId,
    scope: {
      instrument: 'BTC-PERP',
      direction: { domain: 'PERP_DIRECTION', value: 'LONG' },
      setup: 'A',
    },
    temporalEvidence: evidence,
    asOf: RECORDED_AT,
    assessedAt: RECORDED_AT,
    ...overrides,
  }
}

function assess(
  evidence?: TemporalApplicabilityEvidence[],
  overrides?: Partial<TemporalApplicabilityAsOfInput>,
) {
  return assessDevelopmentalMemoryApplicabilityAsOf(
    request(evidence, overrides),
  )
}

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T

function mutable<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(TemporalEvidenceError)
    expect((error as TemporalEvidenceError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

function legacyPrior(
  evidence: TemporalApplicabilityEvidence,
  assessedAt: number,
) {
  const base = request([evidence])
  return assessDevelopmentalMemoryApplicability({
    revision: base.revision,
    latestRevisionId: base.revision.revisionId,
    scope: base.scope,
    evidenceFacts: [evidence.applicabilityFact],
    assessedAt,
  })
}

function canonicalSignalRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    key: 'perps:BTC-PERP:900',
    instrument: 'BTC-PERP',
    evaluationAnchor: 900,
    createdAt: 1_020,
    direction: 'LONG',
    setup: 'A',
    entryMark: 100,
    referenceMark: 99,
    thesis: 'canonical temporal fixture',
    invalidation: 95,
    target: 110,
    marketSense: {
      schemaVersion: 1,
      instrument: 'BTC-PERP',
      observedAt: OBSERVED_AT,
      observationTimeSource: 'PROVIDER',
      receivedAt: RECEIVED_AT,
      retrievedAt: RECEIVED_AT,
      markPrice: 100,
      referencePrice: { kind: 'ORACLE', value: 99 },
      basis: {
        definition: 'MARK_MINUS_REFERENCE',
        absolute: 1,
        ratio: 1 / 99,
        ratioUnit: 'DECIMAL_FRACTION',
      },
      funding: {
        rate: 0.0001,
        rateUnit: 'DECIMAL_RATE_PER_INTERVAL',
        intervalHours: 1,
        // Scheduled payload metadata is not mapped to evidentiary event time.
        nextFundingAt: 9_000,
      },
      openInterest: { value: 1_000, unit: 'BASE_ASSET' },
      provenance: {
        provider: 'fixture-market',
        endpoint: 'https://example.test/market',
        requestType: 'MARKET_SNAPSHOT',
      },
      freshness: { state: 'FRESH', ageMs: 10, maxAgeMs: MAX_AGE_MS },
    },
    taEvidence: {
      hourlyClose: 100,
      hourlyBollingerWidth: 1,
      hourlyBollingerUpper: 101,
      hourlyBollingerLower: 99,
      hourlyVolume: 150,
      hourlyVolumeAvg: 100,
      hourlyRsi: 50,
      dailyEma20: 100,
      dailyEma50: 90,
    },
    provenance: { provider: 'fixture-signal', taSource: 'fixture-ta' },
    authorityGranted: false,
  }
}

describe('P2C temporal evidence and as-of contract', () => {
  it('requires runtime-valid explicit asOf and assessedAt with no defaults', () => {
    const base = request()
    for (const asOf of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => assessDevelopmentalMemoryApplicabilityAsOf({
        ...base,
        asOf,
      }), 'INVALID_AS_OF')
    }
    for (const assessedAt of [undefined, null, -1, 1.5]) {
      expectCode(() => assessDevelopmentalMemoryApplicabilityAsOf({
        ...base,
        assessedAt,
      }), 'INVALID_ASSESSED_AT')
    }
    expectCode(() => assess(undefined, {
      asOf: RECORDED_AT,
      assessedAt: RECORDED_AT - 1,
    }), 'ASSESSMENT_BEFORE_AS_OF')
  })

  it('refuses malformed timestamps, impossible chronology, and authority', () => {
    const invalidObservation = mutable(temporal())
    invalidObservation.observationTime.at = -1
    expectCode(() => assess([invalidObservation]), 'INVALID_TEMPORAL_EVIDENCE')

    const mismatchedObservation = mutable(temporal())
    mismatchedObservation.observationTime.at += 1
    expectCode(() => assess([mismatchedObservation]), 'INVALID_TEMPORAL_EVIDENCE')

    expectCode(() => temporal(
      { kind: 'KNOWN', at: RECEIVED_AT - 1 },
    ), 'IMPOSSIBLE_CHRONOLOGY')
    expectCode(() => temporal(
      { kind: 'KNOWN', at: OBSERVED_AT - 1 },
      projection({ receivedAt: OBSERVED_AT }),
    ), 'IMPOSSIBLE_CHRONOLOGY')

    const reversed = mutable(temporal())
    reversed.validity = { kind: 'INTERVAL', startAt: 1_001, endAt: 1_000 }
    expectCode(() => assess([reversed]), 'INVALID_TEMPORAL_EVIDENCE')

    const authority = mutable(temporal()) as unknown as {
      authorityGranted: boolean
    }
    authority.authorityGranted = true
    expectCode(() => assess([
      authority as unknown as TemporalApplicabilityEvidence,
    ]), 'AUTHORITY_REQUESTED')
  })

  it('blocks future event, observation, receipt, and recording evidence', () => {
    const futureEvent = mutable(temporal())
    futureEvent.eventTime = { kind: 'POINT', at: 1_005 }
    const eventResult = assess([futureEvent], { asOf: 1_000, assessedAt: 2_000 })
    expect(eventResult.evidenceAssessments[0]).toMatchObject({
      disposition: 'UNAVAILABLE_AS_OF',
      reasons: expect.arrayContaining(['EVENT_AFTER_AS_OF']),
    })

    const futureClosedInterval = mutable(temporal(
      { kind: 'KNOWN', at: 1_300 },
      projection({ receivedAt: 1_200, retrievedAt: 1_200 }),
    ))
    futureClosedInterval.eventTime = {
      kind: 'INTERVAL', startAt: 900, endAt: 1_100,
    }
    expect(assess([futureClosedInterval], {
      asOf: 1_050,
      assessedAt: 2_000,
    }).evidenceAssessments[0]?.reasons).toContain('EVENT_AFTER_AS_OF')

    const futureObservation = temporal(
      { kind: 'KNOWN', at: 2_030 },
      projection({ observedAt: 2_000, receivedAt: 2_010 }),
    )
    const observationResult = assess([futureObservation], {
      asOf: 1_999,
      assessedAt: 3_000,
    })
    expect(observationResult.evidenceAssessments[0]?.reasons).toContain(
      'OBSERVATION_AFTER_AS_OF',
    )

    const receiptResult = assess(undefined, { asOf: 1_005, assessedAt: 2_000 })
    expect(receiptResult.evidenceAssessments[0]?.reasons).toContain(
      'RECEIPT_AFTER_AS_OF',
    )
    const recordingResult = assess(undefined, { asOf: 1_020, assessedAt: 2_000 })
    expect(recordingResult.evidenceAssessments[0]?.reasons).toContain(
      'RECORDING_AFTER_AS_OF',
    )
    for (const result of [eventResult, observationResult, receiptResult, recordingResult]) {
      expect(result.applicability.status).toBe('UNKNOWN')
      expect(result.applicability.evidenceFacts).toEqual([])
    }
  })

  it('admits delayed evidence only when both receipt and recording are known by asOf', () => {
    const beforeReceipt = assess(undefined, { asOf: RECEIVED_AT - 1, assessedAt: 5_000 })
    const beforeRecording = assess(undefined, { asOf: RECORDED_AT - 1, assessedAt: 5_000 })
    const exactRecording = assess(undefined, { asOf: RECORDED_AT, assessedAt: 5_000 })

    expect(beforeReceipt.evidenceAssessments[0]).toMatchObject({
      disposition: 'UNAVAILABLE_AS_OF',
      availabilityAt: RECORDED_AT,
    })
    expect(beforeRecording.evidenceAssessments[0]?.reasons).toContain(
      'RECORDING_AFTER_AS_OF',
    )
    expect(exactRecording.evidenceAssessments[0]).toMatchObject({
      disposition: 'ADMISSIBLE',
      reasons: [],
      availabilityAt: RECORDED_AT,
    })
    expect(exactRecording.applicability.status).toBe('ACTIVE')
  })

  it('keeps missing receipt or recording explicit and never fabricates a substitute', () => {
    const missingRecording = temporal({ kind: 'UNKNOWN' })
    const recordingResult = assess([missingRecording], {
      asOf: 9_000,
      assessedAt: 9_000,
    })
    expect(recordingResult.evidenceAssessments[0]).toMatchObject({
      disposition: 'TEMPORAL_PROOF_UNAVAILABLE',
      reasons: ['RECORDING_UNKNOWN'],
      availabilityAt: null,
    })
    expect(recordingResult.applicability.status).toBe('UNKNOWN')

    const missingReceipt = mutable(temporal())
    missingReceipt.receiptTime = { kind: 'UNKNOWN' }
    const receiptResult = assess([missingReceipt], { asOf: 9_000, assessedAt: 9_000 })
    expect(receiptResult.evidenceAssessments[0]?.reasons).toContain('RECEIPT_UNKNOWN')
    expect(receiptResult.applicability.status).toBe('UNKNOWN')
  })

  it('uses distinct point and inclusive interval rules, including equal and open ends', () => {
    const pointAfter = assess(undefined, { asOf: 1_050, assessedAt: 1_050 })
    expect(pointAfter.evidenceAssessments[0]?.disposition).toBe('ADMISSIBLE')

    const interval = mutable(temporal({ kind: 'KNOWN', at: RECEIVED_AT }))
    interval.validity = { kind: 'INTERVAL', startAt: 990, endAt: 1_010 }
    expect(assess([interval], { asOf: 1_010, assessedAt: 1_010 })
      .evidenceAssessments[0]?.disposition).toBe('ADMISSIBLE')
    expect(assess([interval], { asOf: 1_011, assessedAt: 1_011 })
      .evidenceAssessments[0]).toMatchObject({
        disposition: 'OUTSIDE_VALIDITY',
        reasons: ['AFTER_VALIDITY'],
      })

    const equal = temporal(
      { kind: 'KNOWN', at: OBSERVED_AT },
      projection({ receivedAt: OBSERVED_AT }),
    )
    const equalMutable = mutable(equal)
    equalMutable.validity = {
      kind: 'INTERVAL', startAt: OBSERVED_AT, endAt: OBSERVED_AT,
    }
    expect(assess([equalMutable], {
      asOf: OBSERVED_AT,
      assessedAt: OBSERVED_AT,
    }).evidenceAssessments[0]?.disposition).toBe('ADMISSIBLE')

    const open = mutable(interval)
    open.validity = { kind: 'INTERVAL', startAt: 990, endAt: null }
    expect(assess([open], { asOf: 1_500, assessedAt: 1_500 })
      .evidenceAssessments[0]?.disposition).toBe('ADMISSIBLE')
  })

  it('keeps actual assessment time from widening an earlier cutoff', () => {
    const laterAssessment = assess(undefined, {
      asOf: RECEIVED_AT - 1,
      assessedAt: 50_000,
    })
    expect(laterAssessment.assessedAt).toBe(50_000)
    expect(laterAssessment.asOf).toBe(RECEIVED_AT - 1)
    expect(laterAssessment.applicability.status).toBe('UNKNOWN')
    expect(laterAssessment.evidenceAssessments[0]?.disposition)
      .toBe('UNAVAILABLE_AS_OF')
  })

  describe('prior assessment re-proving', () => {
    it('refuses a legacy ACTIVE prior whose recording occurred after its cutoff', () => {
      const delayed = temporal(
        { kind: 'KNOWN', at: 2_000 },
        projection({ receivedAt: OBSERVED_AT }),
      )
      const unsafePrior = legacyPrior(delayed, OBSERVED_AT)
      expect(unsafePrior.status).toBe('ACTIVE')

      expectCode(() => assess([delayed], {
        asOf: OBSERVED_AT + MAX_AGE_MS + 1,
        assessedAt: 5_000,
        priorAssessment: unsafePrior,
      }), 'UNSAFE_PRIOR_ASSESSMENT')
    })

    it('refuses a prior assessment later than current asOf', () => {
      const immediate = temporal(
        { kind: 'KNOWN', at: OBSERVED_AT },
        projection({ receivedAt: OBSERVED_AT }),
      )
      const laterPrior = legacyPrior(immediate, OBSERVED_AT + 100)
      expectCode(() => assess([immediate], {
        asOf: OBSERVED_AT + 99,
        assessedAt: 5_000,
        priorAssessment: laterPrior,
      }), 'UNSAFE_PRIOR_ASSESSMENT')
    })

    it('allows independently re-proven ACTIVE chronology to become STALE', () => {
      const immediate = temporal(
        { kind: 'KNOWN', at: OBSERVED_AT },
        projection({ receivedAt: OBSERVED_AT }),
      )
      const safePrior = legacyPrior(immediate, OBSERVED_AT)
      const stale = assess([immediate], {
        asOf: OBSERVED_AT + MAX_AGE_MS + 1,
        assessedAt: 5_000,
        priorAssessment: safePrior,
      })
      expect(safePrior.status).toBe('ACTIVE')
      expect(stale.applicability.status).toBe('STALE')
      expect(stale.applicability.firstObservedAt).toBe(OBSERVED_AT)
      expect(stale.applicability.lastConfirmedAt).toBe(OBSERVED_AT)
    })

    it('refuses prior facts without exact matching temporal envelopes', () => {
      const priorEvidence = temporal(
        { kind: 'KNOWN', at: OBSERVED_AT },
        projection({ receivedAt: OBSERVED_AT, recordId: 'prior-only' }),
      )
      const currentEvidence = temporal(
        { kind: 'KNOWN', at: OBSERVED_AT },
        projection({ receivedAt: OBSERVED_AT, recordId: 'current-only' }),
      )
      const prior = legacyPrior(priorEvidence, OBSERVED_AT)
      expectCode(() => assess([currentEvidence], {
        asOf: OBSERVED_AT + 1,
        assessedAt: 5_000,
        priorAssessment: prior,
      }), 'UNSAFE_PRIOR_ASSESSMENT')
    })

    it('refuses tampered and identity-mismatched prior assessments', () => {
      const immediate = temporal(
        { kind: 'KNOWN', at: OBSERVED_AT },
        projection({ receivedAt: OBSERVED_AT }),
      )
      const prior = legacyPrior(immediate, OBSERVED_AT)
      for (const unsafe of [
        { ...prior, status: 'CONTESTED' },
        { ...prior, memoryId: 'other-memory' },
      ]) {
        expectCode(() => assess([immediate], {
          asOf: OBSERVED_AT + 1,
          assessedAt: 5_000,
          priorAssessment: unsafe,
        }), 'UNSAFE_PRIOR_ASSESSMENT')
      }
    })
  })

  it('leaves P2A freshness inclusive and distinct from temporal availability', () => {
    const immediate = temporal(
      { kind: 'KNOWN', at: OBSERVED_AT },
      projection({ receivedAt: OBSERVED_AT }),
    )
    const boundary = assess([immediate], {
      asOf: OBSERVED_AT + MAX_AGE_MS,
      assessedAt: OBSERVED_AT + MAX_AGE_MS,
    })
    const after = assess([immediate], {
      asOf: OBSERVED_AT + MAX_AGE_MS + 1,
      assessedAt: OBSERVED_AT + MAX_AGE_MS + 1,
    })
    expect(boundary.evidenceAssessments[0]?.disposition).toBe('ADMISSIBLE')
    expect(after.evidenceAssessments[0]?.disposition).toBe('ADMISSIBLE')
    expect(boundary.applicability.status).toBe('ACTIVE')
    expect(after.applicability.status).toBe('UNKNOWN')
  })

  it('orders deterministically with stable ties and expressly grants no causality', () => {
    const later = temporal(
      { kind: 'KNOWN', at: 1_200 },
      projection({ observedAt: 1_100, receivedAt: 1_150, recordId: 'z' }),
    )
    const b = temporal(
      { kind: 'KNOWN', at: RECORDED_AT },
      projection({ recordId: 'b' }),
    )
    const a = temporal(
      { kind: 'KNOWN', at: RECORDED_AT },
      projection({ recordId: 'a' }),
    )
    const tiedFirst = mutable(a)
    tiedFirst.applicabilityFact.context = { instrument: 'FIRST' }
    const tiedSecond = mutable(a)
    tiedSecond.applicabilityFact.context = { instrument: 'SECOND' }

    const ordered = assess([later, b, a], { asOf: 2_000, assessedAt: 2_000 })
    expect(ordered.evidenceAssessments.map((item) =>
      item.evidence.applicabilityFact.evidenceReference.recordId))
      .toEqual(['a', 'b', 'z'])
    expect(ordered.ordering).toEqual({
      causal: false,
      rule: 'OBSERVATION_AVAILABILITY_CANONICAL_IDENTITY_INPUT_ORDER',
    })

    const ties = assess([tiedSecond, tiedFirst], { asOf: 2_000, assessedAt: 2_000 })
    expect(ties.evidenceAssessments.map((item) =>
      item.evidence.applicabilityFact.context.instrument))
      .toEqual(['SECOND', 'FIRST'])
  })

  it('uses ordinal full canonical identity ordering for case, Unicode, and cycles', () => {
    const values = [
      projection({ recordId: 'é' }),
      projection({ recordId: 'same', cycleId: 'z-cycle' }),
      projection({ recordId: 'a' }),
      projection({ recordId: 'same', cycleId: 'A-cycle' }),
      projection({ recordId: 'A' }),
    ].map((item) => temporal({ kind: 'KNOWN', at: RECORDED_AT }, item))
    const result = assess(values, { asOf: 2_000, assessedAt: 2_000 })
    expect(result.evidenceAssessments.map(({ evidence }) => {
      const id = evidence.applicabilityFact.evidenceReference
      return `${id.recordId}:${id.cycleId}`
    })).toEqual([
      'A:A',
      'a:a',
      'same:A-cycle',
      'same:z-cycle',
      'é:é',
    ])
  })

  it('rejects missing, malformed, and extra retained P2B provenance fields', () => {
    const missing = mutable(temporal())
    delete (missing.sourceMetadata as unknown as Record<string, unknown>)
      .marketProvenance

    const malformed = mutable(temporal())
    malformed.sourceMetadata.marketProvenance.endpoint = 'not a URL'

    const extra = mutable(temporal())
    ;(extra.sourceMetadata.signalProvenance as unknown as Record<string, unknown>)
      .unexpected = true

    for (const invalid of [missing, malformed, extra]) {
      expectCode(() => assess([
        invalid as TemporalApplicabilityEvidence,
      ]), 'INVALID_TEMPORAL_EVIDENCE')
    }
  })

  it('is repeatable, deeply immutable, and preserves caller-owned inputs', () => {
    const callerEvidence = mutable(temporal())
    const input = request([
      callerEvidence as TemporalApplicabilityEvidence,
    ])
    const before = JSON.stringify(input)
    const left = assessDevelopmentalMemoryApplicabilityAsOf(input)
    const right = assessDevelopmentalMemoryApplicabilityAsOf(input)
    expect(left).toEqual(right)
    expect(left.assessmentId).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(input)).toBe(before)
    expect(Object.isFrozen(left)).toBe(true)
    expect(Object.isFrozen(left.evidenceAssessments)).toBe(true)
    expect(Object.isFrozen(left.evidenceAssessments[0]?.evidence)).toBe(true)
    expect(Object.isFrozen(left.applicability)).toBe(true)
    expect(Object.isFrozen(callerEvidence)).toBe(false)
    expect(Object.isFrozen(callerEvidence.applicabilityFact)).toBe(false)
    expect(left.authorityGranted).toBe(false)
    expect(left.applicability.authorityGranted).toBe(false)
  })

  it('performs no ambient clock, network, or filesystem access in the P2C core', () => {
    const input = request()
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('ambient clock accessed')
    })
    vi.stubGlobal('fetch', () => {
      throw new Error('network accessed')
    })
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('filesystem read')
    })
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('filesystem write')
    })
    expect(() => assessDevelopmentalMemoryApplicabilityAsOf(input)).not.toThrow()
  })

  it('composes actual P2B projection through P2C into P2A without semantic aliases', () => {
    const record = canonicalSignalRecord()
    const target = path.join(cfg.paths.dataDir, 'perps', 'signal-journal.jsonl')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(record)}\n`)
    const p2b = projectCurrentApplicabilityEvidence(
      cfg,
      'perps-signal-journal',
      record.key as string,
    )
    const p2c = temporalizeCurrentApplicabilityEvidence(
      p2b,
      { kind: 'KNOWN', at: RECORDED_AT },
    )
    const result = assess([p2c], { asOf: RECORDED_AT, assessedAt: 9_000 })

    expect(result.applicability.status).toBe('ACTIVE')
    expect(result.applicability.evidenceFacts[0]?.evidenceReference)
      .toEqual(p2b.applicabilityFact.evidenceReference)
    expect(result.evidenceAssessments[0]?.evidence.sourceMetadata).toEqual(
      p2b.sourceMetadata,
    )
    expect(p2c).toMatchObject({
      eventTime: { kind: 'UNKNOWN' },
      observationTime: { kind: 'POINT', at: OBSERVED_AT },
      receiptTime: { kind: 'KNOWN', at: RECEIVED_AT },
      validity: { kind: 'POINT', at: OBSERVED_AT },
      sourceMetadata: {
        retrievedAt: RECEIVED_AT,
        observationTimeSource: 'PROVIDER',
      },
      authorityGranted: false,
    })
    expect(JSON.stringify(p2c)).not.toContain('evaluationAnchor')
    expect(JSON.stringify(p2c)).not.toContain('createdAt')
    expect(record).toMatchObject({
      evaluationAnchor: 900,
      createdAt: 1_020,
      marketSense: { funding: { nextFundingAt: 9_000 } },
    })
  })

  it('blocks P2B composition when durable recording is delayed or unknown', () => {
    const delayed = temporal({ kind: 'KNOWN', at: 2_000 })
    const delayedResult = assess([delayed], { asOf: 1_999, assessedAt: 9_000 })
    const unknownResult = assess([temporal({ kind: 'UNKNOWN' })], {
      asOf: 9_000,
      assessedAt: 9_000,
    })
    expect(delayedResult.evidenceAssessments[0]?.disposition)
      .toBe('UNAVAILABLE_AS_OF')
    expect(unknownResult.evidenceAssessments[0]?.disposition)
      .toBe('TEMPORAL_PROOF_UNAVAILABLE')
    expect(delayedResult.applicability.status).toBe('UNKNOWN')
    expect(unknownResult.applicability.status).toBe('UNKNOWN')
  })
})

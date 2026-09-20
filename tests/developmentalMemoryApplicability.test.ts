import { describe, expect, it } from 'vitest'
import {
  APPLICABILITY_STATUSES,
  ApplicabilityAssessmentError,
  assessDevelopmentalMemoryApplicability,
  type ApplicabilityAssessmentInput,
  type ApplicabilityEvidenceFact,
  type DevelopmentalMemoryApplicability,
  type TradingApplicabilityScope,
} from '../src/memory/applicability.js'
import {
  createDevelopmentalMemoryStore,
  developMemory,
  digestDevelopmentalMemory,
  type CanonicalTradingEvidenceRecord,
  type DevelopmentalMemoryEvidence,
  type DevelopmentalMemoryMaturity,
  type DevelopmentalMemoryRevision,
} from '../src/memory/developmentalMemory.js'

const ASSESSED_AT = 1_000_000
const HASH = 'a'.repeat(64)

function reference(recordId = 'current-1'): CanonicalTradingEvidenceRecord {
  return {
    source: 'perps-signal-journal',
    recordId,
    cycleId: recordId,
    contentDigestSha256: HASH,
  }
}

function revision(
  maturity: DevelopmentalMemoryMaturity = 'consolidated',
  memoryId = 'memory-1',
  variant = 'default',
): DevelopmentalMemoryRevision {
  const supportCount = maturity === 'consolidated'
    ? 3
    : maturity === 'reinforced'
      ? 2
      : 1
  const supporting = Array.from({ length: supportCount }, (_, index) => ({
    source: 'journal' as const,
    recordId: `${variant}-support-${index + 1}`,
    cycleId: `${variant}-cycle-${index + 1}`,
    contentDigestSha256: String(index + 1).repeat(64),
  }))
  const contradicting = maturity === 'contested'
    ? [{
        source: 'journal' as const,
        recordId: `${variant}-contradiction`,
        cycleId: `${variant}-contradiction-cycle`,
        contentDigestSha256: 'f'.repeat(64),
      }]
    : []
  const catalog = [...supporting, ...contradicting]
  const developed = developMemory(
    createDevelopmentalMemoryStore(),
    catalog,
    {
      schemaVersion: 1,
      proposalId: `proposal-${variant}`,
      memoryId,
      previousRevisionId: null,
      kind: 'lesson',
      summary: `Respect the declared setup context (${variant}).`,
      supportingEvidence: supporting.map((item) => ({
        ...item,
        role: 'supports' as const,
      })),
      contradictingEvidence: contradicting.map((item) => ({
        ...item,
        role: 'contradicts' as const,
      })),
      authorityGranted: false,
    },
    {
      maximumMemories: 2,
      maximumRevisions: 2,
      maximumEvidencePerMemory: 4,
      maximumSummaryCharacters: 100,
    },
  )
  if (developed.status !== 'developed') {
    throw new Error(`fixture revision refused: ${developed.reason}`)
  }
  expect(developed.revision.maturity).toBe(maturity)
  return developed.revision
}

function fact(
  context: TradingApplicabilityScope,
  overrides: Partial<ApplicabilityEvidenceFact> = {},
): ApplicabilityEvidenceFact {
  return {
    evidenceReference: reference(),
    observedAt: ASSESSED_AT - 100,
    maxAgeMs: 1_000,
    context,
    authorityGranted: false,
    ...overrides,
  }
}

function input(
  scope: TradingApplicabilityScope = {
    instrument: 'BTC-PERP',
    setup: 'A',
    venue: 'hyperliquid',
  },
  evidenceFacts: ApplicabilityEvidenceFact[] = [],
  overrides: Partial<ApplicabilityAssessmentInput> = {},
): ApplicabilityAssessmentInput {
  const assessedRevision = revision()
  return {
    revision: assessedRevision,
    latestRevisionId: assessedRevision.revisionId,
    scope,
    evidenceFacts,
    assessedAt: ASSESSED_AT,
    ...overrides,
  }
}

function assess(
  scope?: TradingApplicabilityScope,
  evidenceFacts?: ApplicabilityEvidenceFact[],
  overrides?: Partial<ApplicabilityAssessmentInput>,
): Readonly<DevelopmentalMemoryApplicability> {
  return assessDevelopmentalMemoryApplicability(
    input(scope, evidenceFacts, overrides),
  )
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicabilityAssessmentError)
    expect((error as ApplicabilityAssessmentError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('P2A developmental-memory trading applicability contract', () => {
  it('pins exactly the five applicability statuses', () => {
    expect(APPLICABILITY_STATUSES).toEqual([
      'UNKNOWN',
      'ACTIVE',
      'STALE',
      'CONTESTED',
      'SUPERSEDED',
    ])
  })

  describe('separation from historical maturity', () => {
    it('leaves consolidated memory UNKNOWN without current evidence', () => {
      expect(assess().status).toBe('UNKNOWN')
    })

    it('allows tentative memory to be ACTIVE on exact fresh current evidence', () => {
      const assessedRevision = revision('tentative')
      expect(assess(undefined, [fact({
        instrument: 'BTC-PERP', setup: 'A', venue: 'hyperliquid',
      })], { revision: assessedRevision, latestRevisionId: assessedRevision.revisionId }).status)
        .toBe('ACTIVE')
    })

    it('does not turn historical contested maturity into current CONTESTED', () => {
      const assessedRevision = revision('contested')
      expect(assess(undefined, [], {
        revision: assessedRevision,
        latestRevisionId: assessedRevision.revisionId,
      }).status).toBe('UNKNOWN')
    })

    it('does not mutate revision maturity, evidence, or P1 digest', () => {
      const historical = reference('historical')
      const evidence: DevelopmentalMemoryEvidence = { ...historical, role: 'supports' }
      const developed = developMemory(
        createDevelopmentalMemoryStore(),
        [historical],
        {
          schemaVersion: 1,
          proposalId: 'proposal',
          memoryId: 'memory',
          previousRevisionId: null,
          kind: 'lesson',
          summary: 'Historical lesson.',
          supportingEvidence: [evidence],
          contradictingEvidence: [],
          authorityGranted: false,
        },
        {
          maximumMemories: 2,
          maximumRevisions: 2,
          maximumEvidencePerMemory: 2,
          maximumSummaryCharacters: 100,
        },
      )
      expect(developed.status).toBe('developed')
      if (developed.status !== 'developed') return
      const before = digestDevelopmentalMemory(developed.store)
      const maturity = developed.revision.maturity
      const evidenceBefore = JSON.stringify(developed.revision.evidence)

      const result = assess({ instrument: 'BTC-PERP' }, [fact({ instrument: 'BTC-PERP' })], {
        revision: developed.revision,
        latestRevisionId: developed.revision.revisionId,
      })

      expect(result.status).toBe('ACTIVE')
      expect(developed.revision.maturity).toBe(maturity)
      expect(JSON.stringify(developed.revision.evidence)).toBe(evidenceBefore)
      expect(digestDevelopmentalMemory(developed.store)).toBe(before)
    })
  })

  describe('ACTIVE and sparse exact matching', () => {
    it('requires exact fresh proof of every scoped dimension', () => {
      expect(assess(undefined, [fact({
        instrument: 'BTC-PERP', setup: 'A', venue: 'hyperliquid',
      })]).status).toBe('ACTIVE')
    })

    it('supports a one-field scope and ignores unspecified evidence dimensions', () => {
      const result = assess(
        { instrument: 'BTC-PERP' },
        [fact({ instrument: 'BTC-PERP', venue: 'lighter', trendRegime: 'range' })],
      )
      expect(result.status).toBe('ACTIVE')
    })

    it('allows multiple agreeing facts to cover the scope without counting votes', () => {
      const result = assess(undefined, [
        fact({ instrument: 'BTC-PERP', setup: 'A' }, {
          evidenceReference: reference('current-1'),
        }),
        fact({ venue: 'hyperliquid', instrument: 'BTC-PERP' }, {
          evidenceReference: reference('current-2'),
        }),
      ])
      expect(result.status).toBe('ACTIVE')
    })

    it('uses exact case-sensitive matching and never infers venue from chain', () => {
      expect(assess({ venue: 'hyperliquid' }, [fact({ venue: 'Hyperliquid' })]).status)
        .toBe('CONTESTED')
      expect(assess({ venue: 'hyperliquid', chain: 'arbitrum' }, [
        fact({ venue: 'hyperliquid' }),
      ]).status).toBe('UNKNOWN')
    })

    it('never infers chain from venue, direction from setup, or venue from instrument', () => {
      expect(assess({ chain: 'base' }, [fact({ venue: 'base-dex' })]).status)
        .toBe('UNKNOWN')
      expect(assess({ direction: { domain: 'PERP_DIRECTION', value: 'LONG' } }, [
        fact({ setup: 'A' }),
      ]).status).toBe('UNKNOWN')
      expect(assess({ venue: 'hyperliquid' }, [fact({ instrument: 'BTC-PERP' })]).status)
        .toBe('UNKNOWN')
    })

    it('treats regime labels as opaque exact strings', () => {
      expect(assess({ volatilityRegime: 'high-v2' }, [
        fact({ volatilityRegime: 'high-v2' }),
      ]).status).toBe('ACTIVE')
      expect(assess({ fundingRegime: 'positive' }, [
        fact({ fundingRegime: 'POSITIVE' }),
      ]).status).toBe('CONTESTED')
    })

    it('keeps spot and perps direction domains distinct', () => {
      const spot = { domain: 'SPOT_SIGNAL', value: 'BUY' } as const
      const perp = { domain: 'PERP_DIRECTION', value: 'LONG' } as const
      expect(assess({ direction: spot }, [fact({ direction: spot })]).status)
        .toBe('ACTIVE')
      expect(assess({ direction: spot }, [fact({ direction: perp })]).status)
        .toBe('CONTESTED')
    })
  })

  describe('UNKNOWN and CONTESTED', () => {
    it('returns UNKNOWN for no evidence, partial coverage, or missing fields', () => {
      expect(assess().status).toBe('UNKNOWN')
      expect(assess(undefined, [fact({ instrument: 'BTC-PERP' })]).status)
        .toBe('UNKNOWN')
      expect(assess({ setup: 'A' }, [fact({ instrument: 'BTC-PERP' })]).status)
        .toBe('UNKNOWN')
    })

    it('returns UNKNOWN for stale-only evidence never previously ACTIVE', () => {
      expect(assess({ instrument: 'BTC-PERP' }, [fact(
        { instrument: 'BTC-PERP' },
        { observedAt: ASSESSED_AT - 1_001, maxAgeMs: 1_000 },
      )]).status).toBe('UNKNOWN')
    })

    it('returns CONTESTED for one fresh conflicting field', () => {
      expect(assess(undefined, [fact({
        instrument: 'BTC-PERP', setup: 'B', venue: 'hyperliquid',
      })]).status).toBe('CONTESTED')
    })

    it('returns CONTESTED for support plus conflict and never majority-votes', () => {
      const supporting = fact({ instrument: 'BTC-PERP' })
      const conflict = fact({ instrument: 'ETH-PERP' }, {
        evidenceReference: reference('conflict'),
      })
      expect(assess({ instrument: 'BTC-PERP' }, [supporting, conflict]).status)
        .toBe('CONTESTED')
      expect(assess({ instrument: 'BTC-PERP' }, [supporting, supporting, supporting, conflict]).status)
        .toBe('CONTESTED')
    })

    it('returns CONTESTED when fresh facts assert mutually incompatible values', () => {
      expect(assess({ trendRegime: 'trend' }, [
        fact({ trendRegime: 'trend' }),
        fact({ trendRegime: 'range' }, { evidenceReference: reference('range') }),
      ]).status).toBe('CONTESTED')
    })
  })

  describe('freshness, chronology, and supersession', () => {
    it('uses an inclusive deterministic freshness boundary', () => {
      expect(assess({ instrument: 'BTC-PERP' }, [fact(
        { instrument: 'BTC-PERP' },
        { observedAt: ASSESSED_AT - 1_000, maxAgeMs: 1_000 },
      )]).status).toBe('ACTIVE')
      expect(assess({ instrument: 'BTC-PERP' }, [fact(
        { instrument: 'BTC-PERP' },
        { observedAt: ASSESSED_AT - 1_001, maxAgeMs: 1_000 },
      )]).status).toBe('UNKNOWN')
    })

    it('refuses future observations and non-positive maximum ages', () => {
      expectCode(() => assess(undefined, [fact({}, { observedAt: ASSESSED_AT + 1 })]), 'FUTURE_EVIDENCE')
      for (const maxAgeMs of [0, -1]) {
        expectCode(() => assess(undefined, [fact({}, { maxAgeMs })]), 'INVALID_EVIDENCE_FACT')
      }
    })

    it('has no ambient clock dependency', () => {
      const originalNow = Date.now
      Date.now = () => { throw new Error('ambient clock accessed') }
      try {
        expect(assess({ instrument: 'BTC-PERP' }, [fact({ instrument: 'BTC-PERP' })]).status)
          .toBe('ACTIVE')
      } finally {
        Date.now = originalNow
      }
    })

    it('makes an old revision SUPERSEDED despite perfect fresh evidence', () => {
      const result = assess({ instrument: 'BTC-PERP' }, [fact({ instrument: 'BTC-PERP' })], {
        latestRevisionId: 'c'.repeat(64),
      })
      expect(result.status).toBe('SUPERSEDED')
    })

    it('evaluates the latest revision normally', () => {
      expect(assess({ instrument: 'BTC-PERP' }, [fact({ instrument: 'BTC-PERP' })]).status)
        .toBe('ACTIVE')
    })

    it('marks a prior ACTIVE assessment STALE after confirmation ages out', () => {
      const scope = { instrument: 'BTC-PERP' }
      const first = assess(scope, [fact(scope, { observedAt: ASSESSED_AT - 100 })])
      const later = assess(scope, [fact(scope, {
        observedAt: ASSESSED_AT - 100,
        maxAgeMs: 1_000,
      })], {
        assessedAt: ASSESSED_AT + 1_001,
        priorAssessment: first,
      })
      expect(later.status).toBe('STALE')
      expect(later.firstObservedAt).toBe(first.firstObservedAt)
      expect(later.lastConfirmedAt).toBe(first.lastConfirmedAt)
    })

    it('preserves first observation and advances last confirmation monotonically', () => {
      const scope = { instrument: 'BTC-PERP' }
      const first = assess(scope, [fact(scope, { observedAt: ASSESSED_AT - 100 })])
      const laterObservedAt = ASSESSED_AT + 500
      const later = assess(scope, [fact(scope, {
        observedAt: laterObservedAt,
        maxAgeMs: 1_000,
      })], {
        assessedAt: ASSESSED_AT + 600,
        priorAssessment: first,
      })
      expect(later.status).toBe('ACTIVE')
      expect(later.firstObservedAt).toBe(first.firstObservedAt)
      expect(later.lastConfirmedAt).toBe(laterObservedAt)
    })

    it('never moves firstObservedAt backward on a later ACTIVE assessment', () => {
      const scope = { instrument: 'BTC-PERP' }
      const first = assess(scope, [fact(scope, {
        observedAt: 100,
        maxAgeMs: 1_000,
      })], { assessedAt: 200 })
      const later = assess(scope, [fact(scope, {
        observedAt: 50,
        maxAgeMs: 1_000,
      })], {
        assessedAt: 300,
        priorAssessment: first,
      })

      expect(later.status).toBe('ACTIVE')
      expect(first.firstObservedAt).toBe(100)
      expect(later.firstObservedAt).toBe(100)
      expect(later.firstObservedAt).not.toBe(50)
      expect(later.lastConfirmedAt).toBe(100)
    })

    it('refuses assessment time reversal and allows equal replay time', () => {
      const scope = { instrument: 'BTC-PERP' }
      const prior = assess(scope, [fact(scope, {
        observedAt: 100,
        maxAgeMs: 1_000,
      })], { assessedAt: 200 })

      expectCode(() => assess(scope, [], {
        assessedAt: 199,
        priorAssessment: prior,
      }), 'ASSESSMENT_TIME_REVERSED')

      const equalLeft = assess(scope, [fact(scope, {
        observedAt: 100,
        maxAgeMs: 1_000,
      })], {
        assessedAt: 200,
        priorAssessment: prior,
      })
      const equalRight = assess(scope, [fact(scope, {
        observedAt: 100,
        maxAgeMs: 1_000,
      })], {
        assessedAt: 200,
        priorAssessment: prior,
      })
      expect(equalLeft.status).toBe('ACTIVE')
      expect(equalLeft).toEqual(equalRight)
    })

    it('does not advance lastConfirmedAt on fresh conflict', () => {
      const scope = { trendRegime: 'trend' }
      const first = assess(scope, [fact(scope)])
      const contested = assess(scope, [fact({ trendRegime: 'range' }, {
        observedAt: ASSESSED_AT + 100,
      })], {
        assessedAt: ASSESSED_AT + 200,
        priorAssessment: first,
      })
      expect(contested.status).toBe('CONTESTED')
      expect(contested.firstObservedAt).toBe(first.firstObservedAt)
      expect(contested.lastConfirmedAt).toBe(first.lastConfirmedAt)
    })

    it('preserves prior chronology when the revision becomes SUPERSEDED', () => {
      const scope = { instrument: 'BTC-PERP' }
      const first = assess(scope, [fact(scope)])
      const superseded = assess(scope, [fact(scope, { observedAt: ASSESSED_AT + 100 })], {
        assessedAt: ASSESSED_AT + 100,
        latestRevisionId: 'c'.repeat(64),
        priorAssessment: first,
      })
      expect(superseded.status).toBe('SUPERSEDED')
      expect(superseded.firstObservedAt).toBe(first.firstObservedAt)
      expect(superseded.lastConfirmedAt).toBe(first.lastConfirmedAt)
    })
  })

  describe('validation, prior identity, authority, and determinism', () => {
    it('accepts only revisions satisfying the complete P1 revision law', () => {
      const valid = revision('consolidated')
      expect(assess(undefined, [], {
        revision: valid,
        latestRevisionId: valid.revisionId,
      }).status).toBe('UNKNOWN')

      const invalidRevisions = [
        { ...valid, evidence: [] },
        { ...valid, summary: 'Tampered summary with unchanged revision id.' },
        { ...valid, revisionId: 'e'.repeat(64) },
        { ...valid, authorityGranted: true },
        { ...valid, unexpected: true },
      ]
      for (const invalid of invalidRevisions) {
        expectCode(() => assess(undefined, [], {
          revision: invalid as never,
        }), 'INVALID_REVISION')
      }
    })

    it('refuses empty, blank, extra-field, and malformed-direction scopes', () => {
      expectCode(() => assess({}), 'INVALID_SCOPE')
      expectCode(() => assess({ instrument: '  ' }), 'INVALID_SCOPE')
      expectCode(() => assess({ instrument: 'BTC', extra: 'x' } as TradingApplicabilityScope), 'INVALID_SCOPE')
      expectCode(() => assess({ direction: { domain: 'SPOT_SIGNAL', value: 'LONG' } as never }), 'INVALID_SCOPE')
    })

    it.each([
      ['another memory', { memoryId: 'memory-2' }],
      ['another revision', { revisionId: 'd'.repeat(64) }],
      ['another scope', { scope: { instrument: 'ETH-PERP' } }],
    ])('refuses a prior assessment from %s', (_label, mutation) => {
      const scope = { instrument: 'BTC-PERP' }
      const prior = assess(scope, [fact(scope)])
      const forged = { ...prior, ...mutation }
      // Re-assessment of a changed record first fails its content commitment.
      expectCode(() => assess(scope, [], { priorAssessment: forged }), 'INVALID_PRIOR_ASSESSMENT')
    })

    it('refuses exact but valid prior records belonging to another identity or scope', () => {
      const scope = { instrument: 'BTC-PERP' }
      const otherMemoryRevision = revision(
        'consolidated',
        'other-memory',
        'other-memory',
      )
      const otherMemory = assess(scope, [fact(scope)], {
        revision: otherMemoryRevision,
        latestRevisionId: otherMemoryRevision.revisionId,
      })
      expectCode(() => assess(scope, [], { priorAssessment: otherMemory }), 'PRIOR_ASSESSMENT_MISMATCH')

      const otherRevision = revision(
        'consolidated',
        'memory-1',
        'other-revision',
      )
      const priorRevision = assess(scope, [fact(scope)], {
        revision: otherRevision,
        latestRevisionId: otherRevision.revisionId,
      })
      expectCode(() => assess(scope, [], { priorAssessment: priorRevision }), 'PRIOR_ASSESSMENT_MISMATCH')

      const otherScope = assess({ instrument: 'ETH-PERP' }, [fact({ instrument: 'ETH-PERP' })])
      expectCode(() => assess(scope, [], { priorAssessment: otherScope }), 'PRIOR_ASSESSMENT_MISMATCH')
    })

    it('always enforces false authority and ACTIVE grants no trading authority', () => {
      const active = assess({ instrument: 'BTC-PERP' }, [fact({ instrument: 'BTC-PERP' })])
      expect(active).toMatchObject({ status: 'ACTIVE', authorityGranted: false })
      expectCode(() => assess(undefined, [{ ...fact({}), authorityGranted: true } as never]), 'AUTHORITY_REQUESTED')
      expectCode(() => assess(undefined, [], {
        revision: { ...revision(), authorityGranted: true } as never,
      }), 'INVALID_REVISION')
    })

    it('is deterministic, does not mutate inputs, and deeply freezes output', () => {
      const scope = { instrument: 'BTC-PERP', direction: { domain: 'PERP_DIRECTION', value: 'LONG' } } as const
      const facts = [fact(scope)]
      const request = input(scope, facts)
      const before = JSON.stringify(request)
      const left = assessDevelopmentalMemoryApplicability(request)
      const right = assessDevelopmentalMemoryApplicability(request)

      expect(left).toEqual(right)
      expect(left.assessmentId).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(request)).toBe(before)
      expect(Object.isFrozen(left)).toBe(true)
      expect(Object.isFrozen(left.scope)).toBe(true)
      expect(Object.isFrozen(left.evidenceFacts)).toBe(true)
      expect(Object.isFrozen(left.evidenceFacts[0]?.context)).toBe(true)
    })
  })
})

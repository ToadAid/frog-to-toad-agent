import { describe, expect, it, vi } from 'vitest'
import {
  createDevelopmentalMemoryStore,
  developMemory,
  digestCanonicalJson,
  type CanonicalTradingEvidenceRecord,
  type DevelopmentalMemoryKind,
  type DevelopmentalMemoryRevision,
  type DevelopmentalMemoryStore,
} from '../src/memory/developmentalMemory.js'
import {
  assessDevelopmentalMemoryApplicability,
  type DevelopmentalMemoryApplicability,
  type TradingApplicabilityScope,
} from '../src/memory/applicability.js'
import {
  DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS,
  DevelopmentalMemoryRetrievalError,
  retrieveDevelopmentalMemories,
  tokenizeDevelopmentalMemoryQuery,
  validateDevelopmentalMemoryRetrievalRequest,
  type DevelopmentalMemoryRetrievalRequest,
} from '../src/memory/retrieval.js'
import { createToolRegistry } from '../src/tools/index.js'

const memoryBudget = {
  maximumMemories: 32,
  maximumRevisions: 64,
  maximumEvidencePerMemory: 16,
  maximumSummaryCharacters: 500,
}

function canonical(memoryId: string, revision: number): CanonicalTradingEvidenceRecord {
  return {
    source: 'journal',
    recordId: `${memoryId}:record:${revision}`,
    cycleId: `${memoryId}:cycle:${revision}`,
    contentDigestSha256: digestCanonicalJson({ memoryId, revision }),
  }
}

function addRevision(
  store: Readonly<DevelopmentalMemoryStore>,
  memoryId: string,
  summary: string,
  kind: DevelopmentalMemoryKind = 'lesson',
): {
  store: Readonly<DevelopmentalMemoryStore>
  revision: Readonly<DevelopmentalMemoryRevision>
} {
  const previous = [...store.revisions].reverse().find((item) => item.memoryId === memoryId)
  const evidence = canonical(memoryId, previous === undefined ? 0 : previous.revision + 1)
  const outcome = developMemory(store, [evidence], {
    schemaVersion: 1,
    proposalId: `${memoryId}:proposal:${previous === undefined ? 0 : previous.revision + 1}`,
    memoryId,
    previousRevisionId: previous?.revisionId ?? null,
    kind,
    summary,
    supportingEvidence: [{ ...evidence, role: 'supports' }],
    contradictingEvidence: [],
    authorityGranted: false,
  }, memoryBudget)
  if (outcome.status !== 'developed') throw new Error(`fixture refused: ${outcome.reason}`)
  return outcome
}

function fixtureStore(): Readonly<DevelopmentalMemoryStore> {
  let store = createDevelopmentalMemoryStore()
  store = addRevision(store, 'memory-btc', 'BTC breakout invalidation needs liquidity discipline.').store
  store = addRevision(store, 'memory-eth', 'ETH funding reversal setup needs patience.', 'hypothesis').store
  store = addRevision(store, 'memory-sol', 'Solana volatility question remains open.', 'open_thread').store
  return store
}

function request(
  overrides: Partial<DevelopmentalMemoryRetrievalRequest> = {},
): DevelopmentalMemoryRetrievalRequest {
  return {
    schemaVersion: 1,
    queryText: 'breakout liquidity',
    asOf: 1_000,
    filters: {},
    context: {
      instrument: 'BTC',
      timeframe: '1h',
      direction: { domain: 'SPOT_SIGNAL', value: 'BUY' },
      volatilityRegime: 'EXPANDING',
    },
    budget: {
      maximumCandidates: 8,
      maximumProjectionItems: 4,
      maximumProjectionCharacters: 1_000,
    },
    authorityGranted: false,
    ...overrides,
  }
}

function activeAssessment(
  revision: DevelopmentalMemoryRevision,
  scope: TradingApplicabilityScope = request().context,
  assessedAt = 900,
): Readonly<DevelopmentalMemoryApplicability> {
  const evidence = revision.evidence[0]!
  return assessDevelopmentalMemoryApplicability({
    revision,
    latestRevisionId: revision.revisionId,
    scope,
    assessedAt,
    evidenceFacts: [{
      evidenceReference: {
        source: evidence.source,
        recordId: evidence.recordId,
        cycleId: evidence.cycleId,
        contentDigestSha256: evidence.contentDigestSha256,
      },
      observedAt: assessedAt,
      maxAgeMs: 1_000,
      context: scope,
      authorityGranted: false,
    }],
  })
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof DevelopmentalMemoryRetrievalError
      ? error.code
      : undefined
  }
  return undefined
}

describe('P4A pure bounded developmental-memory retrieval core', () => {
  it('accepts, canonicalizes, clones, and deeply freezes a valid request', () => {
    const input = request({
      filters: { kinds: ['open_thread', 'lesson'] },
    })
    const before = structuredClone(input)
    const validated = validateDevelopmentalMemoryRetrievalRequest(input)
    expect(validated.filters.kinds).toEqual(['lesson', 'open_thread'])
    expect(validated).toEqual({ ...input, filters: { kinds: ['lesson', 'open_thread'] } })
    expect(input).toEqual(before)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.filters.kinds)).toBe(true)
    expect(Object.isFrozen(validated.context.direction)).toBe(true)
  })

  it('fails closed on unknown keys, authority, and malformed queries', () => {
    expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), smuggled: true })))
      .toBe('INVALID_REQUEST')
    expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), authorityGranted: true })))
      .toBe('AUTHORITY_REQUESTED')
    for (const queryText of ['', ' padded', 'padded ', '---']) {
      expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), queryText })))
        .toBe('INVALID_QUERY')
    }
  })

  it('refuses invalid asOf, filters, context, and budgets', () => {
    for (const asOf of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), asOf })))
        .toBe('INVALID_AS_OF')
    }
    for (const filters of [
      { kinds: ['lesson', 'lesson'] },
      { kinds: ['policy'] },
      { maturities: [] },
      { applicabilityStatuses: ['CURRENT'] },
      { unknown: ['lesson'] },
    ]) {
      expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), filters } as never)))
        .toBe('INVALID_FILTERS')
    }
    for (const context of [{}, { instrument: '' }, { instrument: 'BTC', extra: true }]) {
      expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), context } as never)))
        .toBe('INVALID_CONTEXT')
    }
    for (const budget of [
      { maximumCandidates: 0, maximumProjectionItems: 1, maximumProjectionCharacters: 1 },
      { maximumCandidates: 1, maximumProjectionItems: 2, maximumProjectionCharacters: 1 },
      { maximumCandidates: 1, maximumProjectionItems: 1, maximumProjectionCharacters: 0 },
      { maximumCandidates: 1, maximumProjectionItems: 1, maximumProjectionCharacters: 1, extra: 1 },
    ]) {
      expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), budget } as never)))
        .toBe('INVALID_BUDGET')
    }
  })

  it('enforces hard internal ceilings', () => {
    const limits = DEVELOPMENTAL_MEMORY_RETRIEVAL_LIMITS
    for (const budget of [
      { ...request().budget, maximumCandidates: limits.maximumCandidates + 1 },
      { maximumCandidates: limits.maximumCandidates, maximumProjectionItems: limits.maximumProjectionItems + 1, maximumProjectionCharacters: 1 },
      { ...request().budget, maximumProjectionCharacters: limits.maximumProjectionCharacters + 1 },
    ]) {
      expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({ ...request(), budget })))
        .toBe('INVALID_BUDGET')
    }
    expect(errorCode(() => validateDevelopmentalMemoryRetrievalRequest({
      ...request(),
      queryText: 'x'.repeat(limits.maximumQueryCharacters + 1),
    }))).toBe('INVALID_QUERY')
    expect(errorCode(() => retrieveDevelopmentalMemories(
      request(),
      { schemaVersion: 1, revisions: Array(limits.maximumStoreRevisions + 1).fill(null) },
    ))).toBe('INVALID_STORE')
    expect(errorCode(() => retrieveDevelopmentalMemories(
      request(),
      createDevelopmentalMemoryStore(),
      Array(limits.maximumApplicabilityAssessments + 1).fill(null),
    ))).toBe('INVALID_APPLICABILITY')
  })

  it('validates the P1 store and projects only each exact latest revision', () => {
    const first = addRevision(createDevelopmentalMemoryStore(), 'memory-btc', 'BTC breakout first lesson.')
    const second = addRevision(first.store, 'memory-btc', 'BTC breakout revised lesson.')
    const result = retrieveDevelopmentalMemories(request({ queryText: 'btc breakout' }), second.store)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      revisionId: second.revision.revisionId,
      revision: 1,
      summary: 'BTC breakout revised lesson.',
    })
    expect(result.items[0]!.revisionId).not.toBe(first.revision.revisionId)
  })

  it('refuses malformed, duplicate, ambiguous, and broken revision stores', () => {
    const first = addRevision(createDevelopmentalMemoryStore(), 'memory-btc', 'BTC breakout first lesson.')
    const second = addRevision(first.store, 'memory-btc', 'BTC breakout revised lesson.')
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), { schemaVersion: 2, revisions: [] })))
      .toBe('INVALID_STORE')
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), {
      schemaVersion: 1,
      revisions: [first.revision, first.revision],
    }))).toBe('INVALID_STORE')
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), {
      schemaVersion: 1,
      revisions: [second.revision],
    }))).toBe('INVALID_STORE')
  })

  it('applies exact kind and maturity filters before lexical selection', () => {
    const store = fixtureStore()
    expect(retrieveDevelopmentalMemories(request({
      queryText: 'needs',
      filters: { kinds: ['hypothesis'] },
    }), store).items.map((item) => item.memoryId)).toEqual(['memory-eth'])
    expect(retrieveDevelopmentalMemories(request({
      queryText: 'breakout',
      filters: { maturities: ['tentative'] },
    }), store).items.map((item) => item.memoryId)).toEqual(['memory-btc'])
    expect(retrieveDevelopmentalMemories(request({
      queryText: 'breakout',
      filters: { maturities: ['reinforced'] },
    }), store).items).toEqual([])
  })

  it('filters applicability exactly and never fabricates missing status', () => {
    const store = fixtureStore()
    const btc = store.revisions.find((item) => item.memoryId === 'memory-btc')!
    const assessment = activeAssessment(btc)
    expect(retrieveDevelopmentalMemories(request({
      queryText: 'breakout',
      filters: { applicabilityStatuses: ['ACTIVE'] },
    }), store, [assessment]).items).toHaveLength(1)
    expect(retrieveDevelopmentalMemories(request({
      queryText: 'breakout',
      filters: { applicabilityStatuses: ['STALE'] },
    }), store, [assessment]).items).toEqual([])
    const absent = retrieveDevelopmentalMemories(request({ queryText: 'breakout' }), store)
    expect(absent.items[0]!.applicability).toBeNull()
    expect(absent.items[0]!.context).toEqual({ exactMatchCount: 0, matchedScopeKeys: [] })
  })

  it('makes filter order canonical and result identity invariant', () => {
    const store = fixtureStore()
    const left = retrieveDevelopmentalMemories(request({
      queryText: 'needs',
      filters: { kinds: ['hypothesis', 'lesson'], maturities: ['contested', 'tentative'] },
    }), store)
    const right = retrieveDevelopmentalMemories(request({
      queryText: 'needs',
      filters: { kinds: ['lesson', 'hypothesis'], maturities: ['tentative', 'contested'] },
    }), store)
    expect(left).toEqual(right)
    expect(left.retrievalId).toBe(right.retrievalId)
  })

  it('tokenizes with Unicode NFKC, lowercase, letter/number runs, and unique terms', () => {
    expect(tokenizeDevelopmentalMemoryQuery('ＢＴＣ Café CAFÉ １２３')).toEqual([
      'btc', 'café', '123',
    ])
    const memory = addRevision(createDevelopmentalMemoryStore(), 'unicode', 'BTC café 123 breakout.')
    const result = retrieveDevelopmentalMemories(request({ queryText: 'ＢＴＣ Café CAFÉ １２３' }), memory.store)
    expect(result.items[0]!.lexical).toEqual({
      matchedQueryTokenCount: 3,
      totalQueryTokenCount: 3,
    })
  })

  it('uses transparent exact-token overlap without fuzzy, synonym, or stemming behavior', () => {
    const memory = addRevision(createDevelopmentalMemoryStore(), 'memory-run', 'Running quickly protects capital.')
    expect(retrieveDevelopmentalMemories(request({ queryText: 'run' }), memory.store).items).toEqual([])
    expect(retrieveDevelopmentalMemories(request({ queryText: 'fast' }), memory.store).items).toEqual([])
    const exact = retrieveDevelopmentalMemories(request({ queryText: 'running capital capital' }), memory.store)
    expect(exact.items[0]!.lexical).toEqual({
      matchedQueryTokenCount: 2,
      totalQueryTokenCount: 2,
    })
  })

  it('excludes zero overlap and enforces the lexical candidate cap', () => {
    const store = fixtureStore()
    const result = retrieveDevelopmentalMemories(request({
      queryText: 'needs',
      budget: { ...request().budget, maximumCandidates: 1, maximumProjectionItems: 1 },
    }), store)
    expect(result.lexicalMatchCount).toBe(2)
    expect(result.candidateCount).toBe(1)
    expect(result.omissions.candidateBudget).toBe(1)
    expect(result.items.some((item) => item.memoryId === 'memory-sol')).toBe(false)
  })

  it('ranks exact context fields and direction by exact domain/value only', () => {
    let store = createDevelopmentalMemoryStore()
    store = addRevision(store, 'a', 'Shared breakout lesson.').store
    store = addRevision(store, 'b', 'Shared breakout lesson.').store
    const a = store.revisions.find((item) => item.memoryId === 'a')!
    const b = store.revisions.find((item) => item.memoryId === 'b')!
    const exact = activeAssessment(a, request().context)
    const similar = activeAssessment(b, {
      instrument: 'BTC',
      timeframe: '1h',
      direction: { domain: 'PERP_DIRECTION', value: 'LONG' },
      volatilityRegime: 'expanding',
    })
    const result = retrieveDevelopmentalMemories(request({ queryText: 'breakout' }), store, [similar, exact])
    expect(result.items[0]!.memoryId).toBe('a')
    expect(result.items[0]!.context).toEqual({
      exactMatchCount: 4,
      matchedScopeKeys: ['instrument', 'timeframe', 'direction', 'volatilityRegime'],
    })
    expect(result.items[1]!.context).toEqual({
      exactMatchCount: 2,
      matchedScopeKeys: ['instrument', 'timeframe'],
    })
  })

  it('validates exact assessment bindings, time cutoff, and ambiguity', () => {
    const store = fixtureStore()
    const btc = store.revisions.find((item) => item.memoryId === 'memory-btc')!
    const other = addRevision(createDevelopmentalMemoryStore(), 'other', 'Other breakout lesson.').revision
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), store, { not: 'an array' })))
      .toBe('INVALID_APPLICABILITY')
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), store, [{ invalid: true }])))
      .toBe('INVALID_APPLICABILITY')
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), store, [activeAssessment(other)])))
      .toBe('APPLICABILITY_BINDING_MISMATCH')
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), store, [activeAssessment(btc, request().context, 1_001)])))
      .toBe('FUTURE_APPLICABILITY')
    expect(errorCode(() => retrieveDevelopmentalMemories(request(), store, [
      activeAssessment(btc, request().context, 800),
      activeAssessment(btc, request().context, 900),
    ]))).toBe('AMBIGUOUS_APPLICABILITY')
  })

  it('does not invent applicability-status precedence', () => {
    let store = createDevelopmentalMemoryStore()
    store = addRevision(store, 'status-a', 'Shared breakout lesson.').store
    store = addRevision(store, 'status-b', 'Shared breakout lesson.').store
    const revisions = store.revisions
    const assessments = revisions.map((revision, index) => {
      const exact = activeAssessment(revision, request().context, 900)
      if (index === 0) return exact
      return assessDevelopmentalMemoryApplicability({
        revision,
        latestRevisionId: revision.revisionId,
        scope: request().context,
        assessedAt: 900,
        evidenceFacts: [{
          evidenceReference: {
            source: revision.evidence[0]!.source,
            recordId: revision.evidence[0]!.recordId,
            cycleId: revision.evidence[0]!.cycleId,
            contentDigestSha256: revision.evidence[0]!.contentDigestSha256,
          },
          observedAt: 900,
          maxAgeMs: 1_000,
          context: { instrument: 'ETH' },
          authorityGranted: false,
        }],
      })
    })
    expect(assessments.map((item) => item.status).sort()).toEqual(['ACTIVE', 'CONTESTED'])
    const result = retrieveDevelopmentalMemories(request({ queryText: 'breakout' }), store, assessments)
    expect(result.items.map((item) => item.revisionId)).toEqual(
      [...revisions].sort((a, b) => a.revisionId.localeCompare(b.revisionId)).map((item) => item.revisionId),
    )
  })

  it('computes assessment age only from assessedAt relative to supplied asOf', () => {
    const store = fixtureStore()
    const btc = store.revisions.find((item) => item.memoryId === 'memory-btc')!
    const aged = retrieveDevelopmentalMemories(request({ queryText: 'breakout' }), store, [activeAssessment(btc, request().context, 875)])
    expect(aged.items[0]!.applicability!.assessmentAgeAtAsOfMs).toBe(125)
    const zero = retrieveDevelopmentalMemories(request({ queryText: 'breakout' }), store, [activeAssessment(btc, request().context, 1_000)])
    expect(zero.items[0]!.applicability!.assessmentAgeAtAsOfMs).toBe(0)
    expect(zero.establishesNow).toBe(false)
    expect(JSON.stringify(zero.items[0])).not.toMatch(/eventAt|observationTime|recordingTime|receiptTime/)
  })

  it('does not call ambient time or randomness', () => {
    const now = vi.spyOn(Date, 'now')
    const random = vi.spyOn(Math, 'random')
    retrieveDevelopmentalMemories(request(), fixtureStore())
    expect(now).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    now.mockRestore()
    random.mockRestore()
  })

  it('enforces item and summary-character budgets without truncation', () => {
    const store = fixtureStore()
    const byItems = retrieveDevelopmentalMemories(request({
      queryText: 'needs',
      budget: { ...request().budget, maximumProjectionItems: 1 },
    }), store)
    expect(byItems.projectedCount).toBe(1)
    expect(byItems.omissions.projectionItemBudget).toBe(1)

    const exactSummary = 'BTC breakout invalidation needs liquidity discipline.'
    const byCharacters = retrieveDevelopmentalMemories(request({
      queryText: 'breakout',
      budget: { ...request().budget, maximumProjectionCharacters: exactSummary.length - 1 },
    }), store)
    expect(byCharacters.items).toEqual([])
    expect(byCharacters.omissions.projectionCharacterBudget).toBe(1)
    expect(byCharacters.projectionCharacters).toBe(0)
    const fits = retrieveDevelopmentalMemories(request({
      queryText: 'breakout',
      budget: { ...request().budget, maximumProjectionCharacters: exactSummary.length },
    }), store)
    expect(fits.items[0]!.summary).toBe(exactSummary)
    expect(fits.projectionCharacters).toBe(exactSummary.length)
  })

  it('exposes references only and never embeds full evidence bodies', () => {
    const item = retrieveDevelopmentalMemories(request(), fixtureStore()).items[0]!
    expect(item.evidenceCount).toBe(1)
    expect(Object.keys(item.evidenceReferences[0]!).sort()).toEqual(['recordId', 'source'])
    expect(JSON.stringify(item.evidenceReferences)).not.toMatch(/contentDigest|cycleId|role|payload/)
  })

  it('is deterministic, deeply immutable, and independent of input array order', () => {
    const original = fixtureStore()
    const reordered: DevelopmentalMemoryStore = {
      schemaVersion: 1,
      revisions: [...original.revisions].reverse(),
    }
    const left = retrieveDevelopmentalMemories(request({ queryText: 'needs' }), original)
    const right = retrieveDevelopmentalMemories(request({ queryText: 'needs' }), reordered)
    expect(left).toEqual(right)
    expect(left.retrievalId).toMatch(/^[a-f0-9]{64}$/)
    expect(left.retrievalId).toBe(right.retrievalId)
    expect(Object.isFrozen(left)).toBe(true)
    expect(Object.isFrozen(left.items)).toBe(true)
    expect(Object.isFrozen(left.items[0]!.evidenceReferences)).toBe(true)
  })

  it('preserves store and applicability caller inputs byte-for-byte and unfrozen', () => {
    const store = structuredClone(fixtureStore())
    const btc = store.revisions.find((item) => item.memoryId === 'memory-btc')!
    const assessments = [structuredClone(activeAssessment(btc))]
    const before = JSON.stringify({ store, assessments })
    retrieveDevelopmentalMemories(request(), store, assessments)
    expect(JSON.stringify({ store, assessments })).toBe(before)
    expect(Object.isFrozen(store)).toBe(false)
    expect(Object.isFrozen(assessments[0])).toBe(false)
  })

  it('returns the permanent non-authority envelope and adds no LLM tool route', () => {
    const result = retrieveDevelopmentalMemories(request(), fixtureStore())
    expect(result).toMatchObject({
      referencesOnly: true,
      establishesNow: false,
      grantsAuthority: false,
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/"(?:approved|authorized|tradeAllowed|freshNow|currentTruth|permissionGranted)"/)
    expect(createToolRegistry(false).names().filter((name) => name.includes('retriev'))).toEqual([])
  })
})

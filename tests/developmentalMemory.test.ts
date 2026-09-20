import { describe, expect, it } from 'vitest'
import {
  CANONICAL_TRADING_EVIDENCE_SOURCES,
  DEVELOPMENTAL_MEMORY_KINDS,
  createDevelopmentalMemoryStore,
  developMemory,
  digestDevelopmentalMemory,
  projectDevelopmentalMemories,
  serializeDevelopmentalMemoryCanonical,
  type CanonicalTradingEvidenceRecord,
  type DevelopmentalMemoryBudget,
  type DevelopmentalMemoryEvidence,
  type DevelopmentalMemoryProposal,
  type DevelopmentalMemoryStore,
} from '../src/memory/developmentalMemory.js'

const digest = (char: string) => char.repeat(64)

const budget: DevelopmentalMemoryBudget = {
  maximumMemories: 8,
  maximumRevisions: 32,
  maximumEvidencePerMemory: 12,
  maximumSummaryCharacters: 240,
}

function canonical(
  source: CanonicalTradingEvidenceRecord['source'],
  recordId: string,
  cycleId: string,
  hashChar: string,
): CanonicalTradingEvidenceRecord {
  return {
    source,
    recordId,
    cycleId,
    contentDigestSha256: digest(hashChar),
  }
}

function ref(
  record: CanonicalTradingEvidenceRecord,
  role: DevelopmentalMemoryEvidence['role'] = 'supports',
): DevelopmentalMemoryEvidence {
  return { ...record, role }
}

function proposal(
  overrides: Partial<DevelopmentalMemoryProposal> = {},
): DevelopmentalMemoryProposal {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-1',
    memoryId: 'memory-1',
    previousRevisionId: null,
    kind: 'lesson',
    summary: 'Respect invalidation before liquidation pressure.',
    supportingEvidence: [],
    contradictingEvidence: [],
    authorityGranted: false,
    ...overrides,
  }
}

function expectRefusal(
  result: ReturnType<typeof developMemory>,
  reason: string,
): void {
  expect(result).toEqual({ status: 'refused', reason })
}

describe('P1A developmental memory contract', () => {
  it('pins the smallest Frog-to-Toad kinds and canonical evidence taxonomy', () => {
    expect(DEVELOPMENTAL_MEMORY_KINDS).toEqual([
      'lesson',
      'hypothesis',
      'open_thread',
    ])
    expect(CANONICAL_TRADING_EVIDENCE_SOURCES).toEqual([
      'spot-ledger',
      'journal',
      'signal-lifecycle',
      'signal-grades-ta',
      'forecast-records',
      'paper-perps-ledger',
      'perps-signal-journal',
      'perps-signal-grades',
    ])
  })

  it('creates a deeply frozen, canonically serializable empty store', () => {
    const store = createDevelopmentalMemoryStore()
    expect(store).toEqual({ schemaVersion: 1, revisions: [] })
    expect(Object.isFrozen(store)).toBe(true)
    expect(Object.isFrozen(store.revisions)).toBe(true)
    expect(serializeDevelopmentalMemoryCanonical(store))
      .toBe('{"revisions":[],"schemaVersion":1}')
    expect(digestDevelopmentalMemory(store)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('develops the first grounded revision as tentative and authority-free', () => {
    const evidence = canonical('journal', 'journal:1', 'run-1', 'a')
    const result = developMemory(
      createDevelopmentalMemoryStore(),
      [evidence],
      proposal({ supportingEvidence: [ref(evidence)] }),
      budget,
    )
    expect(result.status).toBe('developed')
    if (result.status !== 'developed') return

    expect(result.revision).toMatchObject({
      revision: 0,
      previousRevisionId: null,
      kind: 'lesson',
      maturity: 'tentative',
      authorityGranted: false,
    })
    expect(result.revision.revisionId).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(result.revision)).toBe(true)
    expect(Object.isFrozen(result.revision.evidence)).toBe(true)
  })

  it('computes reinforced and consolidated only from distinct supporting cycles', () => {
    const e1 = canonical('journal', 'j1', 'cycle-1', 'a')
    const e2 = canonical('signal-grades-ta', 'g1', 'cycle-2', 'b')
    const e3 = canonical('perps-signal-grades', 'pg1', 'cycle-3', 'c')
    const catalog = [e1, e2, e3]

    const first = developMemory(
      createDevelopmentalMemoryStore(),
      catalog,
      proposal({ supportingEvidence: [ref(e1)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    const second = developMemory(
      first.store,
      catalog,
      proposal({
        proposalId: 'proposal-2',
        previousRevisionId: first.revision.revisionId,
        supportingEvidence: [ref(e2)],
      }),
      budget,
    )
    expect(second.status).toBe('developed')
    if (second.status !== 'developed') return
    expect(second.revision.maturity).toBe('reinforced')

    const third = developMemory(
      second.store,
      catalog,
      proposal({
        proposalId: 'proposal-3',
        previousRevisionId: second.revision.revisionId,
        supportingEvidence: [ref(e3)],
      }),
      budget,
    )
    expect(third.status).toBe('developed')
    if (third.status !== 'developed') return
    expect(third.revision.maturity).toBe('consolidated')
    expect(third.revision.evidence).toHaveLength(3)
  })

  it('does not count repeated support from the same cycle as reinforcement', () => {
    const e1 = canonical('journal', 'j1', 'cycle-1', 'a')
    const e2 = canonical('signal-grades-ta', 'g1', 'cycle-1', 'b')
    const first = developMemory(
      createDevelopmentalMemoryStore(),
      [e1, e2],
      proposal({ supportingEvidence: [ref(e1)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    const second = developMemory(
      first.store,
      [e1, e2],
      proposal({
        proposalId: 'proposal-2',
        previousRevisionId: first.revision.revisionId,
        supportingEvidence: [ref(e2)],
      }),
      budget,
    )
    expect(second.status).toBe('developed')
    if (second.status !== 'developed') return
    expect(second.revision.maturity).toBe('tentative')
  })

  it('makes any qualifying contradiction contested while retaining prior support', () => {
    const support = canonical('journal', 'j1', 'cycle-1', 'a')
    const contradiction = canonical(
      'perps-signal-grades',
      'pg1',
      'cycle-2',
      'b',
    )
    const catalog = [support, contradiction]

    const first = developMemory(
      createDevelopmentalMemoryStore(),
      catalog,
      proposal({ supportingEvidence: [ref(support)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    const second = developMemory(
      first.store,
      catalog,
      proposal({
        proposalId: 'proposal-2',
        previousRevisionId: first.revision.revisionId,
        contradictingEvidence: [ref(contradiction, 'contradicts')],
      }),
      budget,
    )
    expect(second.status).toBe('developed')
    if (second.status !== 'developed') return
    expect(second.revision.maturity).toBe('contested')
    expect(second.revision.evidence).toEqual([
      ref(support),
      ref(contradiction, 'contradicts'),
    ])
  })

  it('refuses authority requests before proposal acceptance', () => {
    const evidence = canonical('journal', 'j1', 'cycle-1', 'a')
    const unsafe = {
      ...proposal({ supportingEvidence: [ref(evidence)] }),
      authorityGranted: true,
    }
    expectRefusal(
      developMemory(createDevelopmentalMemoryStore(), [evidence], unsafe, budget),
      'authority_requested',
    )
  })

  it('refuses unknown and mismatched canonical evidence', () => {
    const canonicalRecord = canonical('journal', 'j1', 'cycle-1', 'a')
    const unknown = canonical('journal', 'j2', 'cycle-1', 'b')

    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [canonicalRecord],
        proposal({ supportingEvidence: [ref(unknown)] }),
        budget,
      ),
      'unknown_evidence',
    )

    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [canonicalRecord],
        proposal({
          supportingEvidence: [{
            ...ref(canonicalRecord),
            contentDigestSha256: digest('c'),
          }],
        }),
        budget,
      ),
      'evidence_mismatch',
    )
  })

  it('refuses duplicate evidence even when support and contradiction disagree', () => {
    const evidence = canonical('journal', 'j1', 'cycle-1', 'a')
    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [evidence],
        proposal({
          supportingEvidence: [ref(evidence)],
          contradictingEvidence: [ref(evidence, 'contradicts')],
        }),
        budget,
      ),
      'duplicate_evidence',
    )
  })

  it('refuses an ungrounded initial memory', () => {
    const contradiction = canonical('journal', 'j1', 'cycle-1', 'a')
    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [contradiction],
        proposal({
          contradictingEvidence: [ref(contradiction, 'contradicts')],
        }),
        budget,
      ),
      'insufficient_grounding',
    )
  })

  it('refuses stale revision branches and kind mutation', () => {
    const e1 = canonical('journal', 'j1', 'cycle-1', 'a')
    const e2 = canonical('journal', 'j2', 'cycle-2', 'b')
    const catalog = [e1, e2]
    const first = developMemory(
      createDevelopmentalMemoryStore(),
      catalog,
      proposal({ supportingEvidence: [ref(e1)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    expectRefusal(
      developMemory(
        first.store,
        catalog,
        proposal({
          proposalId: 'proposal-2',
          previousRevisionId: null,
          supportingEvidence: [ref(e2)],
        }),
        budget,
      ),
      'stale_revision',
    )

    expectRefusal(
      developMemory(
        first.store,
        catalog,
        proposal({
          proposalId: 'proposal-3',
          previousRevisionId: first.revision.revisionId,
          kind: 'hypothesis',
          supportingEvidence: [ref(e2)],
        }),
        budget,
      ),
      'kind_mismatch',
    )
  })

  it('refuses revisions with no new evidence and preserves immutable history', () => {
    const evidence = canonical('journal', 'j1', 'cycle-1', 'a')
    const first = developMemory(
      createDevelopmentalMemoryStore(),
      [evidence],
      proposal({ supportingEvidence: [ref(evidence)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    expectRefusal(
      developMemory(
        first.store,
        [evidence],
        proposal({
          proposalId: 'proposal-2',
          previousRevisionId: first.revision.revisionId,
          supportingEvidence: [ref(evidence)],
        }),
        budget,
      ),
      'no_new_evidence',
    )
    expect(first.store.revisions).toHaveLength(1)
  })

  it('projects only the latest revision per memory in stable memoryId order', () => {
    const a1 = canonical('journal', 'a1', 'cycle-1', 'a')
    const a2 = canonical('journal', 'a2', 'cycle-2', 'b')
    const b1 = canonical('journal', 'b1', 'cycle-1', 'c')
    const catalog = [a1, a2, b1]

    const b = developMemory(
      createDevelopmentalMemoryStore(),
      catalog,
      proposal({
        proposalId: 'p-b',
        memoryId: 'b',
        supportingEvidence: [ref(b1)],
      }),
      budget,
    )
    expect(b.status).toBe('developed')
    if (b.status !== 'developed') return

    const a = developMemory(
      b.store,
      catalog,
      proposal({
        proposalId: 'p-a',
        memoryId: 'a',
        supportingEvidence: [ref(a1)],
      }),
      budget,
    )
    expect(a.status).toBe('developed')
    if (a.status !== 'developed') return

    const aUpdate = developMemory(
      a.store,
      catalog,
      proposal({
        proposalId: 'p-a2',
        memoryId: 'a',
        previousRevisionId: a.revision.revisionId,
        supportingEvidence: [ref(a2)],
      }),
      budget,
    )
    expect(aUpdate.status).toBe('developed')
    if (aUpdate.status !== 'developed') return

    const projected = projectDevelopmentalMemories(aUpdate.store)
    expect(projected.map((item) => item.memoryId)).toEqual(['a', 'b'])
    expect(projected[0]?.revision).toBe(1)
    expect(Object.isFrozen(projected)).toBe(true)
  })

  it('refuses malformed or duplicate evidence catalogs', () => {
    const e1 = canonical('journal', 'j1', 'cycle-1', 'a')
    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [e1, e1],
        proposal({ supportingEvidence: [ref(e1)] }),
        budget,
      ),
      'invalid_evidence_catalog',
    )

    const malformed = {
      ...e1,
      source: 'live-provider-response',
    } as unknown as CanonicalTradingEvidenceRecord
    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [malformed],
        proposal({ supportingEvidence: [ref(e1)] }),
        budget,
      ),
      'invalid_evidence_catalog',
    )
  })

  it('refuses tampered stores rather than repairing history silently', () => {
    const evidence = canonical('journal', 'j1', 'cycle-1', 'a')
    const first = developMemory(
      createDevelopmentalMemoryStore(),
      [evidence],
      proposal({ supportingEvidence: [ref(evidence)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    const tampered = JSON.parse(
      JSON.stringify(first.store),
    ) as DevelopmentalMemoryStore
    ;(tampered.revisions[0] as { maturity: string }).maturity = 'consolidated'

    expectRefusal(
      developMemory(
        tampered,
        [evidence],
        proposal({
          proposalId: 'proposal-2',
          previousRevisionId: first.revision.revisionId,
          supportingEvidence: [ref(evidence)],
        }),
        budget,
      ),
      'invalid_store',
    )
  })

  it('refuses summary tamper even when maturity and chain fields still look valid', () => {
    const evidence = canonical('journal', 'j1', 'cycle-1', 'a')
    const first = developMemory(
      createDevelopmentalMemoryStore(),
      [evidence],
      proposal({ supportingEvidence: [ref(evidence)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    const tampered = JSON.parse(
      JSON.stringify(first.store),
    ) as DevelopmentalMemoryStore
    ;(tampered.revisions[0] as { summary: string }).summary =
      'Tampered interpretation with the old revision id.'

    expectRefusal(
      developMemory(
        tampered,
        [evidence],
        proposal({
          proposalId: 'proposal-2',
          previousRevisionId: first.revision.revisionId,
          supportingEvidence: [ref(evidence)],
        }),
        budget,
      ),
      'invalid_store',
    )
  })

  it('refuses malformed or forged revision ids', () => {
    const evidence = canonical('journal', 'j1', 'cycle-1', 'a')
    const first = developMemory(
      createDevelopmentalMemoryStore(),
      [evidence],
      proposal({ supportingEvidence: [ref(evidence)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    const tampered = JSON.parse(
      JSON.stringify(first.store),
    ) as DevelopmentalMemoryStore
    ;(tampered.revisions[0] as { revisionId: string }).revisionId =
      'f'.repeat(64)

    expect(() => serializeDevelopmentalMemoryCanonical(tampered))
      .toThrow('invalid developmental memory store')
  })

  it('refuses proposal-id reuse before it can construct a self-invalid store', () => {
    const e1 = canonical('journal', 'j1', 'cycle-1', 'a')
    const e2 = canonical('journal', 'j2', 'cycle-2', 'b')
    const first = developMemory(
      createDevelopmentalMemoryStore(),
      [e1, e2],
      proposal({ supportingEvidence: [ref(e1)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    expectRefusal(
      developMemory(
        first.store,
        [e1, e2],
        proposal({
          proposalId: 'proposal-1',
          memoryId: 'memory-2',
          supportingEvidence: [ref(e2)],
        }),
        budget,
      ),
      'duplicate_proposal',
    )
  })

  it('enforces memory, revision, evidence, and summary budgets', () => {
    const e1 = canonical('journal', 'j1', 'cycle-1', 'a')
    const e2 = canonical('journal', 'j2', 'cycle-2', 'b')

    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [e1],
        proposal({
          summary: 'x'.repeat(241),
          supportingEvidence: [ref(e1)],
        }),
        budget,
      ),
      'memory_budget_exceeded',
    )

    expectRefusal(
      developMemory(
        createDevelopmentalMemoryStore(),
        [e1, e2],
        proposal({ supportingEvidence: [ref(e1), ref(e2)] }),
        { ...budget, maximumEvidencePerMemory: 1 },
      ),
      'memory_budget_exceeded',
    )

    const first = developMemory(
      createDevelopmentalMemoryStore(),
      [e1],
      proposal({ supportingEvidence: [ref(e1)] }),
      budget,
    )
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return

    expectRefusal(
      developMemory(
        first.store,
        [e1, e2],
        proposal({
          proposalId: 'proposal-2',
          memoryId: 'memory-2',
          supportingEvidence: [ref(e2)],
        }),
        { ...budget, maximumMemories: 1 },
      ),
      'memory_budget_exceeded',
    )

    expectRefusal(
      developMemory(
        first.store,
        [e1, e2],
        proposal({
          proposalId: 'proposal-3',
          previousRevisionId: first.revision.revisionId,
          supportingEvidence: [ref(e2)],
        }),
        { ...budget, maximumRevisions: 1 },
      ),
      'memory_budget_exceeded',
    )
  })

  it('produces deterministic revision/store digests for identical inputs', () => {
    const evidence = canonical('journal', 'j1', 'cycle-1', 'a')
    const input = proposal({ supportingEvidence: [ref(evidence)] })
    const left = developMemory(
      createDevelopmentalMemoryStore(),
      [evidence],
      input,
      budget,
    )
    const right = developMemory(
      createDevelopmentalMemoryStore(),
      [evidence],
      input,
      budget,
    )
    expect(left.status).toBe('developed')
    expect(right.status).toBe('developed')
    if (left.status !== 'developed' || right.status !== 'developed') return

    expect(left.revision.revisionId).toBe(right.revision.revisionId)
    expect(digestDevelopmentalMemory(left.store))
      .toBe(digestDevelopmentalMemory(right.store))
  })
})

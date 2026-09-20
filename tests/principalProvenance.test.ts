import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDevelopmentalMemoryStore,
  developMemory,
  digestCanonicalJson,
  type DevelopmentalMemoryMaturity,
  type DevelopmentalMemoryRevision,
} from '../src/memory/developmentalMemory.js'
import {
  PRINCIPAL_PROVENANCE_KINDS,
  PrincipalProvenanceError,
  createEvidenceDerivedProvenance,
  createPrincipalDeclaredProvenance,
  serializePrincipalProvenance,
  validatePrincipalProvenance,
  type PrincipalDeclaredProvenanceInput,
  type PrincipalDeclarationType,
} from '../src/memory/principalProvenance.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function revision(
  maturity: DevelopmentalMemoryMaturity = 'reinforced',
): DevelopmentalMemoryRevision {
  const supportCount = maturity === 'consolidated'
    ? 3
    : maturity === 'reinforced'
      ? 2
      : 1
  const supporting = Array.from({ length: supportCount }, (_, index) => ({
    source: 'journal' as const,
    recordId: `journal:${index + 1}`,
    cycleId: `cycle-${index + 1}`,
    contentDigestSha256: String(index + 1).repeat(64),
  }))
  const contradiction = maturity === 'contested'
    ? [{
        source: 'journal' as const,
        recordId: 'journal:contradiction',
        cycleId: 'cycle-contradiction',
        contentDigestSha256: 'f'.repeat(64),
      }]
    : []
  const outcome = developMemory(
    createDevelopmentalMemoryStore(),
    [...supporting, ...contradiction],
    {
      schemaVersion: 1,
      proposalId: `proposal-${maturity}`,
      memoryId: 'memory-principal-provenance',
      previousRevisionId: null,
      kind: 'lesson',
      summary: 'Treat evidence-derived memory as advisory, never principal policy.',
      supportingEvidence: supporting.map((item) => ({
        ...item,
        role: 'supports' as const,
      })),
      contradictingEvidence: contradiction.map((item) => ({
        ...item,
        role: 'contradicts' as const,
      })),
      authorityGranted: false,
    },
    {
      maximumMemories: 1,
      maximumRevisions: 1,
      maximumEvidencePerMemory: 4,
      maximumSummaryCharacters: 100,
    },
  )
  if (outcome.status !== 'developed') throw new Error(outcome.reason)
  expect(outcome.revision.maturity).toBe(maturity)
  return outcome.revision
}

function principalInput(
  declarationType: PrincipalDeclarationType = 'INSTRUCTION',
  content = 'Keep live execution disabled until I explicitly approve it.',
): PrincipalDeclaredProvenanceInput {
  const contentDigestSha256 = digestCanonicalJson({
    declarationType,
    content,
  })
  return {
    schemaVersion: 1,
    declarationReference: {
      schemaVersion: 1,
      source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_DECLARATION',
      declarationId: 'principal-declaration-1',
      principalReference: 'principal:primary',
      authenticationRecordId: 'auth-record-1',
      contentDigestSha256,
    },
    declarationRecord: {
      schemaVersion: 1,
      declarationId: 'principal-declaration-1',
      declarationType,
      content,
      contentDigestSha256,
      authorityGranted: false,
    },
    authorityGranted: false,
  }
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
    expect(error).toBeInstanceOf(PrincipalProvenanceError)
    expect((error as PrincipalProvenanceError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('P3A principal declaration provenance contract', () => {
  it('pins exactly two structurally distinct provenance kinds', () => {
    expect(PRINCIPAL_PROVENANCE_KINDS).toEqual([
      'PRINCIPAL_DECLARED',
      'EVIDENCE_DERIVED',
    ])
    const principal = createPrincipalDeclaredProvenance(principalInput())
    const derived = createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: revision(),
      authorityGranted: false,
    })
    expect(principal.provenanceKind).toBe('PRINCIPAL_DECLARED')
    expect(derived.provenanceKind).toBe('EVIDENCE_DERIVED')
    expect(serializePrincipalProvenance(principal)).toContain(
      '"provenanceKind":"PRINCIPAL_DECLARED"',
    )
    expect(serializePrincipalProvenance(derived)).toContain(
      '"provenanceKind":"EVIDENCE_DERIVED"',
    )
  })

  it.each(['INSTRUCTION', 'PREFERENCE'] as const)(
    'binds an explicit principal %s without statistical maturity',
    (declarationType) => {
      const result = createPrincipalDeclaredProvenance(
        principalInput(declarationType),
      )
      expect(result).toMatchObject({
        schemaVersion: 1,
        provenanceKind: 'PRINCIPAL_DECLARED',
        declarationType,
        trustBoundary:
          'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE',
        authorityGranted: false,
      })
      expect('maturity' in result).toBe(false)
      expect('sourceRevision' in result).toBe(false)
    },
  )

  it('preserves exact upstream source identity and content-digest bindings', () => {
    const input = principalInput()
    const result = createPrincipalDeclaredProvenance(input)
    expect(result.declarationReference).toEqual(input.declarationReference)
    expect(result.contentDigestSha256).toBe(
      input.declarationRecord.contentDigestSha256,
    )
    expect(result.declarationReference.contentDigestSha256).toBe(
      result.contentDigestSha256,
    )
  })

  it('composes only with an actual valid P1 revision and preserves its law', () => {
    const sourceRevision = revision('consolidated')
    const result = createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: sourceRevision,
      authorityGranted: false,
    })
    expect(result).toMatchObject({
      provenanceKind: 'EVIDENCE_DERIVED',
      advisoryOnly: true,
      principalPolicy: false,
      authorityGranted: false,
      sourceRevision: {
        memoryId: sourceRevision.memoryId,
        revisionId: sourceRevision.revisionId,
        maturity: 'consolidated',
        evidence: sourceRevision.evidence,
      },
    })
    expect(result.sourceRevision).toEqual(sourceRevision)
  })

  it('refuses malformed or tampered P1 revisions instead of cloning maturity law', () => {
    const valid = revision()
    for (const invalid of [
      { ...valid, maturity: 'consolidated' },
      { ...valid, summary: 'tampered with old revision id' },
      { ...valid, revisionId: '0'.repeat(64) },
      { ...valid, unexpected: true },
    ]) {
      expectCode(() => createEvidenceDerivedProvenance({
        schemaVersion: 1,
        revision: invalid,
        authorityGranted: false,
      }), 'INVALID_EVIDENCE_REVISION')
    }
  })

  it('provides no relabel or promotion path from evidence to principal policy', () => {
    const derived = mutable(createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: revision(),
      authorityGranted: false,
    }))
    derived.provenanceKind = 'PRINCIPAL_DECLARED' as never
    expectCode(() => validatePrincipalProvenance(derived), 'INVALID_PROVENANCE')

    expectCode(() => createPrincipalDeclaredProvenance({
      schemaVersion: 1,
      declarationReference: derived,
      declarationRecord: derived,
      authorityGranted: false,
    }), 'INVALID_PRINCIPAL_DECLARATION')
  })

  it('does not accept orchestrator authorship, USER.md, or model labels as authentication', () => {
    const input = mutable(principalInput())
    input.declarationReference.source = 'ORCHESTRATOR' as never
    ;(input.declarationReference as unknown as Record<string, unknown>)
      .storageLocation = 'USER.md'
    ;(input.declarationRecord as unknown as Record<string, unknown>)
      .modelAssertion = 'the principal said so'
    expectCode(
      () => createPrincipalDeclaredProvenance(input),
      'INVALID_PRINCIPAL_DECLARATION',
    )
  })

  it('refuses missing, malformed, unknown, and surplus declaration fields', () => {
    const missing = mutable(principalInput())
    delete (missing.declarationReference as unknown as Record<string, unknown>)
      .authenticationRecordId
    const malformed = mutable(principalInput())
    malformed.declarationRecord.contentDigestSha256 = 'not-a-digest'
    const unknown = mutable(principalInput())
    unknown.declarationRecord.declarationType = 'POLICY' as never
    const surplus = mutable(principalInput())
    ;(surplus.declarationRecord as unknown as Record<string, unknown>)
      .maturity = 'consolidated'

    for (const invalid of [missing, malformed, unknown, surplus]) {
      expectCode(
        () => createPrincipalDeclaredProvenance(invalid),
        'INVALID_PRINCIPAL_DECLARATION',
      )
    }
  })

  it('refuses identity, content, and digest mismatch', () => {
    const identity = mutable(principalInput())
    identity.declarationRecord.declarationId = 'another-declaration'
    expectCode(
      () => createPrincipalDeclaredProvenance(identity),
      'INVALID_PRINCIPAL_DECLARATION',
    )

    for (const mutateInput of [
      (input: Mutable<PrincipalDeclaredProvenanceInput>) => {
        input.declarationRecord.content = 'changed content'
      },
      (input: Mutable<PrincipalDeclaredProvenanceInput>) => {
        input.declarationReference.contentDigestSha256 = 'f'.repeat(64)
      },
    ]) {
      const input = mutable(principalInput())
      mutateInput(input)
      expectCode(
        () => createPrincipalDeclaredProvenance(input),
        'CONTENT_DIGEST_MISMATCH',
      )
    }
  })

  it('refuses cross-variant field smuggling after serialization', () => {
    const principal = mutable(
      createPrincipalDeclaredProvenance(principalInput()),
    )
    ;(principal as unknown as Record<string, unknown>).sourceRevision = revision()
    expectCode(
      () => validatePrincipalProvenance(principal),
      'INVALID_PROVENANCE',
    )

    const derived = mutable(createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: revision(),
      authorityGranted: false,
    }))
    ;(derived as unknown as Record<string, unknown>).declarationType = 'INSTRUCTION'
    expectCode(
      () => validatePrincipalProvenance(derived),
      'INVALID_PROVENANCE',
    )
  })

  it('refuses post-construction content and provenance commitment tampering', () => {
    const changedContent = mutable(
      createPrincipalDeclaredProvenance(principalInput()),
    )
    changedContent.content = 'tampered content'
    expectCode(
      () => validatePrincipalProvenance(changedContent),
      'INVALID_PROVENANCE',
    )

    const changedCommitment = mutable(createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: revision(),
      authorityGranted: false,
    }))
    changedCommitment.provenanceId = 'f'.repeat(64)
    expectCode(
      () => validatePrincipalProvenance(changedCommitment),
      'PROVENANCE_DIGEST_MISMATCH',
    )
  })

  it('refuses authority requests at construction and validation boundaries', () => {
    const principalAuthority = {
      ...principalInput(),
      authorityGranted: true,
    }
    expectCode(
      () => createPrincipalDeclaredProvenance(principalAuthority),
      'AUTHORITY_REQUESTED',
    )

    const recordAuthority = mutable(principalInput())
    recordAuthority.declarationRecord.authorityGranted = true as never
    expectCode(
      () => createPrincipalDeclaredProvenance(recordAuthority),
      'AUTHORITY_REQUESTED',
    )

    expectCode(() => createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: revision(),
      authorityGranted: true,
    }), 'AUTHORITY_REQUESTED')

    const stored = mutable(createPrincipalDeclaredProvenance(principalInput()))
    stored.authorityGranted = true as never
    expectCode(
      () => validatePrincipalProvenance(stored),
      'AUTHORITY_REQUESTED',
    )
  })

  it('never grants execution, trading, tool, approval, or bypass authority', () => {
    for (const value of [
      createPrincipalDeclaredProvenance(principalInput()),
      createEvidenceDerivedProvenance({
        schemaVersion: 1,
        revision: revision(),
        authorityGranted: false,
      }),
    ]) {
      expect(value.authorityGranted).toBe(false)
      const serialized = serializePrincipalProvenance(value)
      expect(serialized).not.toContain('executionAuthority')
      expect(serialized).not.toContain('tradingAuthority')
      expect(serialized).not.toContain('approvalGranted')
      expect(serialized).not.toContain('bypass')
    }
  })

  it('is deterministic with stable canonical digests', () => {
    const principalLeft = createPrincipalDeclaredProvenance(principalInput())
    const principalRight = createPrincipalDeclaredProvenance(principalInput())
    expect(principalLeft).toEqual(principalRight)
    expect(principalLeft.provenanceId).toMatch(/^[a-f0-9]{64}$/)
    expect(serializePrincipalProvenance(principalLeft)).toBe(
      serializePrincipalProvenance(principalRight),
    )

    const sourceRevision = revision()
    const derivedLeft = createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: sourceRevision,
      authorityGranted: false,
    })
    const derivedRight = createEvidenceDerivedProvenance({
      authorityGranted: false,
      revision: sourceRevision,
      schemaVersion: 1,
    })
    expect(derivedLeft).toEqual(derivedRight)
  })

  it('deeply freezes cloned outputs without mutating caller-owned inputs', () => {
    const principalCaller = mutable(principalInput())
    const principalBefore = JSON.stringify(principalCaller)
    const principal = createPrincipalDeclaredProvenance(principalCaller)
    expect(JSON.stringify(principalCaller)).toBe(principalBefore)
    expect(Object.isFrozen(principalCaller)).toBe(false)
    expect(Object.isFrozen(principalCaller.declarationReference)).toBe(false)
    expect(Object.isFrozen(principal)).toBe(true)
    expect(Object.isFrozen(principal.declarationReference)).toBe(true)

    const sourceRevision = mutable(revision())
    const derived = createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: sourceRevision,
      authorityGranted: false,
    })
    expect(Object.isFrozen(sourceRevision)).toBe(false)
    expect(Object.isFrozen(derived.sourceRevision)).toBe(true)
    expect(Object.isFrozen(derived.sourceRevision.evidence)).toBe(true)

    const stored = mutable(principal)
    const rehydrated = validatePrincipalProvenance(stored)
    expect(Object.isFrozen(stored)).toBe(false)
    expect(Object.isFrozen(rehydrated)).toBe(true)
  })

  it('performs no clock, network, filesystem, LLM, or persistence access', () => {
    const sourceRevision = revision()
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

    const principal = createPrincipalDeclaredProvenance(principalInput())
    const derived = createEvidenceDerivedProvenance({
      schemaVersion: 1,
      revision: sourceRevision,
      authorityGranted: false,
    })
    expect(validatePrincipalProvenance(principal).authorityGranted).toBe(false)
    expect(validatePrincipalProvenance(derived).authorityGranted).toBe(false)
  })
})

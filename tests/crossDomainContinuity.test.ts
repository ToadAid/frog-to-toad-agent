import { describe, expect, it } from 'vitest'
import {
  createEvidenceSnapshotV1,
  type EvidenceSnapshotV1,
} from '../src/spine/evidence.js'
import {
  createPrincipalLifecycleEvent,
  type PrincipalLifecycleEvent,
} from '../src/memory/principalLifecycle.js'
import {
  projectConversationTranscriptRecordsV1,
  type ConversationEpisodeV1,
} from '../src/memory/conversationEpisodes.js'
import type { ReceiptFinalityRecord } from '../src/safety/receiptFinality.js'
import type { Task } from '../src/store/tasks.js'
import {
  projectCrossDomainContinuityBundleV1,
  projectCrossDomainContinuityIndexV1,
} from '../src/memory/crossDomainContinuity.js'

const TX = `0x${'1'.repeat(64)}`
const FROM = `0x${'2'.repeat(40)}`
const TO = `0x${'3'.repeat(40)}`
const CHAT_SCOPE = '4'.repeat(64)
const RUN_ID = '00000000-0000-4000-8000-000000000005'

function trade(status: ReceiptFinalityRecord['status'] = 'TIMEOUT'): ReceiptFinalityRecord {
  return {
    schemaVersion: 1,
    key: `base:${TX}`,
    txHash: TX,
    chain: 'base',
    status,
    submittedAt: 100,
    assessedAt: 200,
    requiredConfirmations: 2,
    submittedFromAmount: 1,
    minimumToAmount: 0.9,
    balanceToleranceBps: 100,
    rpc: 'https://rpc.example.invalid',
    fromToken: FROM,
    toToken: TO,
    reason: status === 'CONFIRMED' ? undefined : 'not finalized',
    authorityGranted: false,
  }
}

function evidence(): EvidenceSnapshotV1 {
  return createEvidenceSnapshotV1({
    schemaVersion: 1,
    instrument: {
      kind: 'spot',
      symbol: 'ETH',
      instrumentId: 'base:ETH/USD',
      network: 'base',
      address: null,
      venue: 'canonical-research',
    },
    source: {
      producer: 'test',
      provider: 'bounded-research',
      recordId: 'research-record-1',
    },
    unit: { kind: 'USD' },
    eventTime: 10,
    observedAt: 20,
    receivedAt: 30,
    asOf: 40,
    maxAgeMs: 100,
    requiredEvidence: [],
    missingEvidence: [],
    qualityBlockers: [],
    value: 1234,
    authorityGranted: false,
  })
}

function ceremony(): Readonly<PrincipalLifecycleEvent> {
  return createPrincipalLifecycleEvent({
    schemaVersion: 1,
    lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED',
    targetProvenanceId: 'principal-provenance:test-target',
    targetDeclarationId: 'principal-declaration:test-target',
    targetContentDigestSha256: '6'.repeat(64),
    targetDeclarationType: 'INSTRUCTION',
    principalReference: 'telegram:system-owner',
    authenticatedLifecycleReference: {
      schemaVersion: 1,
      source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE',
      lifecycleReferenceId: `principal-lifecycle:${'7'.repeat(64)}`,
      principalReference: 'telegram:system-owner',
      authenticationRecordId: `principal-lifecycle-auth:${'8'.repeat(64)}`,
      authorityGranted: false,
    },
    authorityGranted: false,
  })
}

function task(status: Task['status'] = 'pending'): Task {
  return {
    id: '42',
    subject: 'Sensitive task prose',
    description: 'Do not promote this description into the cross-domain read model.',
    status,
    blocks: [],
    blockedBy: [],
  }
}

function episode(): ConversationEpisodeV1 {
  const projection = projectConversationTranscriptRecordsV1([
    JSON.stringify({
      ts: 300,
      conversationRunId: RUN_ID,
      message: {
        role: 'assistant',
        content: 'Sensitive conversation prose',
      },
    }),
    JSON.stringify({
      ts: 310,
      conversationRunId: RUN_ID,
      runId: 'display-deadbeef',
      agent: 'orchestrator',
      summary: {
        turns: 1,
        toolCalls: 0,
        aborted: false,
        termination: 'FINAL',
      },
    }),
  ], CHAT_SCOPE)
  return projection.episodes[0]!
}

function catalog() {
  return {
    tradeFinality: [trade()],
    researchEvidence: [evidence()],
    principalCeremonies: [ceremony()],
    tasks: [task()],
    conversationEpisodes: [episode()],
  }
}

describe('TEMPORAL-P5 — cross-domain continuity projection', () => {
  it('adapts all five source domains through their source-owned stable identities', () => {
    const index = projectCrossDomainContinuityIndexV1(catalog())

    expect(index.nodes).toHaveLength(5)
    expect(index.nodes.map((node) => [node.domain, node.sourceRef])).toEqual([
      ['CONVERSATION_EPISODE', episode().episodeId],
      ['PRINCIPAL_CEREMONY', ceremony().lifecycleEventId],
      ['RESEARCH_EVIDENCE', evidence().evidenceId],
      ['TASK', '42'],
      ['TRADE_FINALITY', `base:${TX}`],
    ])
    expect(index.nodes.every((node) => node.authorityGranted === false)).toBe(true)
    expect(index.sourceStoreBoundariesPreserved).toBe(true)
    expect(index.sourceTruth).toBe(false)
    expect(index.rebuildable).toBe(true)
  })

  it('is deterministic under source-catalog ordering changes', () => {
    const base = catalog()
    const first = projectCrossDomainContinuityIndexV1(base)
    const second = projectCrossDomainContinuityIndexV1({
      conversationEpisodes: base.conversationEpisodes,
      tasks: base.tasks,
      principalCeremonies: base.principalCeremonies,
      researchEvidence: base.researchEvidence,
      tradeFinality: base.tradeFinality,
    })
    expect(second).toEqual(first)
    expect(second.indexId).toBe(first.indexId)
  })

  it('fails closed with a P5 refusal for malformed catalog lanes or unknown fields', () => {
    expect(() => projectCrossDomainContinuityIndexV1({
      tasks: {} as unknown as Task[],
    })).toThrow(/INVALID_SOURCE_ARTIFACT/)

    expect(() => projectCrossDomainContinuityIndexV1({
      tasks: [],
      unexpectedLane: [],
    } as unknown as Parameters<typeof projectCrossDomainContinuityIndexV1>[0])).toThrow(
      /INVALID_SOURCE_ARTIFACT/,
    )
  })

  it('commits the trade fingerprint to complete finality state while preserving stable identity', () => {
    const firstRecord = trade()
    const secondRecord = {
      ...trade(),
      confirmations: 1,
    }

    const first = projectCrossDomainContinuityIndexV1({
      tradeFinality: [firstRecord],
    }).nodes[0]!
    const second = projectCrossDomainContinuityIndexV1({
      tradeFinality: [secondRecord],
    }).nodes[0]!

    expect(second.nodeId).toBe(first.nodeId)
    expect(second.sourceRef).toBe(first.sourceRef)
    expect(second.sourceFingerprintSha256).not.toBe(first.sourceFingerprintSha256)
  })

  it('refuses an unknown trade-finality status instead of projecting free-form state', () => {
    const malformed = {
      ...trade(),
      status: 'TOTALLY_FINE',
    } as unknown as ReceiptFinalityRecord

    expect(() => projectCrossDomainContinuityIndexV1({
      tradeFinality: [malformed],
    })).toThrow(/INVALID_SOURCE_ARTIFACT/)
  })

  it('refuses duplicate source identities rather than choosing one version', () => {
    expect(() => projectCrossDomainContinuityIndexV1({
      tasks: [task('pending'), task('completed')],
    })).toThrow(/DUPLICATE_SOURCE_REF/)
  })

  it('keeps stable identity separate from mutable task state fingerprint', () => {
    const pending = projectCrossDomainContinuityIndexV1({ tasks: [task('pending')] }).nodes[0]!
    const completed = projectCrossDomainContinuityIndexV1({ tasks: [task('completed')] }).nodes[0]!

    expect(completed.nodeId).toBe(pending.nodeId)
    expect(completed.sourceRef).toBe(pending.sourceRef)
    expect(completed.sourceFingerprintSha256).not.toBe(pending.sourceFingerprintSha256)
    expect(completed.sourceStatus).toBe('completed')
  })

  it('preserves absent task and ceremony time instead of fabricating timestamp continuity', () => {
    const index = projectCrossDomainContinuityIndexV1({
      tasks: [task()],
      principalCeremonies: [ceremony()],
    })

    expect(index.nodes.find((node) => node.domain === 'TASK')?.temporalCoordinates).toEqual([])
    expect(index.nodes.find((node) => node.domain === 'PRINCIPAL_CEREMONY')?.temporalCoordinates).toEqual([])
  })

  it('preserves only source-proven temporal coordinates for timed domains', () => {
    const index = projectCrossDomainContinuityIndexV1({
      tradeFinality: [trade()],
      researchEvidence: [evidence()],
      conversationEpisodes: [episode()],
    })

    expect(index.nodes.find((node) => node.domain === 'TRADE_FINALITY')?.temporalCoordinates)
      .toEqual([
        { kind: 'SUBMITTED_AT', at: 100 },
        { kind: 'ASSESSED_AT', at: 200 },
      ])
    expect(index.nodes.find((node) => node.domain === 'RESEARCH_EVIDENCE')?.temporalCoordinates)
      .toEqual([
        { kind: 'EVENT_TIME', at: 10 },
        { kind: 'OBSERVED_AT', at: 20 },
        { kind: 'RECEIVED_AT', at: 30 },
        { kind: 'AS_OF', at: 40 },
      ])
  })

  it('creates a cross-domain bundle only from explicit exact typed refs', () => {
    const index = projectCrossDomainContinuityIndexV1(catalog())
    const tradeNode = index.nodes.find((node) => node.domain === 'TRADE_FINALITY')!
    const conversationNode = index.nodes.find((node) => node.domain === 'CONVERSATION_EPISODE')!
    const bundle = projectCrossDomainContinuityBundleV1(index, [
      { domain: tradeNode.domain, sourceRef: tradeNode.sourceRef },
      { domain: conversationNode.domain, sourceRef: conversationNode.sourceRef },
    ])

    expect(bundle.correlationBasis).toBe('EXPLICIT_TYPED_REFERENCE_SET')
    expect(bundle.domains).toEqual(['CONVERSATION_EPISODE', 'TRADE_FINALITY'])
    expect(bundle.relationshipProven).toBe(false)
    expect(bundle.causationProven).toBe(false)
    expect(bundle.temporalProximityUsedAsEvidence).toBe(false)
    expect(bundle.sourceStoreBoundariesPreserved).toBe(true)
    expect(bundle.authorityGranted).toBe(false)
  })

  it('does not leak free-form task, evidence, or conversation prose into the P5 projection', () => {
    const index = projectCrossDomainContinuityIndexV1(catalog())
    const rendered = JSON.stringify(index)

    expect(rendered).not.toContain('Sensitive task prose')
    expect(rendered).not.toContain('Do not promote this description')
    expect(rendered).not.toContain('Sensitive conversation prose')
    expect(rendered).not.toContain('1234')
  })

  it('refuses missing, duplicate, and same-domain-only join requests', () => {
    const index = projectCrossDomainContinuityIndexV1(catalog())
    const taskNode = index.nodes.find((node) => node.domain === 'TASK')!
    const tradeNode = index.nodes.find((node) => node.domain === 'TRADE_FINALITY')!

    expect(() => projectCrossDomainContinuityBundleV1(index, [
      { domain: taskNode.domain, sourceRef: taskNode.sourceRef },
      { domain: 'RESEARCH_EVIDENCE', sourceRef: 'f'.repeat(64) },
    ])).toThrow(/MISSING_SOURCE_REF/)

    expect(() => projectCrossDomainContinuityBundleV1(index, [
      { domain: taskNode.domain, sourceRef: taskNode.sourceRef },
      { domain: taskNode.domain, sourceRef: taskNode.sourceRef },
    ])).toThrow(/DUPLICATE_JOIN_REF/)

    expect(() => projectCrossDomainContinuityBundleV1(
      projectCrossDomainContinuityIndexV1({
        tradeFinality: [trade()],
        tasks: [
          task(),
          { ...task(), id: '43', subject: 'other' },
        ],
      }),
      [
        { domain: tradeNode.domain, sourceRef: tradeNode.sourceRef },
        { domain: 'TRADE_FINALITY', sourceRef: tradeNode.sourceRef },
      ],
    )).toThrow(/DUPLICATE_JOIN_REF/)
  })

  it('requires at least two distinct domains even when two source refs exist', () => {
    const first = { ...task(), id: '42' }
    const second = { ...task(), id: '43' }
    const index = projectCrossDomainContinuityIndexV1({ tasks: [first, second] })

    expect(() => projectCrossDomainContinuityBundleV1(index, [
      { domain: 'TASK', sourceRef: '42' },
      { domain: 'TASK', sourceRef: '43' },
    ])).toThrow(/CROSS_DOMAIN_REQUIRED/)
  })

  it('fails closed when an authority-bearing source artifact is supplied', () => {
    const badTrade = { ...trade(), authorityGranted: true } as unknown as ReceiptFinalityRecord
    const badConversation = { ...episode(), authorityGranted: true } as unknown as ConversationEpisodeV1

    expect(() => projectCrossDomainContinuityIndexV1({
      tradeFinality: [badTrade],
    })).toThrow(/AUTHORITY_REQUESTED/)

    expect(() => projectCrossDomainContinuityIndexV1({
      conversationEpisodes: [badConversation],
    })).toThrow(/AUTHORITY_REQUESTED/)
  })

  it('re-proves canonical research evidence and refuses tampered digest', () => {
    const canonical = evidence()
    const tampered = {
      ...canonical,
      digest: 'f'.repeat(64),
    } as EvidenceSnapshotV1

    expect(() => projectCrossDomainContinuityIndexV1({
      researchEvidence: [tampered],
    })).toThrow(/INVALID_SOURCE_ARTIFACT/)
  })

  it('re-proves canonical ceremony identity and refuses tampered lifecycleEventId', () => {
    const canonical = ceremony()
    const tampered = {
      ...canonical,
      lifecycleEventId: 'f'.repeat(64),
    } as PrincipalLifecycleEvent

    expect(() => projectCrossDomainContinuityIndexV1({
      principalCeremonies: [tampered],
    })).toThrow(/INVALID_SOURCE_ARTIFACT/)
  })

  it('re-proves P4 episode identity/projection digest and refuses tampering', () => {
    const canonical = episode()
    const tampered = {
      ...canonical,
      episodeId: 'f'.repeat(64),
    } as ConversationEpisodeV1

    expect(() => projectCrossDomainContinuityIndexV1({
      conversationEpisodes: [tampered],
    })).toThrow(/INVALID_SOURCE_ARTIFACT/)
  })

  it('never converts shared timing into a causal or semantic relation', () => {
    const sameTimeTrade = { ...trade(), submittedAt: 300, assessedAt: 300 }
    const conversation = episode()
    const index = projectCrossDomainContinuityIndexV1({
      tradeFinality: [sameTimeTrade],
      conversationEpisodes: [conversation],
    })
    const tradeNode = index.nodes.find((node) => node.domain === 'TRADE_FINALITY')!
    const conversationNode = index.nodes.find((node) => node.domain === 'CONVERSATION_EPISODE')!

    const bundle = projectCrossDomainContinuityBundleV1(index, [
      { domain: tradeNode.domain, sourceRef: tradeNode.sourceRef },
      { domain: conversationNode.domain, sourceRef: conversationNode.sourceRef },
    ])

    expect(index.temporalProximityIsNotCausation).toBe(true)
    expect(bundle.causationProven).toBe(false)
    expect(bundle.relationshipProven).toBe(false)
    expect(bundle.temporalProximityUsedAsEvidence).toBe(false)
  })
})

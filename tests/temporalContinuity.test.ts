import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEvidenceSnapshotV1 } from '../src/spine/evidence.js'
import { appendJsonl } from '../src/store/jsonl.js'
import { journalPath, readJournal } from '../src/tools/journal.js'
import {
  createTemporalContinuityEventV1,
  decodeTemporalContinuityEventV1,
  knowledgeAtV1,
  projectEvidenceSnapshotTemporalEventV1,
  projectJournalTemporalEventV1,
  projectJournalTemporalEventsV1,
  reconstructDecisionTimelineV1,
} from '../src/memory/temporalContinuity.js'

function evidenceSnapshot(input: {
  eventTime?: number
  observedAt?: number
  receivedAt?: number
  asOf?: number
  maxAgeMs?: number
  recordId?: string
  missingEvidence?: string[]
  qualityBlockers?: Array<{ code: string; detail: string }>
} = {}) {
  const eventTime = input.eventTime ?? 100
  const observedAt = input.observedAt ?? 110
  const receivedAt = input.receivedAt ?? 120
  const asOf = input.asOf ?? receivedAt
  return createEvidenceSnapshotV1({
    schemaVersion: 1,
    instrument: {
      kind: 'SPOT',
      symbol: 'ETH',
      instrumentId: 'base:ETH-USD',
      network: 'base',
      address: null,
      venue: 'fixture',
    },
    source: {
      producer: 'temporal-p1-test',
      provider: 'fixture',
      recordId: input.recordId ?? 'price-1',
    },
    unit: { kind: 'USD' },
    eventTime,
    observedAt,
    receivedAt,
    asOf,
    maxAgeMs: input.maxAgeMs ?? 60_000,
    requiredEvidence: ['price'],
    missingEvidence: input.missingEvidence ?? [],
    qualityBlockers: input.qualityBlockers ?? [],
    value: 2500,
    authorityGranted: false,
  })
}

function decision(ts = 200, ref = 'jrnl_test_1') {
  return projectJournalTemporalEventV1({
    journalRef: ref,
    ts,
    symbol: 'ETH',
    decision: 'paper entry only after evidence gate',
    runId: 'run-temporal-p1',
  })
}

describe('TEMPORAL-CONTINUITY-P1 — canonical temporal event lens', () => {
  it('keeps occurred, observed, and knowledge-availability time distinct', () => {
    const event = projectEvidenceSnapshotTemporalEventV1(evidenceSnapshot({
      eventTime: 100,
      observedAt: 110,
      receivedAt: 130,
      asOf: 130,
    }))
    expect(event).toMatchObject({
      eventType: 'EVIDENCE_OBSERVED',
      occurredAt: 100,
      observedAt: 110,
      knownAt: 130,
      authorityGranted: false,
      source: {
        store: 'evidence-snapshot',
        provenance: 'ORIGINAL_SOURCE_REF',
      },
    })
  })

  it('is deterministic, content-addressed, and refuses post-construction tampering', () => {
    const first = decision()
    const second = decision()
    expect(first.eventId).toBe(second.eventId)
    expect(first.eventId).toMatch(/^[a-f0-9]{64}$/)

    expect(() => decodeTemporalContinuityEventV1({
      ...first,
      knownAt: first.knownAt + 1,
    })).toThrow(/EVENT_ID_MISMATCH/)
  })

  it('fixes temporal authority at false', () => {
    const event = decision()
    expect(event.authorityGranted).toBe(false)
    expect(() => createTemporalContinuityEventV1({
      schemaVersion: 1,
      eventType: 'JOURNAL_DECISION_RECORDED',
      source: event.source,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      knownAt: event.knownAt,
      freshness: event.freshness,
      episodeId: event.episodeId,
      correlationId: event.correlationId,
      causation: { kind: 'UNPROVEN' },
      evidenceRefs: event.evidenceRefs,
      eventData: event.eventData,
      authorityGranted: true,
    } as never)).toThrow(/AUTHORITY_REQUESTED/)
  })

  it('refuses positive causation until a later source-verification contract can prove it', () => {
    const event = decision()
    expect(() => createTemporalContinuityEventV1({
      schemaVersion: 1,
      eventType: 'JOURNAL_DECISION_RECORDED',
      source: event.source,
      occurredAt: 210,
      observedAt: 210,
      knownAt: 210,
      freshness: { kind: 'HISTORICAL' },
      episodeId: 'run:causal-test',
      correlationId: 'journal:causal-test',
      causation: {
        kind: 'EVIDENCED',
        causeEventId: event.eventId,
        evidenceRefs: [event.source.recordId],
      },
      evidenceRefs: [event.source.recordId],
      eventData: { note: 'shape-only refs are not causal proof' },
      authorityGranted: false,
    } as never)).toThrow(/INVALID_CAUSATION/)
  })

  it('marks journal rows without journalRef as DERIVED_LEGACY and never invents an original ref', () => {
    const legacy = projectJournalTemporalEventV1({
      ts: 300,
      symbol: 'BTC',
      decision: 'legacy row',
    })
    expect(legacy.source.provenance).toBe('DERIVED_LEGACY')
    expect(legacy.source.recordId).toBe(`legacy-journal:${legacy.source.contentDigestSha256}`)
    expect(legacy.evidenceRefs).toEqual([])
  })

  it('rejects unknown legacy journal fields instead of silently absorbing new semantics', () => {
    expect(() => projectJournalTemporalEventV1({
      ts: 300,
      symbol: 'BTC',
      decision: 'legacy row',
      surpriseAuthority: true,
    } as never)).toThrow(/INVALID_JOURNAL_ENTRY/)
  })

  it('demotes stale evidence to history without deleting it', () => {
    const evidence = projectEvidenceSnapshotTemporalEventV1(evidenceSnapshot({
      eventTime: 100,
      observedAt: 100,
      receivedAt: 110,
      asOf: 110,
      maxAgeMs: 20,
    }))
    const projection = knowledgeAtV1([evidence], 200)
    expect(projection.freshEvidence).toEqual([])
    expect(projection.history.map((event) => event.eventId)).toEqual([evidence.eventId])
    expect(projection.known.map((event) => event.eventId)).toEqual([evidence.eventId])
    expect(projection.authorityGranted).toBe(false)
  })

  it('keeps freshness separate from fitness — fresh-but-UNREADY never becomes an admissibility claim', () => {
    const evidence = projectEvidenceSnapshotTemporalEventV1(evidenceSnapshot({
      eventTime: 100,
      observedAt: 100,
      receivedAt: 110,
      asOf: 110,
      maxAgeMs: 1_000,
      missingEvidence: ['price'],
      recordId: 'fresh-but-unready',
    }))
    const projection = knowledgeAtV1([evidence], 120)
    expect(projection.freshEvidence.map((event) => event.eventId)).toEqual([evidence.eventId])
    expect(evidence.eventData).toMatchObject({
      sourceFitnessStatusAtSourceAsOf: 'UNREADY',
      sourceAsOf: 110,
    })
    expect(projection).not.toHaveProperty('currentEvidence')
  })

  it('proves the real journal.jsonl → readJournal → temporal projection → decision timeline path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-p1-journal-'))
    try {
      const cfg = { paths: { dataDir: dir } } as never
      appendJsonl(journalPath(cfg), {
        journalRef: 'jrnl_vertical_context',
        ts: 100,
        symbol: 'ETH',
        decision: 'earlier paper context',
        runId: 'run-vertical',
      })
      appendJsonl(journalPath(cfg), {
        journalRef: 'jrnl_vertical_decision',
        ts: 200,
        symbol: 'ETH',
        decision: 'paper decision under review',
        runId: 'run-vertical',
      })

      const rows = readJournal(cfg)
      expect(rows).toHaveLength(2)
      const events = projectJournalTemporalEventsV1(rows)
      const target = events.find((event) => event.source.recordId === 'jrnl_vertical_decision')
      expect(target).toBeDefined()

      const timeline = reconstructDecisionTimelineV1(events, target!.eventId)
      expect(timeline.decision.source.recordId).toBe('jrnl_vertical_decision')
      expect(timeline.before.map((event) => event.source.recordId)).toEqual(['jrnl_vertical_context'])
      expect(timeline.knowledgeBeforeDecision.known.map((event) => event.source.recordId))
        .toEqual(['jrnl_vertical_context'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prevents back-projection when evidence was observed before a decision but received later', () => {
    const lateEvidence = projectEvidenceSnapshotTemporalEventV1(evidenceSnapshot({
      eventTime: 90,
      observedAt: 100,
      receivedAt: 220,
      asOf: 220,
      recordId: 'late-price',
    }))
    const tradeDecision = decision(200)
    const timeline = reconstructDecisionTimelineV1(
      [lateEvidence, tradeDecision],
      tradeDecision.eventId,
    )

    expect(lateEvidence.observedAt).toBeLessThan(tradeDecision.knownAt)
    expect(lateEvidence.knownAt).toBeGreaterThan(tradeDecision.knownAt)
    expect(timeline.knowledgeBeforeDecision.known).toEqual([])
    expect(timeline.after.map((event) => event.eventId)).toEqual([lateEvidence.eventId])
  })

  it('does not pretend same-knownAt events have a proven sequence', () => {
    const tradeDecision = decision(200, 'jrnl_same_time_decision')
    const other = projectJournalTemporalEventV1({
      journalRef: 'jrnl_same_time_other',
      ts: 200,
      symbol: 'BTC',
      decision: 'another event at the same source timestamp',
    })
    const timeline = reconstructDecisionTimelineV1([tradeDecision, other], tradeDecision.eventId)
    expect(timeline.before).toEqual([])
    expect(timeline.knowledgeBeforeDecision.known).toEqual([])
    expect(timeline.coTemporalUnordered.map((event) => event.eventId)).toEqual([other.eventId])
    expect(timeline.ordering).toEqual({
      causal: false,
      rule: 'KNOWN_AT_OBSERVED_AT_OCCURRED_AT_EVENT_ID',
      coTemporalOrder: 'UNPROVEN',
    })
  })

  it('projects journal history deterministically regardless of caller order', () => {
    const rows = [
      { journalRef: 'jrnl_b', ts: 200, symbol: 'ETH', decision: 'second' },
      { journalRef: 'jrnl_a', ts: 100, symbol: 'ETH', decision: 'first' },
    ]
    const forward = projectJournalTemporalEventsV1(rows)
    const reverse = projectJournalTemporalEventsV1([...rows].reverse())
    expect(forward.map((event) => event.eventId)).toEqual(reverse.map((event) => event.eventId))
    expect(forward.map((event) => event.knownAt)).toEqual([100, 200])
  })
})

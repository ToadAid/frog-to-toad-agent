import { describe, expect, it } from 'vitest'
import {
  projectJournalTemporalEventV1,
  type TemporalContinuityEventV1,
} from '../src/memory/temporalContinuity.js'
import {
  historicalEpisodeStateAtV1,
  reconstructEpisodeAroundEventV1,
  stitchTemporalEpisodeV1,
  stitchTemporalEpisodesV1,
} from '../src/memory/temporalEpisodes.js'

function journalEvent(input: {
  ref: string
  ts: number
  runId: string
  symbol?: string
}): TemporalContinuityEventV1 {
  return projectJournalTemporalEventV1({
    journalRef: input.ref,
    ts: input.ts,
    symbol: input.symbol ?? 'ETH',
    decision: `decision:${input.ref}`,
    runId: input.runId,
  })
}

describe('TEMPORAL-P2 — episode stitching + historical state view', () => {
  it('stitches only existing episodeId membership and is deterministic across caller order', () => {
    const a1 = journalEvent({ ref: 'jrnl_a1', ts: 100, runId: 'a' })
    const a2 = journalEvent({ ref: 'jrnl_a2', ts: 200, runId: 'a' })
    const b1 = journalEvent({ ref: 'jrnl_b1', ts: 150, runId: 'b' })

    const forward = stitchTemporalEpisodesV1([a2, b1, a1])
    const reverse = stitchTemporalEpisodesV1([a1, b1, a2].reverse())

    expect(forward.map((episode) => episode.projectionId))
      .toEqual(reverse.map((episode) => episode.projectionId))
    expect(forward.map((episode) => episode.episodeId)).toEqual(['run:a', 'run:b'])
    expect(forward[0]!.eventIds).toEqual([a1.eventId, a2.eventId])
    expect(forward[1]!.eventIds).toEqual([b1.eventId])
  })

  it('never stitches by temporal proximity or correlation when episodeId differs', () => {
    const first = journalEvent({ ref: 'jrnl_near_1', ts: 100, runId: 'one' })
    const second = journalEvent({ ref: 'jrnl_near_2', ts: 101, runId: 'two' })
    const episodes = stitchTemporalEpisodesV1([first, second])
    expect(episodes).toHaveLength(2)
    expect(episodes.map((episode) => episode.eventIds)).toEqual([
      [first.eventId],
      [second.eventId],
    ])
  })

  it('preserves source provenance instead of flattening source history', () => {
    const original = journalEvent({ ref: 'jrnl_original', ts: 100, runId: 'prov' })
    const legacy = projectJournalTemporalEventV1({
      ts: 110,
      symbol: 'BTC',
      decision: 'legacy',
      runId: 'prov',
    })
    const episode = stitchTemporalEpisodeV1([legacy, original], 'run:prov')

    expect(episode.sourceCoverage).toEqual([
      {
        store: 'journal',
        provenance: 'DERIVED_LEGACY',
        eventCount: 1,
        recordIds: [legacy.source.recordId],
      },
      {
        store: 'journal',
        provenance: 'ORIGINAL_SOURCE_REF',
        eventCount: 1,
        recordIds: ['jrnl_original'],
      },
    ])
  })

  it('preserves same-knownAt events as COTEMPORAL_UNORDERED', () => {
    const first = journalEvent({ ref: 'jrnl_same_1', ts: 100, runId: 'same' })
    const second = journalEvent({ ref: 'jrnl_same_2', ts: 100, runId: 'same' })
    const episode = stitchTemporalEpisodeV1([second, first], 'run:same')

    expect(episode.moments).toHaveLength(1)
    expect(episode.moments[0]!.knownAt).toBe(100)
    expect(episode.moments[0]!.order).toBe('COTEMPORAL_UNORDERED')
    expect(new Set(episode.moments[0]!.events.map((event) => event.eventId)))
      .toEqual(new Set([first.eventId, second.eventId]))
  })

  it('never infers a gap from elapsed time alone', () => {
    const first = journalEvent({ ref: 'jrnl_far_1', ts: 1, runId: 'far' })
    const second = journalEvent({ ref: 'jrnl_far_2', ts: 9_999_999, runId: 'far' })
    const episode = stitchTemporalEpisodeV1([first, second], 'run:far')

    expect(episode.gapAssessment).toEqual({
      basis: 'NONE',
      status: 'NOT_ASSESSED',
      gaps: [],
      completenessProven: false,
    })
  })

  it('reports only explicit expected-event gaps and still refuses to claim completeness', () => {
    const present = journalEvent({ ref: 'jrnl_gap_present', ts: 100, runId: 'gap' })
    const missing = 'f'.repeat(64)
    const episode = stitchTemporalEpisodeV1(
      [present],
      'run:gap',
      [present.eventId, missing],
    )

    expect(episode.gapAssessment).toEqual({
      basis: 'EXPLICIT_EXPECTATION',
      status: 'EXPLICIT_GAPS_PRESENT',
      gaps: [{
        kind: 'EXPECTED_EVENT_MISSING',
        expectedEventId: missing,
        basis: 'EXPLICIT_EXPECTATION',
      }],
      completenessProven: false,
    })
  })

  it('an explicitly satisfied expectation still does not prove whole-episode completeness', () => {
    const present = journalEvent({ ref: 'jrnl_expected', ts: 100, runId: 'expected' })
    const episode = stitchTemporalEpisodeV1([present], 'run:expected', [present.eventId])
    expect(episode.gapAssessment).toEqual({
      basis: 'EXPLICIT_EXPECTATION',
      status: 'EXPECTATION_SATISFIED',
      gaps: [],
      completenessProven: false,
    })
  })

  it('reconstructs historical episode state without back-projecting later-known events', () => {
    const early = journalEvent({ ref: 'jrnl_early', ts: 100, runId: 'history' })
    const later = journalEvent({ ref: 'jrnl_later', ts: 300, runId: 'history' })
    const state = historicalEpisodeStateAtV1([later, early], 'run:history', 200)

    expect(state.knowledge.known.map((event) => event.eventId)).toEqual([early.eventId])
    expect(state.knowledge.future.map((event) => event.eventId)).toEqual([later.eventId])
    expect(state.knownMoments).toHaveLength(1)
    expect(state.knownMoments[0]!.events[0]!.eventId).toBe(early.eventId)
    expect(state.authorityGranted).toBe(false)
    expect(state.causation).toBe('UNPROVEN')
  })

  it('answers what happened around an event with before / co-temporal / after only', () => {
    const before = journalEvent({ ref: 'jrnl_before', ts: 100, runId: 'around' })
    const anchor = journalEvent({ ref: 'jrnl_anchor', ts: 200, runId: 'around' })
    const same = journalEvent({ ref: 'jrnl_same', ts: 200, runId: 'around' })
    const after = journalEvent({ ref: 'jrnl_after', ts: 300, runId: 'around' })
    const otherEpisode = journalEvent({ ref: 'jrnl_other', ts: 150, runId: 'other' })

    const view = reconstructEpisodeAroundEventV1(
      [same, otherEpisode, after, anchor, before],
      anchor.eventId,
    )

    expect(view.episodeId).toBe('run:around')
    expect(view.before.map((event) => event.eventId)).toEqual([before.eventId])
    expect(view.coTemporalUnordered.map((event) => event.eventId)).toEqual([same.eventId])
    expect(view.after.map((event) => event.eventId)).toEqual([after.eventId])
    expect(view.ordering).toEqual({
      causal: false,
      rule: 'KNOWN_AT_OBSERVED_AT_OCCURRED_AT_EVENT_ID',
      coTemporalOrder: 'UNPROVEN',
    })
    expect(view).not.toHaveProperty('narrative')
  })

  it('refuses duplicate temporal events instead of silently de-duplicating history', () => {
    const event = journalEvent({ ref: 'jrnl_dup', ts: 100, runId: 'dup' })
    expect(() => stitchTemporalEpisodesV1([event, event])).toThrow(/DUPLICATE_EVENT/)
  })

  it('refuses an episode query that has no source event', () => {
    const event = journalEvent({ ref: 'jrnl_exists', ts: 100, runId: 'exists' })
    expect(() => stitchTemporalEpisodeV1([event], 'run:not-there')).toThrow(/EPISODE_NOT_FOUND/)
  })

  it('refuses malformed explicit expected ids', () => {
    const event = journalEvent({ ref: 'jrnl_expected_bad', ts: 100, runId: 'expected-bad' })
    expect(() => stitchTemporalEpisodeV1([event], 'run:expected-bad', ['not-a-digest']))
      .toThrow(/INVALID_EXPECTED_EVENT_ID/)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { resolveCanonicalEvidence } from '../src/memory/canonicalEvidence.js'
import {
  digestDevelopmentalMemory,
  type DevelopmentalMemoryBudget,
  type DevelopmentalMemoryEvidence,
  type DevelopmentalMemoryProposal,
} from '../src/memory/developmentalMemory.js'
import {
  developMemoryDurably,
  developmentalMemoryStorePath,
  loadDevelopmentalMemoryStore,
} from '../src/memory/developmentalStore.js'

const budget: DevelopmentalMemoryBudget = {
  maximumMemories: 8,
  maximumRevisions: 32,
  maximumEvidencePerMemory: 12,
  maximumSummaryCharacters: 240,
}

let root: string
let cfg: Config

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-developmental-store-'))
  process.env.TRADING_DESK_DIR = root
  process.env.SELFTEST = '1'
  cfg = loadConfig()
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function appendJournal(records: unknown[]): void {
  const file = path.join(cfg.paths.dataDir, 'journal.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((value) => JSON.stringify(value)).join('\n') + '\n')
}

function evidence(recordId = 'journal:1'): DevelopmentalMemoryEvidence {
  return {
    ...resolveCanonicalEvidence(cfg, 'journal', recordId),
    role: 'supports',
  }
}

function proposal(
  supportingEvidence: DevelopmentalMemoryEvidence[],
  overrides: Partial<DevelopmentalMemoryProposal> = {},
): DevelopmentalMemoryProposal {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-1',
    memoryId: 'memory-1',
    previousRevisionId: null,
    kind: 'lesson',
    summary: 'Preserve invalidation discipline.',
    supportingEvidence,
    contradictingEvidence: [],
    authorityGranted: false,
    ...overrides,
  }
}

function twoJournalCycles(): void {
  appendJournal([
    { ts: 1, symbol: 'BTC', decision: 'first', runId: 'cycle-1' },
    { ts: 2, symbol: 'BTC', decision: 'second', runId: 'cycle-2' },
  ])
}

describe('P1B durable developmental revision store', () => {
  it('loads an absent store as empty without creating a file', () => {
    expect(loadDevelopmentalMemoryStore(cfg)).toEqual({ schemaVersion: 1, revisions: [] })
    expect(fs.existsSync(developmentalMemoryStorePath(cfg))).toBe(false)
  })

  it('cannot turn three records with unknown cycle provenance into maturity', () => {
    appendJournal([
      { ts: 1, symbol: 'BTC', decision: 'first' },
      { ts: 2, symbol: 'BTC', decision: 'second' },
      { ts: 3, symbol: 'BTC', decision: 'third' },
    ])
    for (const recordId of ['journal:1', 'journal:2', 'journal:3']) {
      expect(() => resolveCanonicalEvidence(cfg, 'journal', recordId)).toThrow(/runId is required/)
    }
    expect(fs.existsSync(developmentalMemoryStorePath(cfg))).toBe(false)
  })

  it('refuses a symlinked memory parent before outside read or write', () => {
    appendJournal([{ ts: 1, symbol: 'BTC', decision: 'first', runId: 'cycle-1' }])
    const external = path.join(root, 'outside-memory')
    fs.mkdirSync(external)
    const outsideStore = path.join(external, 'developmental-revisions.jsonl')
    fs.writeFileSync(outsideStore, 'OUTSIDE_BYTES')
    fs.symlinkSync(external, path.join(cfg.paths.dataDir, 'memory'), 'dir')

    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/parent must not be a symlink/)
    expect(() => developMemoryDurably(cfg, proposal([evidence()]), budget)).toThrow(/parent must not be a symlink/)
    expect(fs.readFileSync(outsideStore, 'utf8')).toBe('OUTSIDE_BYTES')
  })

  it('refuses a symlinked store file before outside read or write', () => {
    appendJournal([{ ts: 1, symbol: 'BTC', decision: 'first', runId: 'cycle-1' }])
    const memoryDir = path.join(cfg.paths.dataDir, 'memory')
    fs.mkdirSync(memoryDir)
    const outsideStore = path.join(root, 'outside-revisions.jsonl')
    fs.writeFileSync(outsideStore, 'OUTSIDE_FILE_BYTES')
    fs.symlinkSync(outsideStore, developmentalMemoryStorePath(cfg), 'file')

    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/store must not be a symlink/)
    expect(() => developMemoryDurably(cfg, proposal([evidence()]), budget)).toThrow(/store must not be a symlink/)
    expect(fs.readFileSync(outsideStore, 'utf8')).toBe('OUTSIDE_FILE_BYTES')
  })

  it('appends one first revision and replays it exactly across restart', () => {
    twoJournalCycles()
    const result = developMemoryDurably(cfg, proposal([evidence()]), budget)
    expect(result.status).toBe('developed')
    if (result.status !== 'developed') return
    const bytes = fs.readFileSync(developmentalMemoryStorePath(cfg), 'utf8')
    expect(bytes.trim().split('\n')).toHaveLength(1)
    expect(loadDevelopmentalMemoryStore(cfg)).toEqual(result.store)
    expect(digestDevelopmentalMemory(loadDevelopmentalMemoryStore(cfg)))
      .toBe(digestDevelopmentalMemory(result.store))
  })

  it('appends a child revision and preserves the immutable chain on reload', () => {
    twoJournalCycles()
    const first = developMemoryDurably(cfg, proposal([evidence()]), budget)
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return
    const second = developMemoryDurably(cfg, proposal([evidence('journal:2')], {
      proposalId: 'proposal-2',
      previousRevisionId: first.revision.revisionId,
      summary: 'Preserve invalidation discipline across repeated cycles.',
    }), budget)
    expect(second.status).toBe('developed')
    if (second.status !== 'developed') return
    const replayed = loadDevelopmentalMemoryStore(cfg)
    expect(replayed.revisions).toHaveLength(2)
    expect(replayed.revisions[1]!.previousRevisionId).toBe(replayed.revisions[0]!.revisionId)
    expect(replayed.revisions[1]!.evidence).toHaveLength(2)
    expect(digestDevelopmentalMemory(replayed)).toBe(digestDevelopmentalMemory(second.store))
  })

  it('performs zero append when P1A refuses duplicate proposal or stale revision', () => {
    twoJournalCycles()
    const firstProposal = proposal([evidence()])
    const first = developMemoryDurably(cfg, firstProposal, budget)
    expect(first.status).toBe('developed')
    const before = fs.readFileSync(developmentalMemoryStorePath(cfg))

    expect(developMemoryDurably(cfg, firstProposal, budget)).toEqual({ status: 'refused', reason: 'duplicate_proposal' })
    expect(developMemoryDurably(cfg, proposal([evidence('journal:2')], { proposalId: 'proposal-2' }), budget))
      .toEqual({ status: 'refused', reason: 'stale_revision' })
    expect(fs.readFileSync(developmentalMemoryStorePath(cfg))).toEqual(before)
  })

  it('performs zero append when canonical evidence changed after reference creation', () => {
    twoJournalCycles()
    const ref = evidence()
    appendJournal([
      { ts: 1, symbol: 'BTC', decision: 'mutated', runId: 'cycle-1' },
      { ts: 2, symbol: 'BTC', decision: 'second', runId: 'cycle-2' },
    ])
    expect(() => developMemoryDurably(cfg, proposal([ref]), budget)).toThrow(/digest mismatch/)
    expect(fs.existsSync(developmentalMemoryStorePath(cfg))).toBe(false)
  })

  it('refuses tampered summaries and forged revision commitments on reload', () => {
    twoJournalCycles()
    const result = developMemoryDurably(cfg, proposal([evidence()]), budget)
    expect(result.status).toBe('developed')
    if (result.status !== 'developed') return
    const original = JSON.parse(fs.readFileSync(developmentalMemoryStorePath(cfg), 'utf8'))

    fs.writeFileSync(developmentalMemoryStorePath(cfg), JSON.stringify({ ...original, summary: 'tampered' }) + '\n')
    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/invalid developmental memory store/)

    fs.writeFileSync(developmentalMemoryStorePath(cfg), JSON.stringify({ ...original, revisionId: '0'.repeat(64) }) + '\n')
    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/invalid developmental memory store/)
  })

  it('rejects malformed JSONL, including a partial trailing revision', () => {
    const file = developmentalMemoryStorePath(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"partial"')
    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/JSONL at line 1/)
  })

  it('rejects chain gaps, duplicate IDs, and duplicate proposal IDs on replay', () => {
    twoJournalCycles()
    const first = developMemoryDurably(cfg, proposal([evidence()]), budget)
    expect(first.status).toBe('developed')
    if (first.status !== 'developed') return
    const line = fs.readFileSync(developmentalMemoryStorePath(cfg), 'utf8').trim()
    fs.writeFileSync(developmentalMemoryStorePath(cfg), `${line}\n${line}\n`)
    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/invalid developmental memory store/)

    fs.writeFileSync(developmentalMemoryStorePath(cfg), `${line}\n`)
    const second = developMemoryDurably(cfg, proposal([evidence('journal:2')], {
      proposalId: 'proposal-2',
      previousRevisionId: first.revision.revisionId,
    }), budget)
    expect(second.status).toBe('developed')
    if (second.status !== 'developed') return
    fs.writeFileSync(developmentalMemoryStorePath(cfg), JSON.stringify(second.revision) + '\n')
    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/invalid developmental memory store/)
  })

  it('never restores or introduces authority', () => {
    twoJournalCycles()
    const result = developMemoryDurably(cfg, proposal([evidence()]), budget)
    expect(result.status).toBe('developed')
    if (result.status !== 'developed') return
    const forged = { ...result.revision, authorityGranted: true }
    fs.writeFileSync(developmentalMemoryStorePath(cfg), JSON.stringify(forged) + '\n')
    expect(() => loadDevelopmentalMemoryStore(cfg)).toThrow(/invalid developmental memory store/)
  })
})

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { resolveCanonicalEvidence } from '../src/memory/canonicalEvidence.js'
import {
  digestCanonicalJson,
  digestDevelopmentalMemory,
  type DevelopmentalMemoryBudget,
} from '../src/memory/developmentalMemory.js'
import { developMemoryDurably, developmentalMemoryStorePath, loadDevelopmentalMemoryStore } from '../src/memory/developmentalStore.js'
import {
  admitPrincipalDeclaration,
  loadPrincipalProvenanceCatalog,
  principalProvenanceStorePath,
} from '../src/memory/principalAdmission.js'
import {
  appendPrincipalLifecycleEvent,
  createPrincipalLifecycleEvent,
  loadCoherentPrincipalLifecycleState,
  principalLifecycleStorePath,
} from '../src/memory/principalLifecycle.js'
import type { PrincipalDeclaredProvenance } from '../src/memory/principalProvenance.js'
import {
  DURABILITY_MANIFEST,
  DURABILITY_SCHEMA_VERSION,
  assertSafeDurabilityPath,
  createDurabilitySnapshot,
  loadSnapshotManifest,
  parseSnapshotManifest,
  rehearseSnapshotRecovery,
  serializeSnapshotManifest,
} from '../src/store/durability.js'

let root: string
let cfg: Config

const memoryBudget: DevelopmentalMemoryBudget = {
  maximumMemories: 4,
  maximumRevisions: 16,
  maximumEvidencePerMemory: 8,
  maximumSummaryCharacters: 200,
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-durability-'))
  process.env['TRADING_DESK_DIR'] = root
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
  write('workspace/USER.md', 'principal memory\n')
  write('workspace/DESK.md', 'desk memory\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relativePath: string, content: string | Buffer): void {
  const target = path.join(cfg.paths.dataDir, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function captured(now = 1_000): { dir: string; manifest: ReturnType<typeof loadSnapshotManifest> } {
  const result = createDurabilitySnapshot(cfg, { now })
  expect(result.status).toBe('captured')
  expect(result.failed).toEqual([])
  return { dir: result.snapshotDir!, manifest: loadSnapshotManifest(result.snapshotDir!) }
}

function recoveryDir(): string {
  const destination = path.join(root, `recovery-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(destination)
  return destination
}

function writeDevelopmentalRevision(): void {
  write('journal.jsonl', '{"ts":1,"symbol":"BTC","decision":"fixture","runId":"cycle-1"}\n')
  const canonical = resolveCanonicalEvidence(cfg, 'journal', 'journal:1')
  const outcome = developMemoryDurably(cfg, {
    schemaVersion: 1,
    proposalId: 'proposal-durability-1',
    memoryId: 'memory-durability-1',
    previousRevisionId: null,
    kind: 'lesson',
    summary: 'A durable evidence-grounded lesson.',
    supportingEvidence: [{ ...canonical, role: 'supports' }],
    contradictingEvidence: [],
    authorityGranted: false,
  }, memoryBudget)
  expect(outcome.status).toBe('developed')
}

function writePrincipalDeclaration(): Readonly<PrincipalDeclaredProvenance> {
  cfg = { ...cfg, telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111 } }
  const result = admitPrincipalDeclaration(cfg, {
    schemaVersion: 1,
    chatId: 111,
    chatType: 'private',
    principalUserId: 111,
    commandMessageId: 10,
    commandUpdateId: 20,
    confirmationMessageId: 30,
    callbackQueryId: 'durability-callback',
    declarationType: 'INSTRUCTION',
    content: 'Preserve this authenticated declaration.',
    authorityGranted: false,
  })
  expect(result.status).toBe('admitted')
  return loadPrincipalProvenanceCatalog(cfg)[0]!
}

function writePrincipalRevocation(): void {
  const declaration = writePrincipalDeclaration()
  const suffix = 'durability-revocation'
  appendPrincipalLifecycleEvent(cfg, createPrincipalLifecycleEvent({
    schemaVersion: 1,
    lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED',
    targetProvenanceId: declaration.provenanceId,
    targetDeclarationId: declaration.declarationReference.declarationId,
    targetContentDigestSha256: declaration.contentDigestSha256,
    targetDeclarationType: declaration.declarationType,
    principalReference: declaration.declarationReference.principalReference,
    authenticatedLifecycleReference: {
      schemaVersion: 1,
      source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE',
      lifecycleReferenceId: `principal-lifecycle:${digestCanonicalJson({ suffix, kind: 'lifecycle' })}`,
      principalReference: declaration.declarationReference.principalReference,
      authenticationRecordId: `principal-lifecycle-auth:${digestCanonicalJson({ suffix, kind: 'authentication' })}`,
      authorityGranted: false,
    },
    authorityGranted: false,
  }))
}

describe('versioned Frog-to-Toad durability manifest', () => {
  it('has an exact schema and every required logical entry', () => {
    expect(DURABILITY_MANIFEST.schemaVersion).toBe(DURABILITY_SCHEMA_VERSION)
    expect(Object.keys(DURABILITY_MANIFEST).sort()).toEqual(['entries', 'schemaVersion'])
    const ids = new Set(DURABILITY_MANIFEST.entries.map((entry) => entry.id))
    for (const id of [
      'spot-ledger', 'receipt-finality', 'journal', 'signal-lifecycle', 'signal-grades-ta', 'forecast-records',
      'paper-perps-ledger', 'sniper-candidates', 'sniper-grades', 'sniper-executions', 'sniper-shadow-probes', 'desk-state', 'workspace-user', 'workspace-desk', 'agent-memory',
      'transcripts', 'lessons', 'scheduled-tasks', 'developmental-memory-revisions',
      'principal-provenance', 'principal-lifecycle',
      'lp-arbitrage-paper-farm-receipts',
    ]) expect(ids.has(id)).toBe(true)
    expect(ids.size).toBe(DURABILITY_MANIFEST.entries.length)
  })

  it('rejects traversal, absolute, backup, and secret-like paths', () => {
    for (const unsafe of [
      '../ledger.jsonl', '/tmp/ledger.jsonl', 'memory/../ledger.jsonl', 'backups/snapshot/x',
      'state/codex-auth.json', 'wallet.json', 'api-key.txt', 'signer.pem', '.env',
    ]) {
      expect(() => assertSafeDurabilityPath(unsafe)).toThrow()
    }
    for (const entry of DURABILITY_MANIFEST.entries) expect(() => assertSafeDurabilityPath(entry.relativePath)).not.toThrow()
  })

  it('admits no secret-like or recursively backed-up manifest path', () => {
    const paths = DURABILITY_MANIFEST.entries.map((entry) => entry.relativePath)
    expect(paths.some((value) => value === 'backups' || value.startsWith('backups/'))).toBe(false)
    expect(paths.some((value) => /(?:auth|token|secret|credential|private[-_]?key|mnemonic|seed|\.env)/i.test(value))).toBe(false)
  })
})

describe('coherent durability snapshots', () => {
  it('captures nested canonical, memory, and continuity paths byte-identically', () => {
    write('ledger.jsonl', '{"ts":1}\n')
    write('execution/receipt-finality.jsonl', '{"txHash":"0x1","status":"CONFIRMED"}\n')
    write('perps/paper-ledger.jsonl', Buffer.from([0, 1, 2, 3]))
    write('sniper/candidates.jsonl', '{"candidateId":"candidate-1"}\n')
    write('sniper/grades.jsonl', '{"candidateId":"candidate-1","horizonHours":24}\n')
    write('sniper/executions.jsonl', '{"intentId":"intent-1","state":"PROPOSED"}\n')
    write('sniper/shadow-probes.jsonl', '{"key":"shadow-1","signed":false}\n')
    write('memory/orchestrator.md', 'one\n')
    write('memory/risk-guardian.md', 'two\n')
    write('transcript/42.jsonl', '{"message":"hi"}\n')
    write('transcript/-100.jsonl', '{"message":"group"}\n')
    const { dir, manifest } = captured()

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.capturedFileCount).toBe(manifest.files.length)
    expect(manifest.files.filter((file) => file.logicalId === 'agent-memory')).toHaveLength(2)
    expect(manifest.files.filter((file) => file.logicalId === 'transcripts')).toHaveLength(2)
    expect(manifest.files.filter((file) => file.logicalId === 'sniper-candidates')).toHaveLength(1)
    expect(manifest.files.filter((file) => file.logicalId === 'sniper-grades')).toHaveLength(1)
    expect(manifest.files.filter((file) => file.logicalId === 'sniper-executions')).toHaveLength(1)
    expect(manifest.files.filter((file) => file.logicalId === 'sniper-shadow-probes')).toHaveLength(1)
    expect(manifest.files.filter((file) => file.logicalId === 'receipt-finality')).toHaveLength(1)
    for (const file of manifest.files) {
      expect(fs.readFileSync(path.join(dir, 'files', ...file.relativePath.split('/'))))
        .toEqual(fs.readFileSync(path.join(cfg.paths.dataDir, ...file.relativePath.split('/'))))
    }
  })

  it('records correct SHA-256 and byte lengths', () => {
    const bytes = Buffer.from('funding-aware evidence\n')
    write('perps/paper-ledger.jsonl', bytes)
    const { manifest } = captured()
    const file = manifest.files.find((candidate) => candidate.relativePath === 'perps/paper-ledger.jsonl')!
    expect(file.byteLength).toBe(bytes.byteLength)
    expect(file.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'))
  })

  it('serializes deterministically independent of caller array ordering', () => {
    write('journal.jsonl', 'j\n')
    const { manifest } = captured()
    const shuffled = { ...manifest, files: [...manifest.files].reverse(), missingOptional: [...manifest.missingOptional].reverse() }
    expect(serializeSnapshotManifest(shuffled)).toBe(serializeSnapshotManifest(manifest))
  })

  it('reports missing optional sources honestly', () => {
    const result = createDurabilitySnapshot(cfg, { now: 2_000 })
    expect(result.status).toBe('captured')
    expect(result.missingOptional).toContainEqual({ logicalId: 'spot-ledger', relativePath: 'ledger.jsonl' })
    expect(result.missingOptional).toContainEqual({ logicalId: 'developmental-memory-revisions', relativePath: 'memory/developmental-revisions.jsonl' })
    expect(result.missingOptional).toContainEqual({ logicalId: 'principal-provenance', relativePath: 'memory/principal-provenance.jsonl' })
    expect(result.missingOptional).toContainEqual({ logicalId: 'principal-lifecycle', relativePath: 'memory/principal-lifecycle.jsonl' })
  })

  it('classifies and captures the optional developmental revision store exactly', () => {
    const entry = DURABILITY_MANIFEST.entries.find((candidate) => candidate.id === 'developmental-memory-revisions')
    expect(entry).toEqual({
      id: 'developmental-memory-revisions',
      relativePath: 'memory/developmental-revisions.jsonl',
      classification: 'CONTINUITY',
      required: false,
      kind: 'FILE',
      recoveryRelevance: 'IMPORTANT',
    })
    writeDevelopmentalRevision()
    const sourceBytes = fs.readFileSync(developmentalMemoryStorePath(cfg))
    const { dir, manifest } = captured(2_500)
    expect(manifest.files).toContainEqual(expect.objectContaining({
      logicalId: 'developmental-memory-revisions',
      relativePath: 'memory/developmental-revisions.jsonl',
    }))
    expect(fs.readFileSync(path.join(dir, 'files', 'memory', 'developmental-revisions.jsonl'))).toEqual(sourceBytes)
  })

  it('classifies and captures principal provenance as an optional essential continuity artifact', () => {
    const entry = DURABILITY_MANIFEST.entries.find((candidate) => candidate.id === 'principal-provenance')
    expect(entry).toEqual({
      id: 'principal-provenance',
      relativePath: 'memory/principal-provenance.jsonl',
      classification: 'CONTINUITY',
      required: false,
      kind: 'FILE',
      recoveryRelevance: 'ESSENTIAL',
    })
    writePrincipalDeclaration()
    const sourceBytes = fs.readFileSync(principalProvenanceStorePath(cfg))
    const { dir, manifest } = captured(2_750)
    expect(manifest.files).toContainEqual(expect.objectContaining({
      logicalId: 'principal-provenance',
      relativePath: 'memory/principal-provenance.jsonl',
    }))
    expect(fs.readFileSync(path.join(dir, 'files', 'memory', 'principal-provenance.jsonl'))).toEqual(sourceBytes)
  })

  it('classifies and captures principal lifecycle as an optional essential continuity artifact', () => {
    const entry = DURABILITY_MANIFEST.entries.find((candidate) => candidate.id === 'principal-lifecycle')
    expect(entry).toEqual({
      id: 'principal-lifecycle',
      relativePath: 'memory/principal-lifecycle.jsonl',
      classification: 'CONTINUITY',
      required: false,
      kind: 'FILE',
      recoveryRelevance: 'ESSENTIAL',
    })
    writePrincipalRevocation()
    const sourceBytes = fs.readFileSync(principalLifecycleStorePath(cfg))
    const { dir, manifest } = captured(2_800)
    expect(manifest.files).toContainEqual(expect.objectContaining({
      logicalId: 'principal-lifecycle',
      relativePath: 'memory/principal-lifecycle.jsonl',
    }))
    expect(fs.readFileSync(path.join(dir, 'files', 'memory', 'principal-lifecycle.jsonl'))).toEqual(sourceBytes)
  })

  it('treats absent USER/DESK as honest optional empty state, then captures later writes', () => {
    fs.rmSync(cfg.paths.dataDir, { recursive: true, force: true })
    const fresh = createDurabilitySnapshot(cfg, { now: 3_000 })
    expect(fresh.status).toBe('captured')
    expect(fresh.captured).toBe(0)
    expect(fresh.missingOptional).toContainEqual({ logicalId: 'workspace-user', relativePath: 'workspace/USER.md' })
    expect(fresh.missingOptional).toContainEqual({ logicalId: 'workspace-desk', relativePath: 'workspace/DESK.md' })
    expect(rehearseSnapshotRecovery(cfg, fresh.snapshotDir!, recoveryDir()).reconstructed).toBe(0)

    write('workspace/USER.md', 'principal later\n')
    write('workspace/DESK.md', 'desk later\n')
    const populated = createDurabilitySnapshot(cfg, { now: 3_001 })
    expect(populated.status).toBe('captured')
    const manifest = loadSnapshotManifest(populated.snapshotDir!)
    expect(manifest.files.map((file) => file.relativePath)).toEqual(['workspace/DESK.md', 'workspace/USER.md'])
    fs.unlinkSync(path.join(populated.snapshotDir!, 'files', 'workspace', 'USER.md'))
    expect(() => rehearseSnapshotRecovery(cfg, populated.snapshotDir!, recoveryDir())).toThrow(/missing or unknown payload/)
  })

  it('does not recursively capture backups, credentials, arbitrary sandbox files, or logs', () => {
    write('backups/do-not-copy.txt', 'old backup')
    write('state/codex-auth.json', 'credential')
    write('sandbox/inbox/chart.png', 'image')
    write('sandbox/scratch/research.md', 'working material')
    write('debug.log', 'noise')
    write('sandbox/.ops.jsonl', '{"op":"write"}\n')
    const { manifest } = captured()
    const paths = manifest.files.map((file) => file.relativePath)
    expect(paths).toContain('sandbox/.ops.jsonl')
    expect(paths).not.toContain('backups/do-not-copy.txt')
    expect(paths).not.toContain('state/codex-auth.json')
    expect(paths).not.toContain('sandbox/inbox/chart.png')
    expect(paths).not.toContain('sandbox/scratch/research.md')
    expect(paths).not.toContain('debug.log')
  })

  it('returns unchanged and consumes no generation when content is identical', () => {
    const first = createDurabilitySnapshot(cfg, { now: 4_000 })
    const second = createDurabilitySnapshot(cfg, { now: 5_000 })
    expect(first.status).toBe('captured')
    expect(second.status).toBe('unchanged')
    expect(second.snapshotDir).toBe(first.snapshotDir)
    const dirs = fs.readdirSync(path.join(cfg.paths.dataDir, 'backups', 'snapshots')).filter((name) => name.startsWith('snapshot-'))
    expect(dirs).toHaveLength(1)
  })

  it('rotates complete snapshots to the bounded generation count', () => {
    for (let n = 1; n <= 4; n++) {
      write('journal.jsonl', `${n}\n`)
      expect(createDurabilitySnapshot(cfg, { now: 10_000 + n, maxGenerations: 3 }).status).toBe('captured')
    }
    const dirs = fs.readdirSync(path.join(cfg.paths.dataDir, 'backups', 'snapshots')).filter((name) => name.startsWith('snapshot-'))
    expect(dirs).toHaveLength(3)
  })

  it('refuses a memory collection root symlink outside dataDir without capturing external bytes', () => {
    const external = externalFile('memory-outside', 'orchestrator.md', 'MEMORY_EXTERNAL_BYTES')
    fs.symlinkSync(path.dirname(external), path.join(cfg.paths.dataDir, 'memory'), 'dir')
    expectSymlinkRefusal(20_001, 'memory')
  })

  it('refuses a transcript collection root symlink outside dataDir without capturing external bytes', () => {
    const external = externalFile('transcript-outside', '42.jsonl', 'TRANSCRIPT_EXTERNAL_BYTES')
    fs.symlinkSync(path.dirname(external), path.join(cfg.paths.dataDir, 'transcript'), 'dir')
    expectSymlinkRefusal(20_002, 'transcript')
  })

  it('refuses a symlinked parent of a fixed manifest file', () => {
    const external = externalFile('perps-outside', 'paper-ledger.jsonl', 'PERPS_EXTERNAL_BYTES')
    fs.symlinkSync(path.dirname(external), path.join(cfg.paths.dataDir, 'perps'), 'dir')
    expectSymlinkRefusal(20_003, 'perps')
  })

  it('continues to refuse a final-file symlink', () => {
    const external = externalFile('journal-outside', 'journal.jsonl', 'JOURNAL_EXTERNAL_BYTES')
    fs.symlinkSync(external, path.join(cfg.paths.dataDir, 'journal.jsonl'), 'file')
    expectSymlinkRefusal(20_004, 'journal.jsonl')
  })
})

describe('recovery rehearsal', () => {
  it('reconstructs a healthy snapshot byte-identically into an explicit empty destination', () => {
    write('journal.jsonl', 'history\n')
    write('memory/orchestrator.md', 'memory\n')
    write('perps/paper-ledger.jsonl', 'perp\n')
    const { dir, manifest } = captured()
    const destination = recoveryDir()
    const result = rehearseSnapshotRecovery(cfg, dir, destination)
    expect(result.reconstructed).toBe(manifest.files.length)
    for (const file of manifest.files) {
      expect(fs.readFileSync(path.join(destination, ...file.relativePath.split('/'))))
        .toEqual(fs.readFileSync(path.join(dir, 'files', ...file.relativePath.split('/'))))
    }
  })

  it('restores developmental history byte-identically and replays the same memory digest', () => {
    writeDevelopmentalRevision()
    const before = loadDevelopmentalMemoryStore(cfg)
    const sourceBytes = fs.readFileSync(developmentalMemoryStorePath(cfg))
    const { dir } = captured(1_500)
    const destination = recoveryDir()
    rehearseSnapshotRecovery(cfg, dir, destination)
    const recoveredCfg: Config = { ...cfg, paths: { ...cfg.paths, dataDir: destination } }
    expect(fs.readFileSync(developmentalMemoryStorePath(recoveredCfg))).toEqual(sourceBytes)
    expect(digestDevelopmentalMemory(loadDevelopmentalMemoryStore(recoveredCfg)))
      .toBe(digestDevelopmentalMemory(before))

    const revision = JSON.parse(sourceBytes.toString('utf8'))
    fs.writeFileSync(developmentalMemoryStorePath(recoveredCfg), JSON.stringify({ ...revision, summary: 'tampered after recovery' }) + '\n')
    expect(() => loadDevelopmentalMemoryStore(recoveredCfg)).toThrow(/invalid developmental memory store/)
  })

  it('restores principal provenance byte-identically with the same validated identities', () => {
    writePrincipalDeclaration()
    const before = loadPrincipalProvenanceCatalog(cfg)
    const sourceBytes = fs.readFileSync(principalProvenanceStorePath(cfg))
    const { dir } = captured(1_750)
    const destination = recoveryDir()
    rehearseSnapshotRecovery(cfg, dir, destination)
    const recoveredCfg: Config = { ...cfg, paths: { ...cfg.paths, dataDir: destination } }
    expect(fs.readFileSync(principalProvenanceStorePath(recoveredCfg))).toEqual(sourceBytes)
    expect(loadPrincipalProvenanceCatalog(recoveredCfg).map((record) => record.provenanceId))
      .toEqual(before.map((record) => record.provenanceId))
  })

  it('restores lifecycle bytes and replays the same validated lifecycle identities', () => {
    writePrincipalRevocation()
    const before = loadCoherentPrincipalLifecycleState(cfg)
    const sourceBytes = fs.readFileSync(principalLifecycleStorePath(cfg))
    const { dir } = captured(1_800)
    const destination = recoveryDir()
    rehearseSnapshotRecovery(cfg, dir, destination)
    const recoveredCfg: Config = { ...cfg, paths: { ...cfg.paths, dataDir: destination } }
    expect(fs.readFileSync(principalLifecycleStorePath(recoveredCfg))).toEqual(sourceBytes)
    const recovered = loadCoherentPrincipalLifecycleState(recoveredCfg)
    expect(recovered.lifecycleEvents.map((event) => event.lifecycleEventId))
      .toEqual(before.lifecycleEvents.map((event) => event.lifecycleEventId))
    expect(recovered.lifecycleStateDigestSha256).toBe(before.lifecycleStateDigestSha256)
  })

  it('refuses a same-length corrupt payload by digest', () => {
    write('ledger.jsonl', 'good')
    const { dir } = captured()
    writeSnapshotPayload(dir, 'ledger.jsonl', 'evil')
    expect(() => rehearseSnapshotRecovery(cfg, dir, recoveryDir())).toThrow(/digest mismatch/)
  })

  it('refuses a payload whose byte length changed', () => {
    write('ledger.jsonl', 'good')
    const { dir } = captured()
    writeSnapshotPayload(dir, 'ledger.jsonl', 'truncated-or-expanded')
    expect(() => rehearseSnapshotRecovery(cfg, dir, recoveryDir())).toThrow(/byte length mismatch/)
  })

  it('refuses a missing recorded payload', () => {
    write('ledger.jsonl', 'good')
    const { dir } = captured()
    fs.unlinkSync(path.join(dir, 'files', 'ledger.jsonl'))
    expect(() => rehearseSnapshotRecovery(cfg, dir, recoveryDir())).toThrow(/missing or unknown payload/)
  })

  it('refuses unknown payloads and never recursively trusts snapshot contents', () => {
    const { dir } = captured()
    writeSnapshotPayload(dir, 'unknown.txt', 'unknown')
    expect(() => rehearseSnapshotRecovery(cfg, dir, recoveryDir())).toThrow(/missing or unknown payload/)
  })

  it('refuses malformed and unknown-key snapshot manifests', () => {
    const { dir, manifest } = captured()
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, surprise: true }))
    expect(() => rehearseSnapshotRecovery(cfg, dir, recoveryDir())).toThrow(/unknown or missing keys/)
  })

  it('refuses traversal and paths outside the code-defined manifest', () => {
    const { manifest } = captured()
    const file = manifest.files[0]!
    expect(() => parseSnapshotManifest({ ...manifest, files: [{ ...file, relativePath: '../escape' }, ...manifest.files.slice(1)] }))
      .toThrow(/unsafe relative path/)
    expect(() => parseSnapshotManifest({ ...manifest, files: [{ ...file, relativePath: 'not-in-manifest.txt' }, ...manifest.files.slice(1)] }))
      .toThrow(/outside the durability manifest/)
  })

  it('requires an existing empty destination outside active data', () => {
    const { dir } = captured()
    expect(() => rehearseSnapshotRecovery(cfg, dir, '')).toThrow(/explicit/)
    expect(() => rehearseSnapshotRecovery(cfg, dir, cfg.paths.dataDir)).toThrow(/outside the active data/)
    const nonempty = recoveryDir()
    fs.writeFileSync(path.join(nonempty, 'keep'), 'do not overwrite')
    expect(() => rehearseSnapshotRecovery(cfg, dir, nonempty)).toThrow(/must be empty/)
  })
})

function writeSnapshotPayload(snapshotDir: string, relativePath: string, content: string): void {
  const target = path.join(snapshotDir, 'files', ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function externalFile(directory: string, fileName: string, content: string): string {
  const externalDir = path.join(root, directory)
  fs.mkdirSync(externalDir)
  const file = path.join(externalDir, fileName)
  fs.writeFileSync(file, content)
  return file
}

function expectSymlinkRefusal(now: number, pathFragment: string): void {
  const result = createDurabilitySnapshot(cfg, { now })
  expect(result.status).toBe('failed')
  expect(result.snapshotDir).toBeUndefined()
  expect(result.failed.some((failure) => failure.error.includes('symlink') && failure.error.includes(pathFragment))).toBe(true)
  expect(fs.existsSync(path.join(cfg.paths.dataDir, 'backups', 'snapshots'))).toBe(false)
}

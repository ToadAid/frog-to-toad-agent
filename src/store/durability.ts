import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'

export const DURABILITY_SCHEMA_VERSION = 1 as const
export const SNAPSHOT_GENERATIONS = 3

export const DURABILITY_CLASSIFICATIONS = [
  'CANONICAL_EVIDENCE',
  'AUTHORITY_OR_RUNTIME_STATE',
  'CONTINUITY',
  'WORKING_MEMORY',
  'DERIVED_REBUILDABLE',
  'EPHEMERAL_OR_CACHE',
  'SECRET_OR_EXTERNAL',
] as const

export type DurabilityClassification = (typeof DURABILITY_CLASSIFICATIONS)[number]
export type CapturedDurabilityClassification = Exclude<DurabilityClassification, 'EPHEMERAL_OR_CACHE' | 'SECRET_OR_EXTERNAL'>
export type DurabilityRecoveryRelevance = 'ESSENTIAL' | 'IMPORTANT' | 'SUPPORTING'
export type DurabilityCollectionMatch = 'AGENT_MEMORY_MARKDOWN' | 'CHAT_TRANSCRIPT_JSONL' | 'SESSION_MEMORY_MARKDOWN'

export type DurabilityEntry = {
  id: string
  relativePath: string
  classification: CapturedDurabilityClassification
  required: boolean
  kind: 'FILE' | 'BOUNDED_COLLECTION'
  collectionMatch?: DurabilityCollectionMatch
  recoveryRelevance: DurabilityRecoveryRelevance
}

/**
 * Explicit data-dir inventory. Nothing is discovered recursively: every file
 * is either named here or belongs to one bounded, one-directory collection.
 * Secrets, arbitrary sandbox material, caches, logs, mirrors, and backups are
 * deliberately absent.
 */
export const DURABILITY_MANIFEST: Readonly<{
  schemaVersion: typeof DURABILITY_SCHEMA_VERSION
  entries: readonly DurabilityEntry[]
}> = Object.freeze({
  schemaVersion: DURABILITY_SCHEMA_VERSION,
  entries: Object.freeze([
    entry('spot-ledger', 'ledger.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('receipt-finality', 'execution/receipt-finality.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('journal', 'journal.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('signal-lifecycle', 'signals/lifecycle.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('signal-grades-ta', 'grades/ta.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('forecast-records', 'forecasts.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('paper-perps-ledger', 'perps/paper-ledger.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('perps-signal-journal', 'perps/signal-journal.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('perps-signal-grades', 'grades/perps-signals.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('swing-trend-v1-evidence', 'swing/swing-trend-v1-evidence.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('sniper-candidates', 'sniper/candidates.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('sniper-grades', 'sniper/grades.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('sniper-executions', 'sniper/executions.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('sniper-shadow-probes', 'sniper/shadow-probes.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('lp-arbitrage-observations', 'lp-arbitrage/observations.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('lp-arbitrage-grades', 'lp-arbitrage/grades.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'ESSENTIAL'),
    entry('lp-arbitrage-paper-farm-receipts', 'lp-arbitrage/paper-farm-receipts.jsonl', 'CONTINUITY', false, 'FILE', 'IMPORTANT'),
    entry('developmental-memory-revisions', 'memory/developmental-revisions.jsonl', 'CONTINUITY', false, 'FILE', 'IMPORTANT'),
    entry('principal-provenance', 'memory/principal-provenance.jsonl', 'CONTINUITY', false, 'FILE', 'ESSENTIAL'),
    entry('principal-lifecycle', 'memory/principal-lifecycle.jsonl', 'CONTINUITY', false, 'FILE', 'ESSENTIAL'),
    entry('perps-signal-runner-receipts', 'perps/signal-runner-receipts.jsonl', 'CONTINUITY', false, 'FILE', 'IMPORTANT'),
    entry('sandbox-operations-audit', 'sandbox/.ops.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'SUPPORTING'),
    entry('sandbox-commands-audit', 'sandbox/.exec.jsonl', 'CANONICAL_EVIDENCE', false, 'FILE', 'SUPPORTING'),
    entry('desk-state', 'desk_state.json', 'AUTHORITY_OR_RUNTIME_STATE', false, 'FILE', 'ESSENTIAL'),
    entry('guardian-state', 'guardian_state.json', 'AUTHORITY_OR_RUNTIME_STATE', false, 'FILE', 'IMPORTANT'),
    entry('scheduled-tasks', 'scheduled_tasks.json', 'AUTHORITY_OR_RUNTIME_STATE', false, 'FILE', 'IMPORTANT'),
    entry('doctor-state', 'state/doctor.json', 'AUTHORITY_OR_RUNTIME_STATE', false, 'FILE', 'SUPPORTING'),
    entry('sentinel-state', 'state/sentinel.json', 'AUTHORITY_OR_RUNTIME_STATE', false, 'FILE', 'IMPORTANT'),
    entry('watchdog-state', 'state/watchdog.json', 'AUTHORITY_OR_RUNTIME_STATE', false, 'FILE', 'IMPORTANT'),
    entry('workspace-user', 'workspace/USER.md', 'WORKING_MEMORY', false, 'FILE', 'ESSENTIAL'),
    entry('workspace-desk', 'workspace/DESK.md', 'WORKING_MEMORY', false, 'FILE', 'ESSENTIAL'),
    entry('agent-memory', 'memory', 'WORKING_MEMORY', false, 'BOUNDED_COLLECTION', 'IMPORTANT', 'AGENT_MEMORY_MARKDOWN'),
    entry('session-memory', 'memory/session', 'WORKING_MEMORY', false, 'BOUNDED_COLLECTION', 'IMPORTANT', 'SESSION_MEMORY_MARKDOWN'),
    entry('transcripts', 'transcript', 'CONTINUITY', false, 'BOUNDED_COLLECTION', 'IMPORTANT', 'CHAT_TRANSCRIPT_JSONL'),
    entry('lessons', 'lessons/lessons.md', 'DERIVED_REBUILDABLE', false, 'FILE', 'IMPORTANT'),
  ]),
})

export const DURABILITY_EXCLUSIONS: ReadonlyArray<Readonly<{
  relativePath: string
  classification: DurabilityClassification
  reason: string
}>> = Object.freeze([
  { relativePath: 'backups', classification: 'EPHEMERAL_OR_CACHE', reason: 'snapshot recursion' },
  { relativePath: 'debug.log', classification: 'EPHEMERAL_OR_CACHE', reason: 'diagnostic log' },
  { relativePath: 'sandbox', classification: 'EPHEMERAL_OR_CACHE', reason: 'arbitrary workspace except explicit audit files' },
  { relativePath: 'sandbox/inbox', classification: 'EPHEMERAL_OR_CACHE', reason: 'uploaded working files' },
  { relativePath: 'sandbox-baseline', classification: 'DERIVED_REBUILDABLE', reason: 'rebuildable coding baseline' },
  { relativePath: 'state/codex-auth.json', classification: 'SECRET_OR_EXTERNAL', reason: 'credential keyfile' },
])

type SnapshotFile = {
  logicalId: string
  relativePath: string
  byteLength: number
  sha256: string
}

type MissingOptional = { logicalId: string; relativePath: string }

export type DurabilitySnapshotManifest = {
  schemaVersion: typeof DURABILITY_SCHEMA_VERSION
  snapshotId: string
  createdAt: number
  capturedFileCount: number
  contentDigestSha256: string
  missingOptional: MissingOptional[]
  files: SnapshotFile[]
}

export type DurabilitySnapshotResult = {
  status: 'captured' | 'unchanged' | 'failed'
  snapshotDir?: string
  captured: number
  missingOptional: MissingOptional[]
  failed: Array<{ logicalId?: string; relativePath?: string; error: string }>
}

function entry(
  id: string,
  relativePath: string,
  classification: CapturedDurabilityClassification,
  required: boolean,
  kind: DurabilityEntry['kind'],
  recoveryRelevance: DurabilityRecoveryRelevance,
  collectionMatch?: DurabilityCollectionMatch,
): DurabilityEntry {
  return Object.freeze({ id, relativePath, classification, required, kind, recoveryRelevance, ...(collectionMatch ? { collectionMatch } : {}) })
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing keys`)
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function secretLike(relativePath: string): boolean {
  return relativePath.split('/').some((segment) =>
    segment === '.env' || /\.(?:key|pem)$/i.test(segment) ||
      /(?:^|[-_.])(auth|token|secret|credential|private[-_]?key|api[-_]?key|keyfile|password|wallet|mnemonic|seed)(?:[-_.]|$)/i.test(segment),
  )
}

export function assertSafeDurabilityPath(relativePath: string): void {
  if (relativePath === '' || relativePath.includes('\\') || relativePath.includes('\0')) throw new Error('unsafe relative path')
  if (path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath) throw new Error('unsafe relative path')
  const parts = relativePath.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('unsafe relative path')
  if (parts[0] === 'backups') throw new Error('backups directory is excluded')
  if (secretLike(relativePath)) throw new Error('secret-like path is excluded')
}

function collectionAccepts(entry: DurabilityEntry, fileName: string): boolean {
  if (entry.collectionMatch === 'AGENT_MEMORY_MARKDOWN') return /^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(fileName)
  if (entry.collectionMatch === 'CHAT_TRANSCRIPT_JSONL') return /^-?[0-9]+\.jsonl$/.test(fileName)
  if (entry.collectionMatch === 'SESSION_MEMORY_MARKDOWN') return /^-?[0-9]+\.md$/.test(fileName)
  return false
}

function entryAccepts(entry: DurabilityEntry, relativePath: string): boolean {
  if (entry.kind === 'FILE') return entry.relativePath === relativePath
  const prefix = `${entry.relativePath}/`
  if (!relativePath.startsWith(prefix)) return false
  const fileName = relativePath.slice(prefix.length)
  return !fileName.includes('/') && collectionAccepts(entry, fileName)
}

function manifestEntry(logicalId: string, relativePath: string): DurabilityEntry | undefined {
  return DURABILITY_MANIFEST.entries.find((entry) => entry.id === logicalId && entryAccepts(entry, relativePath))
}

function isStrictlyInside(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Refuse every symlink below dataDir, then prove the resolved target remains
 * inside the resolved dataDir boundary. Checking both properties avoids the
 * classic regular-file-through-a-symlinked-parent escape.
 */
function verifySourcePath(
  dataDir: string,
  dataDirReal: string,
  relativePath: string,
  expected: 'FILE' | 'DIRECTORY',
): boolean {
  assertSafeDurabilityPath(relativePath)
  const parts = relativePath.split('/')
  let current = dataDir
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`source path contains symlink: ${parts.slice(0, index + 1).join('/')}`)
    const final = index === parts.length - 1
    if (!final && !stat.isDirectory()) throw new Error(`source parent is not a directory: ${parts.slice(0, index + 1).join('/')}`)
    if (final && expected === 'FILE' && !stat.isFile()) throw new Error(`source is not a regular file: ${relativePath}`)
    if (final && expected === 'DIRECTORY' && !stat.isDirectory()) throw new Error(`collection root is not a directory: ${relativePath}`)
  }
  const sourceReal = fs.realpathSync(current)
  if (!isStrictlyInside(dataDirReal, sourceReal)) throw new Error(`source resolves outside data directory: ${relativePath}`)
  return true
}

function ensureSnapshotRoot(dataDir: string, dataDirReal: string): string {
  let current = dataDir
  for (const segment of ['backups', 'snapshots']) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) fs.mkdirSync(current)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`snapshot path is not an owned directory: ${segment}`)
    if (!isStrictlyInside(dataDirReal, fs.realpathSync(current))) throw new Error('snapshot path resolves outside data directory')
  }
  return current
}

function enumerateSources(dataDir: string, dataDirReal: string): { sources: Array<{ entry: DurabilityEntry; relativePath: string }>; missingOptional: MissingOptional[]; failures: DurabilitySnapshotResult['failed'] } {
  const sources: Array<{ entry: DurabilityEntry; relativePath: string }> = []
  const missingOptional: MissingOptional[] = []
  const failures: DurabilitySnapshotResult['failed'] = []
  for (const item of DURABILITY_MANIFEST.entries) {
    assertSafeDurabilityPath(item.relativePath)
    const source = path.join(dataDir, ...item.relativePath.split('/'))
    if (item.kind === 'FILE') {
      let present = false
      try {
        present = verifySourcePath(dataDir, dataDirReal, item.relativePath, 'FILE')
      } catch (error) {
        failures.push({ logicalId: item.id, relativePath: item.relativePath, error: errorMessage(error) })
        continue
      }
      if (!present) {
        const missing = { logicalId: item.id, relativePath: item.relativePath }
        if (item.required) failures.push({ ...missing, error: 'required source is missing' })
        else missingOptional.push(missing)
        continue
      }
      sources.push({ entry: item, relativePath: item.relativePath })
      continue
    }
    let present = false
    try {
      present = verifySourcePath(dataDir, dataDirReal, item.relativePath, 'DIRECTORY')
    } catch (error) {
      failures.push({ logicalId: item.id, relativePath: item.relativePath, error: errorMessage(error) })
      continue
    }
    if (!present) {
      if (item.required) failures.push({ logicalId: item.id, relativePath: item.relativePath, error: 'required collection is missing' })
      else missingOptional.push({ logicalId: item.id, relativePath: item.relativePath })
      continue
    }
    try {
      const names = fs.readdirSync(source, { withFileTypes: true })
      for (const dirent of names) {
        if (!collectionAccepts(item, dirent.name)) continue
        const relativePath = `${item.relativePath}/${dirent.name}`
        try {
          if (!verifySourcePath(dataDir, dataDirReal, relativePath, 'FILE')) {
            failures.push({ logicalId: item.id, relativePath, error: 'bounded collection member disappeared during enumeration' })
            continue
          }
        } catch (error) {
          failures.push({ logicalId: item.id, relativePath, error: errorMessage(error) })
          continue
        }
        sources.push({ entry: item, relativePath })
      }
    } catch (error) {
      failures.push({ logicalId: item.id, relativePath: item.relativePath, error: errorMessage(error) })
    }
  }
  sources.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.entry.id.localeCompare(b.entry.id))
  missingOptional.sort(compareMissing)
  return { sources, missingOptional, failures }
}

function compareMissing(a: MissingOptional, b: MissingOptional): number {
  return a.relativePath.localeCompare(b.relativePath) || a.logicalId.localeCompare(b.logicalId)
}

function compareSnapshotFile(a: SnapshotFile, b: SnapshotFile): number {
  return a.relativePath.localeCompare(b.relativePath) || a.logicalId.localeCompare(b.logicalId)
}

function contentDigest(files: SnapshotFile[]): string {
  return sha256(JSON.stringify({ schemaVersion: DURABILITY_SCHEMA_VERSION, files: [...files].sort(compareSnapshotFile) }))
}

export function serializeSnapshotManifest(manifest: DurabilitySnapshotManifest): string {
  const normalized: DurabilitySnapshotManifest = {
    schemaVersion: manifest.schemaVersion,
    snapshotId: manifest.snapshotId,
    createdAt: manifest.createdAt,
    capturedFileCount: manifest.capturedFileCount,
    contentDigestSha256: manifest.contentDigestSha256,
    missingOptional: [...manifest.missingOptional].sort(compareMissing),
    files: [...manifest.files].sort(compareSnapshotFile),
  }
  return `${JSON.stringify(normalized, null, 2)}\n`
}

function snapshotsRoot(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'backups', 'snapshots')
}

function snapshotDirectories(root: string): Array<{ dir: string; manifest: DurabilitySnapshotManifest }> {
  if (!fs.existsSync(root)) return []
  const found: Array<{ dir: string; manifest: DurabilitySnapshotManifest }> = []
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !/^snapshot-[0-9]+-[a-f0-9]{12}$/.test(dirent.name)) continue
    const dir = path.join(root, dirent.name)
    try {
      found.push({ dir, manifest: loadSnapshotManifest(dir) })
    } catch {
      // A bad old snapshot must not be mistaken for an unchanged good one.
    }
  }
  return found.sort((a, b) => b.manifest.createdAt - a.manifest.createdAt || b.manifest.snapshotId.localeCompare(a.manifest.snapshotId))
}

function removeControlledSnapshotDir(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^(?:\.staging-[A-Za-z0-9-]+|snapshot-[0-9]+-[a-f0-9]{12})$/.test(relative)) {
    throw new Error('refusing to remove uncontrolled snapshot path')
  }
  fs.rmSync(target, { recursive: true, force: true })
}

export function createDurabilitySnapshot(
  cfg: Config,
  options: { now?: number; maxGenerations?: number } = {},
): DurabilitySnapshotResult {
  const now = options.now ?? Date.now()
  const maxGenerations = options.maxGenerations ?? SNAPSHOT_GENERATIONS
  let root = snapshotsRoot(cfg)
  let staging: string | undefined
  try {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('snapshot timestamp must be a non-negative safe integer')
    if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1) throw new Error('snapshot generations must be a positive safe integer')
    fs.mkdirSync(cfg.paths.dataDir, { recursive: true })
    const dataDirReal = fs.realpathSync(cfg.paths.dataDir)
    if (!fs.statSync(dataDirReal).isDirectory()) throw new Error('data directory is not a directory')
    const inventory = enumerateSources(cfg.paths.dataDir, dataDirReal)
    if (inventory.failures.length > 0) {
      return { status: 'failed', captured: 0, missingOptional: inventory.missingOptional, failed: inventory.failures }
    }

    root = ensureSnapshotRoot(cfg.paths.dataDir, dataDirReal)
    staging = path.join(root, `.staging-${process.pid}-${now}`)
    if (fs.existsSync(staging)) throw new Error('snapshot staging path already exists')
    fs.mkdirSync(path.join(staging, 'files'), { recursive: true })

    const files: SnapshotFile[] = []
    for (const source of inventory.sources) {
      const src = path.join(cfg.paths.dataDir, ...source.relativePath.split('/'))
      if (!verifySourcePath(cfg.paths.dataDir, dataDirReal, source.relativePath, 'FILE')) {
        throw new Error(`${source.relativePath} disappeared before capture`)
      }
      const bytes = fs.readFileSync(src)
      if (!verifySourcePath(cfg.paths.dataDir, dataDirReal, source.relativePath, 'FILE')) {
        throw new Error(`${source.relativePath} disappeared during capture`)
      }
      const payload = path.join(staging, 'files', ...source.relativePath.split('/'))
      fs.mkdirSync(path.dirname(payload), { recursive: true })
      fs.writeFileSync(payload, bytes)
      files.push({ logicalId: source.entry.id, relativePath: source.relativePath, byteLength: bytes.byteLength, sha256: sha256(bytes) })
    }
    files.sort(compareSnapshotFile)
    const digest = contentDigest(files)
    const previous = snapshotDirectories(root)[0]
    if (previous?.manifest.contentDigestSha256 === digest &&
        JSON.stringify(previous.manifest.missingOptional) === JSON.stringify(inventory.missingOptional)) {
      removeControlledSnapshotDir(root, staging)
      staging = undefined
      return { status: 'unchanged', snapshotDir: previous.dir, captured: files.length, missingOptional: inventory.missingOptional, failed: [] }
    }

    const snapshotId = `snapshot-${now}-${digest.slice(0, 12)}`
    const manifest: DurabilitySnapshotManifest = {
      schemaVersion: DURABILITY_SCHEMA_VERSION,
      snapshotId,
      createdAt: now,
      capturedFileCount: files.length,
      contentDigestSha256: digest,
      missingOptional: inventory.missingOptional,
      files,
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), serializeSnapshotManifest(manifest), 'utf8')
    const finalDir = path.join(root, snapshotId)
    if (fs.existsSync(finalDir)) throw new Error('snapshot identity already exists')
    fs.renameSync(staging, finalDir)
    staging = undefined

    const generations = snapshotDirectories(root)
    for (const old of generations.slice(maxGenerations)) removeControlledSnapshotDir(root, old.dir)
    return { status: 'captured', snapshotDir: finalDir, captured: files.length, missingOptional: inventory.missingOptional, failed: [] }
  } catch (error) {
    if (staging !== undefined && fs.existsSync(staging)) {
      try { removeControlledSnapshotDir(root, staging) } catch { /* best effort */ }
    }
    const failure = { error: errorMessage(error) }
    console.warn(`[backup] durability snapshot failed: ${failure.error}`)
    return { status: 'failed', captured: 0, missingOptional: [], failed: [failure] }
  }
}

function parseMissingOptional(value: unknown): MissingOptional[] {
  if (!Array.isArray(value)) throw new Error('snapshot missingOptional must be an array')
  const parsed = value.map((item, index) => {
    const record = asRecord(item, `snapshot missingOptional[${index}]`)
    exactKeys(record, ['logicalId', 'relativePath'], `snapshot missingOptional[${index}]`)
    if (typeof record.logicalId !== 'string' || typeof record.relativePath !== 'string') throw new Error('snapshot missingOptional entry is malformed')
    assertSafeDurabilityPath(record.relativePath)
    const manifestItem = DURABILITY_MANIFEST.entries.find((entry) => entry.id === record.logicalId && entry.relativePath === record.relativePath)
    if (!manifestItem || manifestItem.required) throw new Error('snapshot missingOptional entry is unknown or required')
    return { logicalId: record.logicalId, relativePath: record.relativePath }
  })
  if (parsed.some((item, index) => index > 0 && compareMissing(parsed[index - 1]!, item) >= 0)) throw new Error('snapshot missingOptional entries must be unique and sorted')
  return parsed
}

function parseSnapshotFiles(value: unknown): SnapshotFile[] {
  if (!Array.isArray(value)) throw new Error('snapshot files must be an array')
  const parsed = value.map((item, index) => {
    const record = asRecord(item, `snapshot files[${index}]`)
    exactKeys(record, ['logicalId', 'relativePath', 'byteLength', 'sha256'], `snapshot files[${index}]`)
    if (typeof record.logicalId !== 'string' || typeof record.relativePath !== 'string') throw new Error('snapshot file identity is malformed')
    if (!Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0) throw new Error('snapshot file byteLength is malformed')
    if (!isHexDigest(record.sha256)) throw new Error('snapshot file digest is malformed')
    assertSafeDurabilityPath(record.relativePath)
    if (!manifestEntry(record.logicalId, record.relativePath)) throw new Error('snapshot file is outside the durability manifest')
    return { logicalId: record.logicalId, relativePath: record.relativePath, byteLength: record.byteLength as number, sha256: record.sha256 }
  })
  if (parsed.some((item, index) => index > 0 && compareSnapshotFile(parsed[index - 1]!, item) >= 0)) throw new Error('snapshot files must be unique and sorted')
  return parsed
}

export function parseSnapshotManifest(value: unknown): DurabilitySnapshotManifest {
  const record = asRecord(value, 'snapshot manifest')
  exactKeys(record, ['schemaVersion', 'snapshotId', 'createdAt', 'capturedFileCount', 'contentDigestSha256', 'missingOptional', 'files'], 'snapshot manifest')
  if (record.schemaVersion !== DURABILITY_SCHEMA_VERSION) throw new Error('unsupported durability schema version')
  if (typeof record.snapshotId !== 'string' || !/^snapshot-[0-9]+-[a-f0-9]{12}$/.test(record.snapshotId)) throw new Error('snapshot identity is malformed')
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) throw new Error('snapshot creation timestamp is malformed')
  if (!Number.isSafeInteger(record.capturedFileCount) || (record.capturedFileCount as number) < 0) throw new Error('snapshot captured file count is malformed')
  if (!isHexDigest(record.contentDigestSha256)) throw new Error('snapshot content digest is malformed')
  const files = parseSnapshotFiles(record.files)
  const missingOptional = parseMissingOptional(record.missingOptional)
  const capturedPaths = new Set(files.map((file) => `${file.logicalId}\0${file.relativePath}`))
  for (const missing of missingOptional) {
    if (capturedPaths.has(`${missing.logicalId}\0${missing.relativePath}`)) throw new Error('snapshot source cannot be both captured and missing')
  }
  for (const item of DURABILITY_MANIFEST.entries) {
    if (item.required && item.kind === 'FILE' && !capturedPaths.has(`${item.id}\0${item.relativePath}`)) {
      throw new Error(`snapshot is missing required source: ${item.relativePath}`)
    }
  }
  if (record.capturedFileCount !== files.length) throw new Error('snapshot captured file count does not match files')
  if (record.contentDigestSha256 !== contentDigest(files)) throw new Error('snapshot content digest does not match file records')
  if (record.snapshotId !== `snapshot-${record.createdAt}-${record.contentDigestSha256.slice(0, 12)}`) throw new Error('snapshot identity does not match its content')
  return {
    schemaVersion: DURABILITY_SCHEMA_VERSION,
    snapshotId: record.snapshotId,
    createdAt: record.createdAt as number,
    capturedFileCount: record.capturedFileCount as number,
    contentDigestSha256: record.contentDigestSha256,
    missingOptional,
    files,
  }
}

export function loadSnapshotManifest(snapshotDir: string): DurabilitySnapshotManifest {
  return parseSnapshotManifest(JSON.parse(fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8')))
}

function listPayloads(root: string, current = ''): string[] {
  const dir = current === '' ? root : path.join(root, ...current.split('/'))
  const files: string[] = []
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = current === '' ? dirent.name : `${current}/${dirent.name}`
    assertSafeDurabilityPath(relativePath)
    if (dirent.isSymbolicLink()) throw new Error(`snapshot payload is a symlink: ${relativePath}`)
    if (dirent.isDirectory()) files.push(...listPayloads(root, relativePath))
    else if (dirent.isFile()) files.push(relativePath)
    else throw new Error(`snapshot payload is not a regular file: ${relativePath}`)
  }
  return files.sort()
}

export type RecoveryRehearsalResult = { reconstructed: number; destination: string; snapshotId: string }

export function rehearseSnapshotRecovery(cfg: Config, snapshotDir: string, destination: string): RecoveryRehearsalResult {
  if (typeof destination !== 'string' || destination.trim() === '') throw new Error('recovery destination must be explicit')
  const destinationReal = fs.realpathSync(destination)
  const dataReal = fs.realpathSync(cfg.paths.dataDir)
  const relation = path.relative(dataReal, destinationReal)
  if (destinationReal === dataReal || (!relation.startsWith('..') && !path.isAbsolute(relation))) {
    throw new Error('recovery destination must be outside the active data directory')
  }
  if (!fs.statSync(destinationReal).isDirectory()) throw new Error('recovery destination must be a directory')
  if (fs.readdirSync(destinationReal).length !== 0) throw new Error('recovery destination must be empty')

  const manifest = loadSnapshotManifest(snapshotDir)
  const payloadRoot = path.join(snapshotDir, 'files')
  if (!fs.existsSync(payloadRoot) || !fs.lstatSync(payloadRoot).isDirectory()) throw new Error('snapshot payload directory is missing')
  const actualPayloads = listPayloads(payloadRoot)
  const expectedPayloads = manifest.files.map((file) => file.relativePath).sort()
  if (JSON.stringify(actualPayloads) !== JSON.stringify(expectedPayloads)) throw new Error('snapshot contains missing or unknown payload files')

  for (const file of manifest.files) {
    const payload = path.join(payloadRoot, ...file.relativePath.split('/'))
    const stat = fs.lstatSync(payload)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`snapshot payload is not a regular file: ${file.relativePath}`)
    const bytes = fs.readFileSync(payload)
    if (bytes.byteLength !== file.byteLength) throw new Error(`snapshot payload byte length mismatch: ${file.relativePath}`)
    if (sha256(bytes) !== file.sha256) throw new Error(`snapshot payload digest mismatch: ${file.relativePath}`)
  }

  for (const file of manifest.files) {
    const source = path.join(payloadRoot, ...file.relativePath.split('/'))
    const target = path.join(destinationReal, ...file.relativePath.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  }
  return { reconstructed: manifest.files.length, destination: destinationReal, snapshotId: manifest.snapshotId }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

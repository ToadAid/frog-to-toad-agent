import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { appendJsonl } from '../store/jsonl.js'
import {
  DEVELOPMENTAL_MEMORY_SCHEMA_VERSION,
  createDevelopmentalMemoryStore,
  developMemory,
  validateDevelopmentalMemoryStore,
  type CanonicalTradingEvidenceRecord,
  type DevelopmentalMemoryBudget,
  type DevelopmentalMemoryOutcome,
  type DevelopmentalMemoryProposal,
  type DevelopmentalMemoryRevision,
  type DevelopmentalMemoryStore,
} from './developmentalMemory.js'
import { verifyCanonicalEvidence } from './canonicalEvidence.js'

export function developmentalMemoryStorePath(cfg: Config): string {
  return path.join(
    cfg.paths.dataDir,
    'memory',
    'developmental-revisions.jsonl',
  )
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function strictlyInside(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal)
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Verify the fixed store path without following any child symlink. */
function verifyDevelopmentalStorePath(
  cfg: Config,
  createParent: boolean,
): { file: string; present: boolean } {
  const dataStat = lstatIfPresent(cfg.paths.dataDir)
  if (dataStat === undefined) {
    if (!createParent) return { file: developmentalMemoryStorePath(cfg), present: false }
    throw new TypeError('developmental memory data directory is missing')
  }
  const dataReal = fs.realpathSync(cfg.paths.dataDir)
  if (!fs.statSync(dataReal).isDirectory()) throw new TypeError('developmental memory data path is not a directory')

  const memoryDir = path.join(cfg.paths.dataDir, 'memory')
  let memoryStat = lstatIfPresent(memoryDir)
  if (memoryStat === undefined && createParent) {
    fs.mkdirSync(memoryDir)
    memoryStat = fs.lstatSync(memoryDir)
  }
  if (memoryStat === undefined) return { file: developmentalMemoryStorePath(cfg), present: false }
  if (memoryStat.isSymbolicLink()) throw new TypeError('developmental memory parent must not be a symlink')
  if (!memoryStat.isDirectory()) throw new TypeError('developmental memory parent must be a directory')
  if (!strictlyInside(dataReal, fs.realpathSync(memoryDir))) throw new TypeError('developmental memory parent resolves outside data directory')

  const file = developmentalMemoryStorePath(cfg)
  const fileStat = lstatIfPresent(file)
  if (fileStat === undefined) return { file, present: false }
  if (fileStat.isSymbolicLink()) throw new TypeError('developmental memory store must not be a symlink')
  if (!fileStat.isFile()) throw new TypeError('developmental memory store must be a regular file')
  if (!strictlyInside(dataReal, fs.realpathSync(file))) throw new TypeError('developmental memory store resolves outside data directory')
  return { file, present: true }
}

/**
 * Strict replay: unlike general operational JSONL readers, developmental
 * history never skips or repairs a malformed/partial line. P1A validates the
 * complete immutable chain and every revision commitment before it is used.
 */
export function loadDevelopmentalMemoryStore(
  cfg: Config,
): Readonly<DevelopmentalMemoryStore> {
  const checked = verifyDevelopmentalStorePath(cfg, false)
  if (!checked.present) return createDevelopmentalMemoryStore()
  const file = checked.file

  const revisions: DevelopmentalMemoryRevision[] = []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') continue
    try {
      revisions.push(JSON.parse(line) as DevelopmentalMemoryRevision)
    } catch {
      throw new TypeError(
        `invalid developmental memory JSONL at line ${index + 1}`,
      )
    }
  }

  return validateDevelopmentalMemoryStore({
    schemaVersion: DEVELOPMENTAL_MEMORY_SCHEMA_VERSION,
    revisions,
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function proposalEvidence(
  proposal: unknown,
): CanonicalTradingEvidenceRecord[] {
  if (!isObject(proposal)) return []
  const values = [
    ...(Array.isArray(proposal.supportingEvidence)
      ? proposal.supportingEvidence
      : []),
    ...(Array.isArray(proposal.contradictingEvidence)
      ? proposal.contradictingEvidence
      : []),
  ]
  const unique = new Map<string, CanonicalTradingEvidenceRecord>()
  for (const value of values) {
    if (!isObject(value)) continue
    if (
      typeof value.source !== 'string' ||
      typeof value.recordId !== 'string' ||
      typeof value.cycleId !== 'string' ||
      typeof value.contentDigestSha256 !== 'string'
    ) continue
    const candidate = {
      source: value.source,
      recordId: value.recordId,
      cycleId: value.cycleId,
      contentDigestSha256: value.contentDigestSha256,
    } as CanonicalTradingEvidenceRecord
    const identity = `${String(candidate.source)}:${String(candidate.recordId)}`
    if (!unique.has(identity)) unique.set(identity, candidate)
  }
  return [...unique.values()]
}

/**
 * Durable commit pipeline. The caller supplies a proposal whose references
 * were previously resolved; every reference is re-proved against current
 * canonical evidence immediately before P1A validation and one JSONL append.
 *
 * This is a synchronous, single-process commit boundary. The repository has
 * no cross-process lock, so this module does not claim multi-writer safety.
 */
export function developMemoryDurably(
  cfg: Config,
  proposal: DevelopmentalMemoryProposal | unknown,
  budget: DevelopmentalMemoryBudget,
): DevelopmentalMemoryOutcome {
  const store = loadDevelopmentalMemoryStore(cfg)
  const catalog = proposalEvidence(proposal).map((reference) =>
    verifyCanonicalEvidence(cfg, reference),
  )
  const outcome = developMemory(store, catalog, proposal, budget)
  if (outcome.status === 'refused') return outcome

  // appendFileSync is the durable commit point available in this repository.
  // A thrown append is surfaced and no success result is returned or retried.
  const checked = verifyDevelopmentalStorePath(cfg, true)
  appendJsonl(checked.file, outcome.revision)
  return outcome
}

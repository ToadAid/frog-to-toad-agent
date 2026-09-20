import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import {
  decodeRequestObligationEventV1,
  replayRequestObligationLedgerV1,
  type RequestObligationEventV1,
  type RequestObligationStateV1,
} from './requestObligations.js'

export class RequestObligationStoreError extends Error {
  constructor(public readonly code: 'INVALID_OBLIGATION_STORE' | 'INVALID_OBLIGATION_APPEND', message: string) {
    super(`${code}: ${message}`)
    this.name = 'RequestObligationStoreError'
  }
}
function fail(code: 'INVALID_OBLIGATION_STORE' | 'INVALID_OBLIGATION_APPEND', message: string): never {
  throw new RequestObligationStoreError(code, message)
}
function lstatIfPresent(target: string): fs.Stats | undefined {
  try { return fs.lstatSync(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function strictlyInside(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
export function requestObligationStorePath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'temporal', 'request-obligations.jsonl')
}
function verifyStorePath(cfg: Config, createParent: boolean): { file: string; present: boolean } {
  const dataDir = cfg.paths.dataDir
  const file = requestObligationStorePath(cfg)
  const dataStat = lstatIfPresent(dataDir)
  if (dataStat === undefined) {
    if (!createParent) return { file, present: false }
    fail('INVALID_OBLIGATION_STORE', 'data directory is missing before append')
  }
  if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
    fail('INVALID_OBLIGATION_STORE', 'data directory must be an owned directory')
  }
  const dataReal = fs.realpathSync(dataDir)
  const temporalDir = path.join(dataDir, 'temporal')
  let temporalStat = lstatIfPresent(temporalDir)
  if (temporalStat === undefined && createParent) {
    fs.mkdirSync(temporalDir)
    temporalStat = fs.lstatSync(temporalDir)
  }
  if (temporalStat === undefined) return { file, present: false }
  if (temporalStat.isSymbolicLink() || !temporalStat.isDirectory()) {
    fail('INVALID_OBLIGATION_STORE', 'temporal parent must be an owned directory')
  }
  if (!strictlyInside(dataReal, fs.realpathSync(temporalDir))) {
    fail('INVALID_OBLIGATION_STORE', 'temporal parent resolves outside data directory')
  }
  const fileStat = lstatIfPresent(file)
  if (fileStat === undefined) return { file, present: false }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    fail('INVALID_OBLIGATION_STORE', 'obligation store must be a regular file')
  }
  if (!strictlyInside(dataReal, fs.realpathSync(file))) {
    fail('INVALID_OBLIGATION_STORE', 'obligation store resolves outside data directory')
  }
  return { file, present: true }
}

export function loadRequestObligationEventsV1(cfg: Config): readonly RequestObligationEventV1[] {
  const checked = verifyStorePath(cfg, false)
  if (!checked.present) return Object.freeze([])
  const raw = fs.readFileSync(checked.file, 'utf8')
  if (raw === '') return Object.freeze([])
  if (!raw.endsWith('\n')) fail('INVALID_OBLIGATION_STORE', 'obligation JSONL ends with a partial line')

  const events: RequestObligationEventV1[] = []
  for (const [index, line] of raw.slice(0, -1).split('\n').entries()) {
    if (line.trim() === '') fail('INVALID_OBLIGATION_STORE', `empty obligation JSONL line at ${index + 1}`)
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch {
      fail('INVALID_OBLIGATION_STORE', `invalid obligation JSONL at line ${index + 1}`)
    }
    try { events.push(decodeRequestObligationEventV1(parsed)) } catch (error) {
      fail('INVALID_OBLIGATION_STORE', `invalid obligation event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try { replayRequestObligationLedgerV1(events) } catch (error) {
    fail('INVALID_OBLIGATION_STORE', `obligation ledger replay refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  return Object.freeze(events)
}

export function loadRequestObligationStatesV1(cfg: Config): readonly RequestObligationStateV1[] {
  return replayRequestObligationLedgerV1(loadRequestObligationEventsV1(cfg))
}

/** Complete replay precedes one synchronous append. No retry or multi-writer safety is claimed. */
export function appendRequestObligationEventV1(cfg: Config, value: unknown): RequestObligationEventV1 {
  const existing = loadRequestObligationEventsV1(cfg)
  let candidate: RequestObligationEventV1
  try {
    candidate = decodeRequestObligationEventV1(value)
    replayRequestObligationLedgerV1([...existing, candidate])
  } catch (error) {
    fail('INVALID_OBLIGATION_APPEND', `candidate append refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  const checked = verifyStorePath(cfg, true)
  fs.appendFileSync(checked.file, `${JSON.stringify(candidate)}\n`, 'utf8')
  return candidate
}

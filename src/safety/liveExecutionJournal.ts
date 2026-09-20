import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Config } from '../config.js'
import { appendJsonl, readJsonl } from '../store/jsonl.js'
import { setDeskState } from './deskState.js'

export type LiveExecutionIntent = {
  runId: string
  fromSymbol: string
  fromTokenAddress?: string
  toSymbol: string
  toTokenAddress?: string
  fromAmount: number
}

export type LiveExecutionJournalEvent =
  | {
      event: 'prepared'
      executionId: string
      at: number
      pid: number
      intent: LiveExecutionIntent
    }
  | {
      event: 'ambiguous'
      executionId: string
      at: number
      reason: string
      txHash?: string
    }
  | {
      event: 'accounted'
      executionId: string
      at: number
      txHash?: string
    }

export type LiveExecutionJournalState = {
  executionId: string
  prepared?: Extract<LiveExecutionJournalEvent, { event: 'prepared' }>
  ambiguous?: Extract<LiveExecutionJournalEvent, { event: 'ambiguous' }>
  accounted?: Extract<LiveExecutionJournalEvent, { event: 'accounted' }>
}

export type LiveExecutionJournalReport = {
  ok: boolean
  corruptLines: number
  invalidEntries: number
  unresolved: LiveExecutionJournalState[]
}

export function liveExecutionJournalPath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'execution', 'live-execution.jsonl')
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function validIntent(value: unknown): value is LiveExecutionIntent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.runId === 'string' &&
    v.runId.length > 0 &&
    typeof v.fromSymbol === 'string' &&
    v.fromSymbol.length > 0 &&
    (v.fromTokenAddress === undefined || typeof v.fromTokenAddress === 'string') &&
    typeof v.toSymbol === 'string' &&
    v.toSymbol.length > 0 &&
    (v.toTokenAddress === undefined || typeof v.toTokenAddress === 'string') &&
    isFinitePositive(v.fromAmount)
  )
}

function validEvent(value: unknown): value is LiveExecutionJournalEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.executionId !== 'string' || v.executionId.length === 0) return false
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false

  if (v.event === 'prepared') {
    return (
      typeof v.pid === 'number' &&
      Number.isInteger(v.pid) &&
      v.pid > 0 &&
      validIntent(v.intent)
    )
  }
  if (v.event === 'ambiguous') {
    return (
      typeof v.reason === 'string' &&
      v.reason.length > 0 &&
      (v.txHash === undefined || typeof v.txHash === 'string')
    )
  }
  if (v.event === 'accounted') {
    return v.txHash === undefined || typeof v.txHash === 'string'
  }
  return false
}

export function readLiveExecutionJournal(cfg: Config): LiveExecutionJournalReport {
  let corruptLines = 0
  const raw = readJsonl<unknown>(liveExecutionJournalPath(cfg), {
    onCorrupt: (count) => {
      corruptLines = count
    },
  })

  let invalidEntries = 0
  const states = new Map<string, LiveExecutionJournalState>()

  for (const candidate of raw) {
    if (!validEvent(candidate)) {
      invalidEntries++
      continue
    }

    const state = states.get(candidate.executionId) ?? {
      executionId: candidate.executionId,
    }

    if (candidate.event === 'prepared') state.prepared = candidate
    else if (candidate.event === 'ambiguous') state.ambiguous = candidate
    else state.accounted = candidate

    states.set(candidate.executionId, state)
  }

  const unresolved = [...states.values()].filter(
    (state) => state.prepared !== undefined && state.accounted === undefined,
  )

  return {
    ok: corruptLines === 0 && invalidEntries === 0,
    corruptLines,
    invalidEntries,
    unresolved,
  }
}

export function prepareLiveExecution(
  cfg: Config,
  intent: LiveExecutionIntent,
  now: number = Date.now(),
): { executionId: string } {
  if (cfg.dryRun) throw new Error('LIVE_EXECUTION_JOURNAL_DRY_RUN_REFUSED')
  if (!validIntent(intent)) throw new Error('LIVE_EXECUTION_INTENT_INVALID')

  const executionId = randomUUID()
  appendJsonl(liveExecutionJournalPath(cfg), {
    event: 'prepared',
    executionId,
    at: now,
    pid: process.pid,
    intent,
  } satisfies LiveExecutionJournalEvent)
  return { executionId }
}

export function markLiveExecutionAmbiguous(
  cfg: Config,
  executionId: string,
  reason: string,
  txHash?: string,
  now: number = Date.now(),
): void {
  appendJsonl(liveExecutionJournalPath(cfg), {
    event: 'ambiguous',
    executionId,
    at: now,
    reason,
    txHash,
  } satisfies LiveExecutionJournalEvent)
}

export function markLiveExecutionAccounted(
  cfg: Config,
  executionId: string,
  txHash?: string,
  now: number = Date.now(),
): void {
  appendJsonl(liveExecutionJournalPath(cfg), {
    event: 'accounted',
    executionId,
    at: now,
    txHash,
  } satisfies LiveExecutionJournalEvent)
}

export function haltForLiveExecutionAmbiguity(cfg: Config, reason: string): void {
  setDeskState(cfg, 'HALTED', `live execution ambiguity: ${reason}`)
}

/**
 * Boot-time fail-closed classifier.
 *
 * Any unresolved prepared execution means the previous process crossed the
 * durable "about to call the wallet" boundary without proving local accounting
 * completed. Corrupt or structurally invalid journal evidence is also unsafe.
 *
 * This does not repair, replay, or infer a wallet outcome. It only persists
 * ambiguity and HALTs trading until a later principal-governed reconciliation
 * ceremony resolves it.
 */
export function enforceLiveExecutionJournalAtBoot(
  cfg: Config,
  deps: { halt?: (reason: string) => void } = {},
): LiveExecutionJournalReport & { halted: boolean; reason?: string } {
  const report = readLiveExecutionJournal(cfg)

  let reason: string | undefined
  if (!report.ok) {
    reason =
      `live execution journal invalid: ${report.corruptLines} corrupt line(s), ` +
      `${report.invalidEntries} invalid entr${report.invalidEntries === 1 ? 'y' : 'ies'}`
  } else if (report.unresolved.length > 0) {
    reason =
      `${report.unresolved.length} unresolved live execution(s): ` +
      report.unresolved
        .map((state) => {
          const intent = state.prepared?.intent
          const pair = intent
            ? `${intent.fromSymbol.toUpperCase()}→${intent.toSymbol.toUpperCase()}`
            : state.executionId
          return `${pair} ${state.executionId}`
        })
        .join('; ')
  }

  if (reason !== undefined) {
    const halt = deps.halt ?? ((message: string) => haltForLiveExecutionAmbiguity(cfg, message))
    halt(reason)
    return { ...report, halted: true, reason }
  }

  return { ...report, halted: false }
}

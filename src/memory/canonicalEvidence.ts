import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { perpsMarketSnapshotSchema } from './perpsEvidenceModel.js'
import {
  CANONICAL_TRADING_EVIDENCE_SOURCES,
  digestCanonicalJson,
  type CanonicalTradingEvidenceRecord,
  type CanonicalTradingEvidenceSource,
} from './developmentalMemory.js'

type ParsedRecord = {
  value: Record<string, unknown>
  line: number
}

type RecordBinding = ParsedRecord & {
  recordId: string
  cycleId: string
}

export interface ResolvedCanonicalEvidence {
  readonly reference: CanonicalTradingEvidenceRecord
  readonly value: Readonly<Record<string, unknown>>
}

const SOURCE_PATHS: Readonly<Record<CanonicalTradingEvidenceSource, string>> =
  Object.freeze({
    'spot-ledger': 'ledger.jsonl',
    journal: 'journal.jsonl',
    'signal-lifecycle': 'signals/lifecycle.jsonl',
    'signal-grades-ta': 'grades/ta.jsonl',
    'forecast-records': 'forecasts.jsonl',
    'paper-perps-ledger': 'perps/paper-ledger.jsonl',
    'perps-signal-journal': 'perps/signal-journal.jsonl',
    'perps-signal-grades': 'grades/perps-signals.jsonl',
  })

const SOURCES = new Set<string>(CANONICAL_TRADING_EVIDENCE_SOURCES)
const PHYSICAL_LOCATOR_SOURCES = new Set<CanonicalTradingEvidenceSource>([
  'spot-ledger',
  'journal',
  'signal-lifecycle',
  'paper-perps-ledger',
])

export type CanonicalEvidenceErrorCode =
  | 'UNKNOWN_SOURCE'
  | 'UNKNOWN_RECORD'
  | 'AMBIGUOUS_RECORD'
  | 'CYCLE_MISMATCH'
  | 'CYCLE_ID_UNAVAILABLE'
  | 'DIGEST_MISMATCH'
  | 'CORRUPT_SOURCE'

export class CanonicalEvidenceError extends Error {
  constructor(
    public readonly code: CanonicalEvidenceErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function fail(
  code: CanonicalEvidenceErrorCode,
  message: string,
): never {
  throw new CanonicalEvidenceError(code, message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('CORRUPT_SOURCE', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('CORRUPT_SOURCE', `${label} must be non-empty text`)
  }
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('CORRUPT_SOURCE', `${label} must be finite`)
  }
  return value
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail('CORRUPT_SOURCE', `${label} is invalid`)
  }
  return value as T
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    return fail('CORRUPT_SOURCE', `${label} must be boolean`)
  }
  return value
}

function optionalText(value: Record<string, unknown>, key: string, label: string): void {
  if (key in value && typeof value[key] !== 'string') fail('CORRUPT_SOURCE', `${label}.${key} must be text`)
}

function optionalFinite(value: Record<string, unknown>, key: string, label: string): void {
  if (key in value) finite(value[key], `${label}.${key}`)
}

function optionalNullableFinite(value: Record<string, unknown>, key: string, label: string): void {
  if (key in value && value[key] !== null) finite(value[key], `${label}.${key}`)
}

function validateLedgerEntry(value: Record<string, unknown>, label: string): void {
  finite(value.ts, `${label}.ts`)
  oneOf(value.type, ['open', 'close', 'pnl_mark', 'note'], `${label}.type`)
  boolean(value.dryRun, `${label}.dryRun`)
  for (const key of ['symbol', 'tokenAddress', 'chain', 'runId', 'rationale', 'txHash', 'approvalTxHash']) optionalText(value, key, label)
  for (const key of ['qty', 'entryUsd', 'exitUsd', 'feesUsd', 'minQty']) optionalFinite(value, key, label)
  if ('qtySource' in value) oneOf(value.qtySource, ['balance_delta', 'server_quote', 'estimate'], `${label}.qtySource`)
}

function validateJournalEntry(value: Record<string, unknown>, label: string): void {
  finite(value.ts, `${label}.ts`)
  text(value.symbol, `${label}.symbol`)
  text(value.decision, `${label}.decision`)
  for (const key of ['outcome', 'lesson', 'runId']) optionalText(value, key, label)
  if ('grade' in value) oneOf(value.grade, ['good-process', 'bad-process'], `${label}.grade`)
}

function validateLifecycleEvent(value: Record<string, unknown>, label: string): void {
  text(value.key, `${label}.key`)
  oneOf(value.from, ['new', 'PROPOSED', 'ACTIVE', 'CLOSED'], `${label}.from`)
  oneOf(value.to, ['PROPOSED', 'ACTIVE', 'CLOSED'], `${label}.to`)
  finite(value.ts, `${label}.ts`)
  optionalText(value, 'reason', label)
}

function validateTaGrade(value: Record<string, unknown>, label: string): void {
  text(value.key, `${label}.key`)
  text(value.symbol, `${label}.symbol`)
  oneOf(value.signal, ['BUY', 'SELL', 'HOLD'], `${label}.signal`)
  for (const key of ['entryTs', 'entryPrice', 'gradedPrice', 'movePct']) finite(value[key], `${label}.${key}`)
  optionalText(value, 'benchSymbol', label)
  optionalNullableFinite(value, 'benchMovePct', label)
  optionalNullableFinite(value, 'alphaPct', label)
  if (!(typeof value.hit === 'boolean' || value.hit === null)) fail('CORRUPT_SOURCE', `${label}.hit is invalid`)
}

function validateForecast(value: Record<string, unknown>, label: string): void {
  text(value.id, `${label}.id`)
  text(value.symbol, `${label}.symbol`)
  oneOf(value.interval, ['hourly', 'daily'], `${label}.interval`)
  for (const key of ['issuedAt', 'issuedPrice', 'horizonCandles', 'candleMs', 'bandLow', 'bandHigh', 'p50', 'movePct']) finite(value[key], `${label}.${key}`)
  if (value.pUp !== null) finite(value.pUp, `${label}.pUp`)
  if ('source' in value) oneOf(value.source, ['binance', 'coingecko', 'geckoterminal'], `${label}.source`)
  for (const key of ['chainId', 'pairAddress', 'baseAddress', 'label']) optionalText(value, key, label)
  optionalFinite(value, 'liquidityUsd', label)
  if ('graded' in value) {
    const graded = record(value.graded, `${label}.graded`)
    finite(graded.gradedAt, `${label}.graded.gradedAt`)
    finite(graded.actualPrice, `${label}.graded.actualPrice`)
    boolean(graded.inBand, `${label}.graded.inBand`)
    if (!(typeof graded.directionHit === 'boolean' || graded.directionHit === null)) fail('CORRUPT_SOURCE', `${label}.graded.directionHit is invalid`)
    finite(graded.actualMovePct, `${label}.graded.actualMovePct`)
  }
}

function validateLiquidation(value: unknown, label: string): void {
  const liquidation = record(value, label)
  if (liquidation.kind !== 'PAPER_LIQUIDATION_ESTIMATE') fail('CORRUPT_SOURCE', `${label}.kind is invalid`)
  if (liquidation.modelId !== 'paper-linear-isolated-v1') fail('CORRUPT_SOURCE', `${label}.modelId is invalid`)
  if (liquidation.synthetic !== true) fail('CORRUPT_SOURCE', `${label}.synthetic must be true`)
  for (const key of ['price', 'leverage', 'maintenanceMarginRate']) finite(liquidation[key], `${label}.${key}`)
  if (!Array.isArray(liquidation.assumptions) || !liquidation.assumptions.every((item) => typeof item === 'string')) {
    fail('CORRUPT_SOURCE', `${label}.assumptions must be text[]`)
  }
}

function validatePaperPlan(value: unknown, label: string): void {
  const plan = record(value, label)
  for (const key of ['recordId', 'instrument', 'evidenceSource', 'setup', 'reasoningRef', 'bearCase']) text(plan[key], `${label}.${key}`)
  for (const key of ['createdTs', 'entryPrice', 'stopPrice', 'targetPrice', 'leverage', 'notionalUsd', 'qty', 'initialMarginUsd', 'riskUsd', 'plannedR', 'liquidationBufferPct', 'minLiquidationBufferPct']) finite(plan[key], `${label}.${key}`)
  oneOf(plan.side, ['LONG', 'SHORT'], `${label}.side`)
  optionalText(plan, 'venue', label)
  optionalText(plan, 'signalRef', label)
  optionalFinite(plan, 'confidence', label)
  validateLiquidation(plan.liquidation, `${label}.liquidation`)
}

function validateFundingObservation(value: unknown, label: string): void {
  const observation = record(value, label)
  for (const key of ['ts', 'rate', 'markPrice', 'positionNotionalUsd', 'fundingPnlUsd']) finite(observation[key], `${label}.${key}`)
  text(observation.source, `${label}.source`)
  optionalText(observation, 'period', label)
}

function validatePerpMark(value: unknown, label: string): void {
  const mark = record(value, label)
  finite(mark.ts, `${label}.ts`)
  finite(mark.price, `${label}.price`)
  text(mark.source, `${label}.source`)
}

function validatePerpAccounting(value: unknown, label: string): void {
  const accounting = record(value, label)
  for (const key of [
    'rawPricePnlUsd', 'fundingPnlUsd', 'feesUsd', 'slippageUsd', 'netPnlUsd',
    'rawReturnPct', 'fundingAdjustedReturnPct', 'feeAdjustedReturnPct',
    'netReturnPct', 'returnOnMarginPct', 'rMultiple',
  ]) finite(accounting[key], `${label}.${key}`)
  boolean(accounting.directionCorrect, `${label}.directionCorrect`)
  optionalFinite(accounting, 'benchmarkReturnPct', label)
  optionalFinite(accounting, 'alphaPct', label)
}

function validatePaperEvent(value: Record<string, unknown>, label: string): void {
  text(value.recordId, `${label}.recordId`)
  finite(value.ts, `${label}.ts`)
  const type = oneOf(value.type, [
    'PERP_PROPOSED', 'PERP_OPENED', 'FUNDING_OBSERVED', 'PERP_MARKED',
    'PERP_REDUCED', 'PERP_CLOSED', 'PERP_CANCELLED',
  ], `${label}.type`)
  if (type === 'PERP_PROPOSED') validatePaperPlan(value.plan, `${label}.plan`)
  if (type === 'FUNDING_OBSERVED') validateFundingObservation(value.observation, `${label}.observation`)
  if (type === 'PERP_MARKED') validatePerpMark(value.mark, `${label}.mark`)
  if (type === 'PERP_REDUCED' || type === 'PERP_CLOSED') {
    for (const key of ['qty', 'exitPrice', 'rawPricePnlUsd', 'feesUsd', 'slippageUsd']) finite(value[key], `${label}.${key}`)
  }
  if (type === 'PERP_CLOSED') validatePerpAccounting(value.accounting, `${label}.accounting`)
  if (type === 'PERP_CANCELLED') optionalText(value, 'reason', label)
}

function validatePerpsSignalJournal(value: Record<string, unknown>, label: string): void {
  if (value.schemaVersion !== 1) fail('CORRUPT_SOURCE', `${label}.schemaVersion is invalid`)
  text(value.key, `${label}.key`)
  text(value.instrument, `${label}.instrument`)
  for (const key of ['evaluationAnchor', 'createdAt', 'entryMark', 'referenceMark']) finite(value[key], `${label}.${key}`)
  oneOf(value.direction, ['LONG', 'SHORT', 'FLAT'], `${label}.direction`)
  oneOf(value.setup, ['A', 'B', 'NONE'], `${label}.setup`)
  text(value.thesis, `${label}.thesis`)
  if (value.invalidation !== null) finite(value.invalidation, `${label}.invalidation`)
  if (value.target !== null) finite(value.target, `${label}.target`)
  const marketResult = perpsMarketSnapshotSchema.safeParse(value.marketSense)
  if (!marketResult.success) fail('CORRUPT_SOURCE', `${label}.marketSense is invalid`)
  const ta = record(value.taEvidence, `${label}.taEvidence`)
  for (const key of [
    'hourlyClose', 'hourlyBollingerWidth', 'hourlyBollingerUpper',
    'hourlyBollingerLower', 'hourlyVolume', 'hourlyVolumeAvg', 'hourlyRsi',
    'dailyEma20', 'dailyEma50',
  ]) finite(ta[key], `${label}.taEvidence.${key}`)
  const provenance = record(value.provenance, `${label}.provenance`)
  text(provenance.provider, `${label}.provenance.provider`)
  text(provenance.taSource, `${label}.provenance.taSource`)
  if (value.authorityGranted !== false) fail('CORRUPT_SOURCE', `${label}.authorityGranted must be false`)
}

function validatePerpsSignalGrade(value: Record<string, unknown>, label: string): void {
  text(value.key, `${label}.key`)
  text(value.instrument, `${label}.instrument`)
  oneOf(value.direction, ['LONG', 'SHORT'], `${label}.direction`)
  oneOf(value.setup, ['A', 'B'], `${label}.setup`)
  for (const key of [
    'entryTs', 'gradedTs', 'horizonHours', 'entryMark', 'exitMark',
    'underlyingMove', 'fundingContribution', 'fundingAdjustedReturn',
  ]) finite(value[key], `${label}.${key}`)
  text(value.exitMarkProvider, `${label}.exitMarkProvider`)
  boolean(value.directionallyCorrect, `${label}.directionallyCorrect`)
  text(value.benchmarkSymbol, `${label}.benchmarkSymbol`)
  for (const key of ['benchmarkMovePct', 'relativeMove']) {
    if (value[key] !== null) finite(value[key], `${label}.${key}`)
  }
  if (!(typeof value.alphaHit === 'boolean' || value.alphaHit === null)) fail('CORRUPT_SOURCE', `${label}.alphaHit is invalid`)
}

/** Physical append-only record locator, never a business ID or learning cycle. */
function lineIdentity(source: CanonicalTradingEvidenceSource, line: number): string {
  return `${source}:${line}`
}

function bind(
  source: CanonicalTradingEvidenceSource,
  parsed: ParsedRecord,
): RecordBinding {
  const { value, line } = parsed
  const label = `${source} line ${line}`

  switch (source) {
    case 'spot-ledger': {
      validateLedgerEntry(value, label)
      const recordId = lineIdentity(source, line)
      if (typeof value.runId !== 'string' || value.runId.trim() === '') {
        return fail('CYCLE_ID_UNAVAILABLE', `${label}.runId is required for developmental evidence`)
      }
      return { ...parsed, recordId, cycleId: value.runId }
    }
    case 'journal': {
      validateJournalEntry(value, label)
      const recordId = lineIdentity(source, line)
      if (typeof value.runId !== 'string' || value.runId.trim() === '') {
        return fail('CYCLE_ID_UNAVAILABLE', `${label}.runId is required for developmental evidence`)
      }
      return { ...parsed, recordId, cycleId: value.runId }
    }
    case 'signal-lifecycle': {
      validateLifecycleEvent(value, label)
      return { ...parsed, recordId: lineIdentity(source, line), cycleId: value.key as string }
    }
    case 'signal-grades-ta': {
      validateTaGrade(value, label)
      const key = text(value.key, `${label}.key`)
      return { ...parsed, recordId: key, cycleId: key }
    }
    case 'forecast-records': {
      validateForecast(value, label)
      const id = text(value.id, `${label}.id`)
      return { ...parsed, recordId: id, cycleId: id }
    }
    case 'paper-perps-ledger': {
      validatePaperEvent(value, label)
      const positionId = text(value.recordId, `${label}.recordId`)
      return { ...parsed, recordId: lineIdentity(source, line), cycleId: positionId }
    }
    case 'perps-signal-journal': {
      validatePerpsSignalJournal(value, label)
      const key = text(value.key, `${label}.key`)
      return { ...parsed, recordId: key, cycleId: key }
    }
    case 'perps-signal-grades': {
      validatePerpsSignalGrade(value, label)
      const key = text(value.key, `${label}.key`)
      return { ...parsed, recordId: key, cycleId: key }
    }
  }
}

function sourcePath(cfg: Config, source: CanonicalTradingEvidenceSource): string {
  return path.join(cfg.paths.dataDir, ...SOURCE_PATHS[source].split('/'))
}

function strictRecords(
  cfg: Config,
  source: CanonicalTradingEvidenceSource,
): ParsedRecord[] {
  const file = sourcePath(cfg, source)
  if (!fs.existsSync(file)) return []

  const dataRoot = fs.realpathSync(cfg.paths.dataDir)
  let current = cfg.paths.dataDir
  for (const part of SOURCE_PATHS[source].split('/')) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) fail('CORRUPT_SOURCE', `${source} path contains a symlink`)
  }
  const relative = path.relative(dataRoot, fs.realpathSync(file))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CORRUPT_SOURCE', `${source} resolves outside data directory`)
  }
  if (!fs.statSync(file).isFile()) fail('CORRUPT_SOURCE', `${source} is not a regular file`)

  const parsed: ParsedRecord[] = []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      fail('CORRUPT_SOURCE', `${source} line ${index + 1} is malformed JSON`)
    }
    parsed.push({ value: record(value, `${source} line ${index + 1}`), line: index + 1 })
  }
  return parsed
}

function checkedSource(value: unknown): CanonicalTradingEvidenceSource {
  if (typeof value !== 'string' || !SOURCES.has(value)) {
    return fail('UNKNOWN_SOURCE', 'canonical evidence source is not allowlisted')
  }
  return value as CanonicalTradingEvidenceSource
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

/**
 * Resolve one exact local canonical record and its validated content. The
 * returned value comes from strict JSON parsing, is deeply frozen, and never
 * exposes a filesystem path or mutation capability.
 */
export function resolveValidatedCanonicalEvidence(
  cfg: Config,
  sourceValue: unknown,
  recordId: string,
): Readonly<ResolvedCanonicalEvidence> {
  const source = checkedSource(sourceValue)
  if (typeof recordId !== 'string' || recordId.trim() === '') {
    return fail('UNKNOWN_RECORD', `${source} record identity is empty`)
  }
  const parsed = strictRecords(cfg, source)
  const candidates = PHYSICAL_LOCATOR_SOURCES.has(source)
    ? parsed.filter(({ line }) => lineIdentity(source, line) === recordId)
    : parsed
  const matches = candidates
    .map((parsed) => bind(source, parsed))
    .filter((candidate) => candidate.recordId === recordId)
  if (matches.length === 0) return fail('UNKNOWN_RECORD', `unknown ${source} record ${recordId}`)
  if (matches.length !== 1) return fail('AMBIGUOUS_RECORD', `ambiguous ${source} record ${recordId}`)
  const found = matches[0]!
  const reference = Object.freeze({
    source,
    recordId: found.recordId,
    cycleId: found.cycleId,
    contentDigestSha256: digestCanonicalJson(found.value),
  })
  return deepFreeze({ reference, value: found.value })
}

/** Resolve one exact local canonical record; never accepts a filesystem path. */
export function resolveCanonicalEvidence(
  cfg: Config,
  sourceValue: unknown,
  recordId: string,
): CanonicalTradingEvidenceRecord {
  return resolveValidatedCanonicalEvidence(cfg, sourceValue, recordId).reference
}

/** Re-resolve and prove a proposed P1A reference against current canonical bytes. */
export function verifyCanonicalEvidence(
  cfg: Config,
  expected: CanonicalTradingEvidenceRecord,
): CanonicalTradingEvidenceRecord {
  const actual = resolveCanonicalEvidence(cfg, expected.source, expected.recordId)
  if (actual.cycleId !== expected.cycleId) {
    return fail('CYCLE_MISMATCH', `canonical evidence cycle mismatch for ${expected.source}:${expected.recordId}`)
  }
  if (actual.contentDigestSha256 !== expected.contentDigestSha256) {
    return fail('DIGEST_MISMATCH', `canonical evidence digest mismatch for ${expected.source}:${expected.recordId}`)
  }
  return actual
}

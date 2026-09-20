import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import {
  parseEntries,
  workspaceFilePath,
} from '../store/workspace.js'
import { digestCanonicalJson, serializeCanonicalJson } from './developmentalMemory.js'
import {
  validatePrincipalProvenance,
  type PrincipalDeclaredProvenance,
  type PrincipalDeclarationType,
} from './principalProvenance.js'
import { loadPrincipalProvenanceCatalog } from './principalAdmission.js'

export const PRINCIPAL_LIFECYCLE_SCHEMA_VERSION = 1 as const
export const AUTHENTICATED_LIFECYCLE_REFERENCE_SCHEMA_VERSION = 1 as const
export const PRINCIPAL_LIFECYCLE_STATE_SCHEMA_VERSION = 1 as const

export const PRINCIPAL_LIFECYCLE_KINDS = [
  'PRINCIPAL_DECLARATION_REVOKED',
  'PRINCIPAL_DECLARATION_SUPERSEDED',
] as const

export type PrincipalLifecycleKind = typeof PRINCIPAL_LIFECYCLE_KINDS[number]

export interface AuthenticatedPrincipalLifecycleReference {
  readonly schemaVersion: typeof AUTHENTICATED_LIFECYCLE_REFERENCE_SCHEMA_VERSION
  readonly source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE'
  readonly lifecycleReferenceId: string
  readonly principalReference: string
  readonly authenticationRecordId: string
  readonly authorityGranted: false
}

interface PrincipalLifecycleBase {
  readonly schemaVersion: typeof PRINCIPAL_LIFECYCLE_SCHEMA_VERSION
  readonly lifecycleEventId: string
  readonly targetProvenanceId: string
  readonly targetDeclarationId: string
  readonly targetContentDigestSha256: string
  readonly targetDeclarationType: PrincipalDeclarationType
  readonly principalReference: string
  readonly authenticatedLifecycleReference: AuthenticatedPrincipalLifecycleReference
  readonly authorityGranted: false
}

export interface PrincipalDeclarationRevokedEvent extends PrincipalLifecycleBase {
  readonly lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED'
}

export interface PrincipalDeclarationSupersededEvent extends PrincipalLifecycleBase {
  readonly lifecycleKind: 'PRINCIPAL_DECLARATION_SUPERSEDED'
  readonly successorProvenanceId: string
  readonly successorDeclarationId: string
  readonly successorContentDigestSha256: string
  readonly successorDeclarationType: PrincipalDeclarationType
}

export type PrincipalLifecycleEvent =
  | PrincipalDeclarationRevokedEvent
  | PrincipalDeclarationSupersededEvent

type PrincipalLifecycleInputBase = Omit<PrincipalLifecycleBase, 'lifecycleEventId'>

export type PrincipalLifecycleEventInput =
  | (PrincipalLifecycleInputBase & {
      readonly lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED'
    })
  | (PrincipalLifecycleInputBase & {
      readonly lifecycleKind: 'PRINCIPAL_DECLARATION_SUPERSEDED'
      readonly successorProvenanceId: string
      readonly successorDeclarationId: string
      readonly successorContentDigestSha256: string
      readonly successorDeclarationType: PrincipalDeclarationType
    })

export type PrincipalLifecycleStatus = 'ACTIVE' | 'REVOKED' | 'SUPERSEDED'

export interface PrincipalLifecycleResolution {
  readonly schemaVersion: typeof PRINCIPAL_LIFECYCLE_STATE_SCHEMA_VERSION
  readonly declarations: readonly Readonly<PrincipalDeclaredProvenance>[]
  readonly lifecycleEvents: readonly Readonly<PrincipalLifecycleEvent>[]
  readonly activeDeclarations: readonly Readonly<PrincipalDeclaredProvenance>[]
  readonly statusByProvenanceId: readonly Readonly<{
    provenanceId: string
    status: PrincipalLifecycleStatus
    terminalLifecycleEventId?: string
  }>[]
  readonly lifecycleStateDigestSha256: string
  readonly authorityGranted: false
}

export type PrincipalLifecycleErrorCode =
  | 'INVALID_LIFECYCLE_EVENT'
  | 'UNKNOWN_LIFECYCLE_KIND'
  | 'LIFECYCLE_DIGEST_MISMATCH'
  | 'AUTHORITY_REQUESTED'
  | 'INVALID_LIFECYCLE_STORE'
  | 'DUPLICATE_LIFECYCLE_EVENT'
  | 'MULTIPLE_TERMINAL_EVENTS'
  | 'INVALID_DECLARATION_CATALOG'
  | 'DECLARATION_KIND_REFUSED'
  | 'MISSING_TARGET_DECLARATION'
  | 'MISSING_SUCCESSOR_DECLARATION'
  | 'DECLARATION_BINDING_MISMATCH'
  | 'PRINCIPAL_REFERENCE_MISMATCH'
  | 'SELF_SUPERSESSION'
  | 'SUPERSESSION_CYCLE'
  | 'INCOHERENT_USER_PROJECTION'

export class PrincipalLifecycleError extends Error {
  constructor(
    public readonly code: PrincipalLifecycleErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'PrincipalLifecycleError'
  }
}

function fail(code: PrincipalLifecycleErrorCode, message: string): never {
  throw new PrincipalLifecycleError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isDeclarationType(value: unknown): value is PrincipalDeclarationType {
  return value === 'INSTRUCTION' || value === 'PREFERENCE'
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function rejectAuthority(value: unknown, label: string): void {
  if (isRecord(value) && 'authorityGranted' in value && value.authorityGranted !== false) {
    return fail('AUTHORITY_REQUESTED', `${label} cannot grant authority`)
  }
}

function validAuthenticatedReference(
  value: unknown,
): value is AuthenticatedPrincipalLifecycleReference {
  return isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'source',
      'lifecycleReferenceId',
      'principalReference',
      'authenticationRecordId',
      'authorityGranted',
    ]) &&
    value.schemaVersion === AUTHENTICATED_LIFECYCLE_REFERENCE_SCHEMA_VERSION &&
    value.source === 'UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE' &&
    typeof value.lifecycleReferenceId === 'string' &&
    /^principal-lifecycle:[a-f0-9]{64}$/.test(value.lifecycleReferenceId) &&
    hasText(value.principalReference) &&
    typeof value.authenticationRecordId === 'string' &&
    /^principal-lifecycle-auth:[a-f0-9]{64}$/.test(value.authenticationRecordId) &&
    value.authorityGranted === false
}

function eventKeys(kind: PrincipalLifecycleKind): readonly string[] {
  const common = [
    'schemaVersion',
    'lifecycleEventId',
    'lifecycleKind',
    'targetProvenanceId',
    'targetDeclarationId',
    'targetContentDigestSha256',
    'targetDeclarationType',
    'principalReference',
    'authenticatedLifecycleReference',
    'authorityGranted',
  ]
  return kind === 'PRINCIPAL_DECLARATION_SUPERSEDED'
    ? [...common, 'successorProvenanceId', 'successorDeclarationId', 'successorContentDigestSha256', 'successorDeclarationType']
    : common
}

function eventInputKeys(kind: PrincipalLifecycleKind): readonly string[] {
  return eventKeys(kind).filter((key) => key !== 'lifecycleEventId')
}

function eventCommitment(event: PrincipalLifecycleEvent): string {
  const { lifecycleEventId: _ignored, ...committed } = event
  return digestCanonicalJson(committed)
}

export function validatePrincipalLifecycleEvent(
  input: PrincipalLifecycleEvent | unknown,
): Readonly<PrincipalLifecycleEvent> {
  rejectAuthority(input, 'principal lifecycle event')
  if (!isRecord(input)) {
    return fail('INVALID_LIFECYCLE_EVENT', 'principal lifecycle event must be an object')
  }
  const kind = input.lifecycleKind
  if (!PRINCIPAL_LIFECYCLE_KINDS.includes(kind as PrincipalLifecycleKind)) {
    return fail('UNKNOWN_LIFECYCLE_KIND', 'unknown principal lifecycle event kind')
  }
  if (!hasExactKeys(input, eventKeys(kind as PrincipalLifecycleKind))) {
    return fail('INVALID_LIFECYCLE_EVENT', 'principal lifecycle event has unknown or missing fields')
  }
  rejectAuthority(input.authenticatedLifecycleReference, 'authenticated lifecycle reference')
  if (
    input.schemaVersion !== PRINCIPAL_LIFECYCLE_SCHEMA_VERSION ||
    !hasText(input.lifecycleEventId) ||
    !hasText(input.targetProvenanceId) ||
    !hasText(input.targetDeclarationId) ||
    !isDigest(input.targetContentDigestSha256) ||
    !isDeclarationType(input.targetDeclarationType) ||
    !hasText(input.principalReference) ||
    !validAuthenticatedReference(input.authenticatedLifecycleReference) ||
    input.authenticatedLifecycleReference.principalReference !== input.principalReference ||
    input.authorityGranted !== false
  ) {
    return fail('INVALID_LIFECYCLE_EVENT', 'principal lifecycle event fields are malformed')
  }
  if (kind === 'PRINCIPAL_DECLARATION_SUPERSEDED') {
    if (
      !hasText(input.successorProvenanceId) ||
      !hasText(input.successorDeclarationId) ||
      !isDigest(input.successorContentDigestSha256) ||
      !isDeclarationType(input.successorDeclarationType)
    ) {
      return fail('INVALID_LIFECYCLE_EVENT', 'supersession successor fields are malformed')
    }
    if (input.successorProvenanceId === input.targetProvenanceId) {
      return fail('SELF_SUPERSESSION', 'a declaration cannot supersede itself')
    }
  }
  const candidate = clone(input) as unknown as PrincipalLifecycleEvent
  if (eventCommitment(candidate) !== candidate.lifecycleEventId) {
    return fail('LIFECYCLE_DIGEST_MISMATCH', 'principal lifecycle event identity does not match its canonical content')
  }
  return deepFreeze(candidate)
}

export function createPrincipalLifecycleEvent(
  input: PrincipalLifecycleEventInput | unknown,
): Readonly<PrincipalLifecycleEvent> {
  rejectAuthority(input, 'principal lifecycle input')
  if (!isRecord(input)) {
    return fail('INVALID_LIFECYCLE_EVENT', 'principal lifecycle input must be an object')
  }
  const kind = input.lifecycleKind
  if (!PRINCIPAL_LIFECYCLE_KINDS.includes(kind as PrincipalLifecycleKind)) {
    return fail('UNKNOWN_LIFECYCLE_KIND', 'unknown principal lifecycle event kind')
  }
  if (!hasExactKeys(input, eventInputKeys(kind as PrincipalLifecycleKind))) {
    return fail('INVALID_LIFECYCLE_EVENT', 'principal lifecycle input has unknown or missing fields')
  }
  const withPlaceholder = {
    ...clone(input),
    lifecycleEventId: 'pending',
  } as PrincipalLifecycleEvent
  const event = {
    ...withPlaceholder,
    lifecycleEventId: eventCommitment(withPlaceholder),
  }
  return validatePrincipalLifecycleEvent(event)
}

export function serializePrincipalLifecycleEvent(event: unknown): string {
  return serializeCanonicalJson(validatePrincipalLifecycleEvent(event))
}

function validateDeclarationCatalog(
  catalog: readonly unknown[],
): readonly Readonly<PrincipalDeclaredProvenance>[] {
  if (!Array.isArray(catalog)) {
    return fail('INVALID_DECLARATION_CATALOG', 'declaration catalog must be an array')
  }
  const declarations: Readonly<PrincipalDeclaredProvenance>[] = []
  const ids = new Set<string>()
  const content = new Set<string>()
  for (const value of catalog) {
    let provenance
    try {
      provenance = validatePrincipalProvenance(value)
    } catch {
      return fail('INVALID_DECLARATION_CATALOG', 'declaration catalog contains invalid P3A provenance')
    }
    if (provenance.provenanceKind !== 'PRINCIPAL_DECLARED') {
      return fail('DECLARATION_KIND_REFUSED', 'lifecycle state accepts PRINCIPAL_DECLARED provenance only')
    }
    if (ids.has(provenance.provenanceId) || content.has(provenance.content)) {
      return fail('INVALID_DECLARATION_CATALOG', 'declaration catalog contains duplicate or ambiguous records')
    }
    ids.add(provenance.provenanceId)
    content.add(provenance.content)
    declarations.push(provenance)
  }
  return Object.freeze(declarations)
}

function validateLifecycleCatalog(
  catalog: readonly unknown[],
): readonly Readonly<PrincipalLifecycleEvent>[] {
  if (!Array.isArray(catalog)) {
    return fail('INVALID_LIFECYCLE_STORE', 'lifecycle catalog must be an array')
  }
  const events: Readonly<PrincipalLifecycleEvent>[] = []
  const ids = new Set<string>()
  const targets = new Set<string>()
  for (const value of catalog) {
    const event = validatePrincipalLifecycleEvent(value)
    if (ids.has(event.lifecycleEventId)) {
      return fail('DUPLICATE_LIFECYCLE_EVENT', 'duplicate lifecycle event identity')
    }
    if (targets.has(event.targetProvenanceId)) {
      return fail('MULTIPLE_TERMINAL_EVENTS', 'a declaration has more than one terminal lifecycle event')
    }
    ids.add(event.lifecycleEventId)
    targets.add(event.targetProvenanceId)
    events.push(event)
  }
  assertNoSupersessionCycle(events)
  return Object.freeze(events)
}

function declarationMatchesTarget(
  declaration: PrincipalDeclaredProvenance,
  event: PrincipalLifecycleEvent,
): boolean {
  return declaration.declarationReference.declarationId === event.targetDeclarationId &&
    declaration.contentDigestSha256 === event.targetContentDigestSha256 &&
    declaration.declarationType === event.targetDeclarationType
}

function declarationMatchesSuccessor(
  declaration: PrincipalDeclaredProvenance,
  event: PrincipalDeclarationSupersededEvent,
): boolean {
  return declaration.declarationReference.declarationId === event.successorDeclarationId &&
    declaration.contentDigestSha256 === event.successorContentDigestSha256 &&
    declaration.declarationType === event.successorDeclarationType
}

function assertNoSupersessionCycle(events: readonly PrincipalLifecycleEvent[]): void {
  const edge = new Map<string, string>()
  for (const event of events) {
    if (event.lifecycleKind === 'PRINCIPAL_DECLARATION_SUPERSEDED') {
      edge.set(event.targetProvenanceId, event.successorProvenanceId)
    }
  }
  for (const start of edge.keys()) {
    const visited = new Set<string>()
    let current: string | undefined = start
    while (current !== undefined) {
      if (visited.has(current)) {
        return fail('SUPERSESSION_CYCLE', 'supersession graph contains a cycle')
      }
      visited.add(current)
      current = edge.get(current)
    }
  }
}

/** Pure exact-identity lifecycle precedence; no clock, I/O, or interpretation. */
export function resolvePrincipalLifecycleState(
  declarationCatalog: readonly unknown[],
  lifecycleCatalog: readonly unknown[],
): Readonly<PrincipalLifecycleResolution> {
  const declarations = validateDeclarationCatalog(declarationCatalog)
  const events = validateLifecycleCatalog(lifecycleCatalog)
  const byId = new Map(declarations.map((declaration) => [declaration.provenanceId, declaration]))

  for (const event of events) {
    const target = byId.get(event.targetProvenanceId)
    if (target === undefined) {
      return fail('MISSING_TARGET_DECLARATION', 'lifecycle target is absent from the declaration catalog')
    }
    if (!declarationMatchesTarget(target, event)) {
      return fail('DECLARATION_BINDING_MISMATCH', 'lifecycle target digest, type, or declaration identity does not match')
    }
    if (
      target.declarationReference.principalReference !== event.principalReference ||
      event.authenticatedLifecycleReference.principalReference !== event.principalReference
    ) {
      return fail('PRINCIPAL_REFERENCE_MISMATCH', 'lifecycle principal reference does not match its target')
    }
    if (event.lifecycleKind === 'PRINCIPAL_DECLARATION_SUPERSEDED') {
      const successor = byId.get(event.successorProvenanceId)
      if (successor === undefined) {
        return fail('MISSING_SUCCESSOR_DECLARATION', 'supersession successor is absent from the declaration catalog')
      }
      if (!declarationMatchesSuccessor(successor, event)) {
        return fail('DECLARATION_BINDING_MISMATCH', 'successor digest, type, or declaration identity does not match')
      }
      if (successor.declarationReference.principalReference !== event.principalReference) {
        return fail('PRINCIPAL_REFERENCE_MISMATCH', 'successor belongs to another principal reference')
      }
    }
  }
  assertNoSupersessionCycle(events)

  const terminal = new Map(events.map((event) => [event.targetProvenanceId, event]))
  const activeDeclarations = declarations.filter((declaration) => !terminal.has(declaration.provenanceId))
  const statusByProvenanceId = declarations.map((declaration) => {
    const event = terminal.get(declaration.provenanceId)
    if (event === undefined) return { provenanceId: declaration.provenanceId, status: 'ACTIVE' as const }
    return {
      provenanceId: declaration.provenanceId,
      status: event.lifecycleKind === 'PRINCIPAL_DECLARATION_REVOKED'
        ? 'REVOKED' as const
        : 'SUPERSEDED' as const,
      terminalLifecycleEventId: event.lifecycleEventId,
    }
  })
  const committed = {
    schemaVersion: PRINCIPAL_LIFECYCLE_STATE_SCHEMA_VERSION,
    declarations,
    lifecycleEvents: events,
    activeDeclarations,
    statusByProvenanceId,
    authorityGranted: false as const,
  }
  return deepFreeze({
    ...clone(committed),
    lifecycleStateDigestSha256: digestCanonicalJson(committed),
  }) as Readonly<PrincipalLifecycleResolution>
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

export function principalLifecycleStorePath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'memory', 'principal-lifecycle.jsonl')
}

function verifyLifecycleStorePath(
  cfg: Config,
  createParent: boolean,
): { file: string; present: boolean } {
  const file = principalLifecycleStorePath(cfg)
  const dataStat = lstatIfPresent(cfg.paths.dataDir)
  if (dataStat === undefined) {
    if (!createParent) return { file, present: false }
    return fail('INVALID_LIFECYCLE_STORE', 'data directory is missing before lifecycle append')
  }
  if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
    return fail('INVALID_LIFECYCLE_STORE', 'data path must be an owned directory, not a symlink')
  }
  const dataReal = fs.realpathSync(cfg.paths.dataDir)
  const memoryDir = path.join(cfg.paths.dataDir, 'memory')
  let memoryStat = lstatIfPresent(memoryDir)
  if (memoryStat === undefined && createParent) {
    fs.mkdirSync(memoryDir)
    memoryStat = fs.lstatSync(memoryDir)
  }
  if (memoryStat === undefined) return { file, present: false }
  if (memoryStat.isSymbolicLink() || !memoryStat.isDirectory()) {
    return fail('INVALID_LIFECYCLE_STORE', 'lifecycle parent must be an owned directory, not a symlink')
  }
  if (!strictlyInside(dataReal, fs.realpathSync(memoryDir))) {
    return fail('INVALID_LIFECYCLE_STORE', 'lifecycle parent resolves outside the data directory')
  }
  const fileStat = lstatIfPresent(file)
  if (fileStat === undefined) return { file, present: false }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return fail('INVALID_LIFECYCLE_STORE', 'lifecycle store must be a regular file, not a symlink')
  }
  if (!strictlyInside(dataReal, fs.realpathSync(file))) {
    return fail('INVALID_LIFECYCLE_STORE', 'lifecycle store resolves outside the data directory')
  }
  return { file, present: true }
}

export function loadPrincipalLifecycleCatalog(
  cfg: Config,
): readonly Readonly<PrincipalLifecycleEvent>[] {
  const checked = verifyLifecycleStorePath(cfg, false)
  if (!checked.present) return Object.freeze([])
  const raw = fs.readFileSync(checked.file, 'utf8')
  if (raw === '') return Object.freeze([])
  if (!raw.endsWith('\n')) {
    return fail('INVALID_LIFECYCLE_STORE', 'principal lifecycle JSONL ends with a partial line')
  }
  const parsed: unknown[] = []
  for (const [index, line] of raw.slice(0, -1).split('\n').entries()) {
    if (line.trim() === '') {
      return fail('INVALID_LIFECYCLE_STORE', `principal lifecycle JSONL has an empty line at ${index + 1}`)
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return fail('INVALID_LIFECYCLE_STORE', `invalid principal lifecycle JSONL at line ${index + 1}`)
    }
    const validated = validatePrincipalLifecycleEvent(value)
    if (line !== serializePrincipalLifecycleEvent(validated)) {
      return fail(
        'INVALID_LIFECYCLE_STORE',
        `principal lifecycle JSONL has a noncanonical line at ${index + 1}`,
      )
    }
    parsed.push(validated)
  }
  return validateLifecycleCatalog(parsed)
}

function readUserEntriesStrict(cfg: Config): readonly string[] {
  const file = workspaceFilePath(cfg.paths.dataDir, 'user')
  const parent = path.dirname(file)
  const parentStat = lstatIfPresent(parent)
  if (parentStat === undefined) return Object.freeze([])
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return fail('INCOHERENT_USER_PROJECTION', 'USER.md parent must be an owned directory, not a symlink')
  }
  const fileStat = lstatIfPresent(file)
  if (fileStat === undefined) return Object.freeze([])
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return fail('INCOHERENT_USER_PROJECTION', 'USER.md must be a regular file, not a symlink')
  }
  return Object.freeze(parseEntries(fs.readFileSync(file, 'utf8')))
}

function assertActiveUserCoherence(
  state: PrincipalLifecycleResolution,
  userEntries: readonly string[],
): void {
  for (const declaration of state.activeDeclarations) {
    if (userEntries.filter((entry) => entry === declaration.content).length !== 1) {
      return fail(
        'INCOHERENT_USER_PROJECTION',
        'each active authenticated declaration must have exactly one matching USER.md entry',
      )
    }
  }
}

export function loadCoherentPrincipalLifecycleState(
  cfg: Config,
): Readonly<PrincipalLifecycleResolution> {
  const declarations = loadPrincipalProvenanceCatalog(cfg)
  const lifecycle = loadPrincipalLifecycleCatalog(cfg)
  const state = resolvePrincipalLifecycleState(declarations, lifecycle)
  assertActiveUserCoherence(state, readUserEntriesStrict(cfg))
  return state
}

export function appendPrincipalLifecycleEvent(
  cfg: Config,
  input: PrincipalLifecycleEvent | unknown,
): Readonly<PrincipalLifecycleEvent> {
  const current = loadCoherentPrincipalLifecycleState(cfg)
  const event = validatePrincipalLifecycleEvent(input)
  const proposed = resolvePrincipalLifecycleState(
    current.declarations,
    [...current.lifecycleEvents, event],
  )
  assertActiveUserCoherence(proposed, readUserEntriesStrict(cfg))
  const checked = verifyLifecycleStorePath(cfg, true)
  fs.appendFileSync(checked.file, `${serializePrincipalLifecycleEvent(event)}\n`, 'utf8')
  return event
}

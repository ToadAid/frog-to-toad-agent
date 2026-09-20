import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import type { TelegramSender } from '../types.js'
import { escapeHtml } from '../telegram/render.js'
import {
  applyWorkspaceOp,
  ENTRY_DELIMITER,
  parseEntries,
  USER_CHAR_LIMIT,
  workspaceFilePath,
  type WorkspaceOp,
  type WorkspaceResult,
} from '../store/workspace.js'
import { digestCanonicalJson } from './developmentalMemory.js'
import {
  createPrincipalDeclaredProvenance,
  serializePrincipalProvenance,
  validatePrincipalProvenance,
  type PrincipalDeclaredProvenance,
  type PrincipalDeclarationType,
} from './principalProvenance.js'
import { loadCoherentPrincipalLifecycleState } from './principalLifecycle.js'

export const PRINCIPAL_ADMISSION_SCHEMA_VERSION = 1 as const
export const PRINCIPAL_CONFIRMATION_CALLBACK_PREFIX = 'pdecl:' as const

export type PrincipalAdmissionErrorCode =
  | 'INVALID_AUTHENTICATION_CONTEXT'
  | 'INVALID_DECLARATION_CONTENT'
  | 'INVALID_PROVENANCE_STORE'
  | 'PROVENANCE_KIND_REFUSED'
  | 'DUPLICATE_PROVENANCE'
  | 'AMBIGUOUS_PROVENANCE'
  | 'CONFLICTING_DECLARATION'
  | 'INCOHERENT_USER_PROJECTION'
  | 'USER_CAPACITY_REFUSED'
  | 'USER_WRITE_FAILED'

export class PrincipalAdmissionError extends Error {
  constructor(
    public readonly code: PrincipalAdmissionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'PrincipalAdmissionError'
  }
}

export interface TelegramPrincipalConfirmationContext {
  readonly schemaVersion: typeof PRINCIPAL_ADMISSION_SCHEMA_VERSION
  readonly chatId: number
  readonly chatType: 'private'
  readonly principalUserId: number
  readonly commandMessageId: number
  readonly commandUpdateId: number
  readonly confirmationMessageId: number
  readonly callbackQueryId: string
  readonly declarationType: PrincipalDeclarationType
  readonly content: string
  readonly authorityGranted: false
}

export type PrincipalAdmissionResult = Readonly<
  | {
      status: 'admitted' | 'already_admitted'
      provenance: Readonly<PrincipalDeclaredProvenance>
      userEntryCreated: boolean
      authorityGranted: false
    }
  | {
      status: 'partial_user_note_only'
      userEntryCreated: boolean
      warning: string
      authorityGranted: false
    }
>

type StoreAppendResult = Readonly<{
  status: 'appended' | 'already_present'
  provenance: Readonly<PrincipalDeclaredProvenance>
}>

function fail(code: PrincipalAdmissionErrorCode, message: string): never {
  throw new PrincipalAdmissionError(code, message)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
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

export function principalProvenanceStorePath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'memory', 'principal-provenance.jsonl')
}

function verifyPrincipalStorePath(
  cfg: Config,
  createParent: boolean,
): { file: string; present: boolean } {
  const file = principalProvenanceStorePath(cfg)
  const dataStat = lstatIfPresent(cfg.paths.dataDir)
  if (dataStat === undefined) {
    if (!createParent) return { file, present: false }
    throw new PrincipalAdmissionError(
      'INVALID_PROVENANCE_STORE',
      'data directory is missing before the provenance commit point',
    )
  }
  if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
    return fail(
      'INVALID_PROVENANCE_STORE',
      'data path must be an owned directory, not a symlink',
    )
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
    return fail(
      'INVALID_PROVENANCE_STORE',
      'provenance parent must be an owned directory, not a symlink',
    )
  }
  if (!strictlyInside(dataReal, fs.realpathSync(memoryDir))) {
    return fail(
      'INVALID_PROVENANCE_STORE',
      'provenance parent resolves outside the data directory',
    )
  }

  const fileStat = lstatIfPresent(file)
  if (fileStat === undefined) return { file, present: false }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return fail(
      'INVALID_PROVENANCE_STORE',
      'provenance store must be a regular file, not a symlink',
    )
  }
  if (!strictlyInside(dataReal, fs.realpathSync(file))) {
    return fail(
      'INVALID_PROVENANCE_STORE',
      'provenance store resolves outside the data directory',
    )
  }
  return { file, present: true }
}

function validateCatalogCoherence(
  values: readonly unknown[],
): readonly Readonly<PrincipalDeclaredProvenance>[] {
  const records: Readonly<PrincipalDeclaredProvenance>[] = []
  const ids = new Set<string>()
  const content = new Map<string, PrincipalDeclarationType>()

  for (const value of values) {
    let validated
    try {
      validated = validatePrincipalProvenance(value)
    } catch {
      return fail(
        'INVALID_PROVENANCE_STORE',
        'stored provenance failed the complete P3A validator',
      )
    }
    if (validated.provenanceKind !== 'PRINCIPAL_DECLARED') {
      return fail(
        'PROVENANCE_KIND_REFUSED',
        'the principal store accepts PRINCIPAL_DECLARED records only',
      )
    }
    if (
      validated.content.length === 0 ||
      validated.content.trim() !== validated.content ||
      validated.content.includes(ENTRY_DELIMITER)
    ) {
      return fail(
        'INVALID_PROVENANCE_STORE',
        'stored principal declaration content is not canonical USER.md content',
      )
    }
    if (ids.has(validated.provenanceId)) {
      return fail(
        'DUPLICATE_PROVENANCE',
        'the principal store contains a duplicate provenance identity',
      )
    }
    const priorType = content.get(validated.content)
    if (priorType !== undefined) {
      return fail(
        priorType === validated.declarationType
          ? 'AMBIGUOUS_PROVENANCE'
          : 'CONFLICTING_DECLARATION',
        'the principal store contains more than one record for exact content',
      )
    }
    ids.add(validated.provenanceId)
    content.set(validated.content, validated.declarationType)
    records.push(validated)
  }
  return Object.freeze(records)
}

/** Strict JSONL replay. A non-empty file must end at a newline commit point. */
export function loadPrincipalProvenanceCatalog(
  cfg: Config,
): readonly Readonly<PrincipalDeclaredProvenance>[] {
  const checked = verifyPrincipalStorePath(cfg, false)
  if (!checked.present) return Object.freeze([])
  const raw = fs.readFileSync(checked.file, 'utf8')
  if (raw === '') return Object.freeze([])
  if (!raw.endsWith('\n')) {
    return fail(
      'INVALID_PROVENANCE_STORE',
      'principal provenance JSONL ends with a partial line',
    )
  }
  const lines = raw.slice(0, -1).split('\n')
  const parsed: unknown[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') {
      return fail(
        'INVALID_PROVENANCE_STORE',
        `principal provenance JSONL has an empty line at ${index + 1}`,
      )
    }
    try {
      parsed.push(JSON.parse(line))
    } catch {
      return fail(
        'INVALID_PROVENANCE_STORE',
        `invalid principal provenance JSONL at line ${index + 1}`,
      )
    }
  }
  return validateCatalogCoherence(parsed)
}

function appendPrincipalProvenance(
  cfg: Config,
  value: unknown,
): StoreAppendResult {
  const catalog = loadPrincipalProvenanceCatalog(cfg)
  let provenance
  try {
    provenance = validatePrincipalProvenance(value)
  } catch {
    return fail(
      'INVALID_PROVENANCE_STORE',
      'candidate provenance failed the complete P3A validator',
    )
  }
  if (provenance.provenanceKind !== 'PRINCIPAL_DECLARED') {
    return fail(
      'PROVENANCE_KIND_REFUSED',
      'the principal store accepts PRINCIPAL_DECLARED records only',
    )
  }
  const sameContent = catalog.find((record) => record.content === provenance.content)
  if (sameContent !== undefined) {
    if (sameContent.declarationType !== provenance.declarationType) {
      return fail(
        'CONFLICTING_DECLARATION',
        'exact content is already declared with another declaration type',
      )
    }
    return deepFreeze({
      status: 'already_present' as const,
      provenance: sameContent,
    })
  }
  if (catalog.some((record) => record.provenanceId === provenance.provenanceId)) {
    return fail(
      'DUPLICATE_PROVENANCE',
      'candidate provenance identity already exists with different content',
    )
  }

  const checked = verifyPrincipalStorePath(cfg, true)
  // One synchronous append is the commit point. No retry and no multi-writer
  // safety are claimed by this single-process boundary.
  fs.appendFileSync(
    checked.file,
    `${serializePrincipalProvenance(provenance)}\n`,
    'utf8',
  )
  return deepFreeze({
    status: 'appended' as const,
    provenance,
  })
}

function readUserEntriesStrict(cfg: Config): string[] {
  const file = workspaceFilePath(cfg.paths.dataDir, 'user')
  const workspaceDir = path.dirname(file)
  const parentStat = lstatIfPresent(workspaceDir)
  if (parentStat === undefined) return []
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return fail(
      'INCOHERENT_USER_PROJECTION',
      'USER.md parent must be an owned directory, not a symlink',
    )
  }
  const fileStat = lstatIfPresent(file)
  if (fileStat === undefined) return []
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return fail(
      'INCOHERENT_USER_PROJECTION',
      'USER.md must be a regular file, not a symlink',
    )
  }
  return parseEntries(fs.readFileSync(file, 'utf8'))
}

export function loadCoherentPrincipalProvenanceCatalog(
  cfg: Config,
): readonly Readonly<PrincipalDeclaredProvenance>[] {
  return loadCoherentPrincipalLifecycleState(cfg).activeDeclarations
}

function validateDeclarationContent(content: unknown): asserts content is string {
  if (
    typeof content !== 'string' ||
    content.length === 0 ||
    content.trim() !== content ||
    content.includes(ENTRY_DELIMITER)
  ) {
    return fail(
      'INVALID_DECLARATION_CONTENT',
      'declaration content must be non-empty, canonical, and contain no § delimiter',
    )
  }
}

function joinedUserLength(entries: readonly string[], content: string): number {
  return [...entries, content].join(`\n${ENTRY_DELIMITER}\n`).length
}

function preflightUserEntryWithoutEviction(
  cfg: Config,
  content: string,
): { exists: boolean; entries: readonly string[] } {
  validateDeclarationContent(content)
  const entries = readUserEntriesStrict(cfg)
  if (entries.includes(content)) return { exists: true, entries }
  if (joinedUserLength(entries, content) > USER_CHAR_LIMIT) {
    return fail(
      'USER_CAPACITY_REFUSED',
      'principal admission cannot evict USER.md entries to make capacity',
    )
  }
  return { exists: false, entries }
}

function ensureUserEntryWithoutEviction(cfg: Config, content: string): boolean {
  const preview = preflightUserEntryWithoutEviction(cfg, content)
  if (preview.exists) return false
  let result: WorkspaceResult
  try {
    result = applyWorkspaceOp(cfg.paths.dataDir, 'user', {
      action: 'add',
      content,
    })
  } catch (error) {
    return fail(
      'USER_WRITE_FAILED',
      `USER.md write failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!result.ok || result.evicted !== undefined) {
    return fail(
      'USER_WRITE_FAILED',
      result.ok
        ? 'USER.md admission unexpectedly evicted an entry'
        : result.error,
    )
  }
  return true
}

export function preflightPrincipalAdmission(
  cfg: Config,
  declarationType: PrincipalDeclarationType,
  content: string,
): void {
  validateDeclarationContent(content)
  const catalog = loadCoherentPrincipalLifecycleState(cfg).declarations
  const existing = catalog.find((record) => record.content === content)
  if (existing !== undefined && existing.declarationType !== declarationType) {
    return fail(
      'CONFLICTING_DECLARATION',
      'exact content is already declared with another declaration type',
    )
  }
  preflightUserEntryWithoutEviction(cfg, content)
}

function validPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

/** Build P3A provenance only from the authenticated private Telegram ceremony. */
export function createTelegramPrincipalProvenance(
  input: TelegramPrincipalConfirmationContext | unknown,
  boundPrincipalReference = 'telegram-principal:system-owner',
): Readonly<PrincipalDeclaredProvenance> {
  if (
    typeof input !== 'object' || input === null || Array.isArray(input) ||
    (input as Record<string, unknown>).authorityGranted !== false
  ) {
    return fail(
      'INVALID_AUTHENTICATION_CONTEXT',
      'Telegram principal confirmation context is malformed',
    )
  }
  const value = input as Record<string, unknown>
  const expected = [
    'schemaVersion', 'chatId', 'chatType', 'principalUserId', 'commandMessageId',
    'commandUpdateId', 'confirmationMessageId', 'callbackQueryId',
    'declarationType', 'content', 'authorityGranted',
  ].sort()
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    value.schemaVersion !== PRINCIPAL_ADMISSION_SCHEMA_VERSION ||
    !validPositiveId(value.chatId) ||
    value.chatType !== 'private' ||
    !validPositiveId(value.principalUserId) ||
    value.chatId !== value.principalUserId ||
    !validPositiveId(value.commandMessageId) ||
    !Number.isSafeInteger(value.commandUpdateId) ||
    (value.commandUpdateId as number) < 0 ||
    !validPositiveId(value.confirmationMessageId) ||
    typeof value.callbackQueryId !== 'string' ||
    value.callbackQueryId.trim() === '' ||
    (value.declarationType !== 'INSTRUCTION' && value.declarationType !== 'PREFERENCE')
  ) {
    return fail(
      'INVALID_AUTHENTICATION_CONTEXT',
      'Telegram principal confirmation context is incomplete or inconsistent',
    )
  }
  validateDeclarationContent(value.content)
  const declarationType = value.declarationType
  const content = value.content
  const contentDigestSha256 = digestCanonicalJson({ declarationType, content })
  if (boundPrincipalReference.trim() === '') {
    return fail('INVALID_AUTHENTICATION_CONTEXT', 'principal reference is unavailable')
  }
  const principalReference = boundPrincipalReference
  const declarationId = `principal-declaration:${digestCanonicalJson({
    schemaVersion: PRINCIPAL_ADMISSION_SCHEMA_VERSION,
    principalReference,
    declarationType,
    contentDigestSha256,
  })}`
  const authenticationRecordId = `telegram-confirmation:${digestCanonicalJson({
    schemaVersion: PRINCIPAL_ADMISSION_SCHEMA_VERSION,
    boundary: 'PRIVATE_ADMIN_TWO_STEP_CONFIRMATION',
    principalReference,
    commandMessageId: value.commandMessageId,
    commandUpdateId: value.commandUpdateId,
    confirmationMessageId: value.confirmationMessageId,
    callbackQueryId: value.callbackQueryId,
  })}`

  return createPrincipalDeclaredProvenance({
    schemaVersion: 1,
    declarationReference: {
      schemaVersion: 1,
      source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_DECLARATION',
      declarationId,
      principalReference,
      authenticationRecordId,
      contentDigestSha256,
    },
    declarationRecord: {
      schemaVersion: 1,
      declarationId,
      declarationType,
      content,
      contentDigestSha256,
      authorityGranted: false,
    },
    authorityGranted: false,
  })
}

export function admitPrincipalDeclaration(
  cfg: Config,
  input: TelegramPrincipalConfirmationContext | unknown,
): PrincipalAdmissionResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(
      'INVALID_AUTHENTICATION_CONTEXT',
      'durable admission requires a complete Telegram confirmation context',
    )
  }
  const raw = input as Partial<TelegramPrincipalConfirmationContext>
  if (
    cfg.telegram.adminChatId === undefined ||
    cfg.telegram.principalUserId === undefined ||
    raw.chatType !== 'private' ||
    raw.chatId !== cfg.telegram.adminChatId ||
    raw.principalUserId !== cfg.telegram.principalUserId
  ) {
    return fail(
      'INVALID_AUTHENTICATION_CONTEXT',
      'durable admission requires the configured principal private-chat identity',
    )
  }
  const catalog = loadCoherentPrincipalLifecycleState(cfg).declarations
  const principalReferences = [...new Set(catalog.map((record) => record.declarationReference.principalReference))]
  if (principalReferences.length > 1) {
    return fail(
      'INVALID_AUTHENTICATION_CONTEXT',
      'durable admission cannot identify one existing installation principal reference',
    )
  }
  // Existing installations retain their already-persisted opaque reference;
  // fresh installations use the code-owned role identity. Neither path hashes
  // or persists Telegram chat/user coordinates.
  const candidate = createTelegramPrincipalProvenance(
    input,
    principalReferences[0] ?? 'telegram-principal:system-owner',
  )
  const existing = catalog.find((record) => record.content === candidate.content)
  if (existing !== undefined) {
    if (existing.declarationType !== candidate.declarationType) {
      return fail(
        'CONFLICTING_DECLARATION',
        'exact content is already declared with another declaration type',
      )
    }
    return deepFreeze({
      status: 'already_admitted' as const,
      provenance: existing,
      userEntryCreated: false,
      authorityGranted: false as const,
    })
  }

  const userEntryCreated = ensureUserEntryWithoutEviction(cfg, candidate.content)
  try {
    const committed = appendPrincipalProvenance(cfg, candidate)
    return deepFreeze({
      status: committed.status === 'appended'
        ? 'admitted' as const
        : 'already_admitted' as const,
      provenance: committed.provenance,
      userEntryCreated,
      authorityGranted: false as const,
    })
  } catch {
    return deepFreeze({
      status: 'partial_user_note_only' as const,
      userEntryCreated,
      warning:
        'USER.md contains the exact content, but durable principal provenance failed; it remains UNVERIFIED_WORKING_NOTE.',
      authorityGranted: false as const,
    })
  }
}

/** Apply the existing agent USER operation without weakening active declarations. */
export function applyUnverifiedUserWorkspaceOp(
  cfg: Config,
  op: WorkspaceOp,
): WorkspaceResult {
  let catalog: readonly Readonly<PrincipalDeclaredProvenance>[]
  let entries: readonly string[]
  try {
    catalog = loadCoherentPrincipalProvenanceCatalog(cfg)
    entries = readUserEntriesStrict(cfg)
  } catch (error) {
    return {
      ok: false,
      error:
        `USER.md mutation refused while principal provenance or lifecycle state is unavailable: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const protectedContent = new Set(catalog.map((record) => record.content))

  if (op.action === 'add-many') {
    // The carousel fix added a batch door for self/desk hot-cache restores.
    // USER.md keeps its per-entry admission law: every write faces the
    // declaration checks individually, so batches never touch this store.
    return {
      ok: false,
      error:
        'USER.md batch add refused: writes here are one verified entry at a time ' +
        '(active authenticated declarations cannot be batched or auto-evicted)',
    }
  }

  if (op.action === 'add') {
    const content = op.content.trim()
    if (protectedContent.has(content)) {
      return {
        ok: false,
        error: 'USER.md add refused: this exact active authenticated declaration already exists and cannot be written by an agent',
      }
    }
    if (
      catalog.length > 0 &&
      !entries.includes(content) &&
      joinedUserLength(entries, content) > USER_CHAR_LIMIT
    ) {
      return {
        ok: false,
        error: 'USER.md add refused: active authenticated declarations cannot be auto-evicted',
      }
    }
    return applyWorkspaceOp(cfg.paths.dataDir, 'user', op)
  }

  const find = op.find.trim()
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.includes(find))
  if (find !== '' && matches.length === 1 && protectedContent.has(matches[0]!.entry)) {
    return {
      ok: false,
      error: 'USER.md mutation refused: active authenticated principal declarations require a lifecycle action',
    }
  }
  if (op.action === 'replace' && matches.length === 1) {
    const replacement = op.content.trim()
    if (entries.some((entry, index) => index !== matches[0]!.index && entry === replacement)) {
      return {
        ok: false,
        error: 'USER.md replacement refused: it would create a duplicate entry',
      }
    }
  }
  return applyWorkspaceOp(cfg.paths.dataDir, 'user', op)
}

export function parseRememberCommand(
  text: string,
): { declarationType: PrincipalDeclarationType; content: string } | undefined {
  const match = /^\/remember (instruction|preference) ([\s\S]+)$/.exec(text)
  if (!match) return undefined
  const declarationType = match[1] === 'instruction'
    ? 'INSTRUCTION' as const
    : 'PREFERENCE' as const
  const content = match[2]!
  validateDeclarationContent(content)
  return { declarationType, content }
}

export type PrincipalAdmissionCommandInput = {
  chatId: number | undefined
  chatType: string | undefined
  fromUserId: number | undefined
  messageId: number | undefined
  updateId: number | undefined
  text: string | undefined
}

export type PrincipalAdmissionCallbackInput = {
  data: string
  chatId: number | undefined
  chatType: string | undefined
  fromUserId: number | undefined
  messageId: number | undefined
  callbackQueryId: string | undefined
  acknowledge: (text: string) => Promise<boolean>
}

type PendingDeclaration = {
  token: string
  declarationType: PrincipalDeclarationType
  content: string
  commitment: string
  chatId: number
  principalUserId: number
  commandMessageId: number
  commandUpdateId: number
  confirmationMessageId: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

export type PrincipalAdmissionController = {
  begin: (input: PrincipalAdmissionCommandInput) => Promise<'pending' | 'refused'>
  handleCallback: (input: PrincipalAdmissionCallbackInput) => Promise<'admitted' | 'cancelled' | 'refused'>
  pendingCount: () => number
  cancelAll: () => number
}

function confirmationCard(pending: Omit<PendingDeclaration, 'timer'>): string {
  return (
    `🧾 <b>Confirm durable principal provenance</b>\n\n` +
    `Type: <code>${pending.declarationType}</code>\n` +
    `Exact content:\n<pre>${escapeHtml(pending.content)}</pre>\n` +
    `Commitment: <code>${pending.commitment}</code>\n\n` +
    `Confirmation creates durable PRINCIPAL_DECLARED provenance. ` +
    `It grants no trade approval, execution, signing, wallet, tool, or safety-gate authority.`
  )
}

export function createPrincipalAdmissionController(
  cfg: Config,
  sender: TelegramSender,
  options: {
    timeoutMs?: number
    now?: () => number
    token?: () => string
  } = {},
): PrincipalAdmissionController {
  const timeoutMs = options.timeoutMs ?? cfg.limits.approvalTimeoutSec * 1000
  const now = options.now ?? Date.now
  const makeToken = options.token ?? (() => crypto.randomBytes(12).toString('hex'))
  const pending = new Map<string, PendingDeclaration>()

  async function refuseCommand(
    chatId: number | undefined,
    text: string,
  ): Promise<'refused'> {
    if (chatId !== undefined) await sender.send(chatId, escapeHtml(text))
    return 'refused'
  }

  async function acknowledge(
    input: PrincipalAdmissionCallbackInput,
    text: string,
  ): Promise<boolean> {
    try {
      return await input.acknowledge(text)
    } catch {
      return false
    }
  }

  const controller: PrincipalAdmissionController = {
    async begin(input) {
      const admin = cfg.telegram.adminChatId
      const principal = cfg.telegram.principalUserId
      if (admin === undefined || principal === undefined) {
        return refuseCommand(input.chatId, 'Principal admission is unavailable: TELEGRAM_ADMIN_CHAT_ID and TELEGRAM_PRINCIPAL_USER_ID must be configured.')
      }
      if (
        input.chatType !== 'private' ||
        input.chatId === undefined ||
        input.fromUserId === undefined ||
        input.chatId !== input.fromUserId ||
        input.chatId !== admin ||
        input.fromUserId !== principal ||
        !validPositiveId(input.messageId) ||
        !Number.isSafeInteger(input.updateId) ||
        (input.updateId as number) < 0
      ) {
        return refuseCommand(input.chatId, 'Principal admission requires the configured principal in their exact private Telegram chat.')
      }
      let parsed
      try {
        parsed = input.text === undefined ? undefined : parseRememberCommand(input.text)
        if (parsed === undefined) {
          return refuseCommand(
            input.chatId,
            'Usage: /remember instruction <content> or /remember preference <content>',
          )
        }
        preflightPrincipalAdmission(cfg, parsed.declarationType, parsed.content)
      } catch (error) {
        return refuseCommand(
          input.chatId,
          `Principal admission refused: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const token = makeToken()
      if (!/^[a-f0-9]{24}$/.test(token) || pending.has(token)) {
        return refuseCommand(input.chatId, 'Principal admission could not create a unique confirmation request.')
      }
      const commitment = digestCanonicalJson({
        declarationType: parsed.declarationType,
        content: parsed.content,
      })
      const beforeSend = {
        token,
        declarationType: parsed.declarationType,
        content: parsed.content,
        commitment,
        chatId: input.chatId,
        principalUserId: input.fromUserId,
        commandMessageId: input.messageId,
        commandUpdateId: input.updateId as number,
        confirmationMessageId: 0,
        expiresAt: now() + timeoutMs,
      }
      const messageId = await sender.sendWithKeyboard(
        input.chatId,
        confirmationCard(beforeSend),
        [[
          { text: '✅ Confirm declaration', callbackData: `${PRINCIPAL_CONFIRMATION_CALLBACK_PREFIX}${token}:y` },
          { text: '❌ Cancel', callbackData: `${PRINCIPAL_CONFIRMATION_CALLBACK_PREFIX}${token}:n` },
        ]],
      )
      if (!validPositiveId(messageId)) {
        return refuseCommand(input.chatId, 'Principal admission confirmation card could not be sent; nothing was persisted.')
      }
      const timer = setTimeout(() => {
        const current = pending.get(token)
        if (current === undefined) return
        pending.delete(token)
        void sender.editWithKeyboard(
          current.chatId,
          current.confirmationMessageId,
          `${confirmationCard(current)}\n\n⌛ Expired — nothing was persisted.`,
          [],
        )
      }, timeoutMs)
      timer.unref?.()
      pending.set(token, {
        ...beforeSend,
        confirmationMessageId: messageId,
        timer,
      })
      return 'pending'
    },

    async handleCallback(input) {
      const match = /^pdecl:([a-f0-9]{24}):(y|n)$/.exec(input.data)
      if (!match || input.callbackQueryId === undefined) {
        await acknowledge(input, 'malformed principal confirmation')
        return 'refused'
      }
      const token = match[1]!
      const decision = match[2]!
      const request = pending.get(token)
      if (request === undefined) {
        await acknowledge(input, 'expired, replayed, or unknown principal confirmation')
        return 'refused'
      }
      const admin = cfg.telegram.adminChatId
      const principal = cfg.telegram.principalUserId
      if (
        admin === undefined ||
        principal === undefined ||
        input.chatType !== 'private' ||
        input.chatId !== request.chatId ||
        input.fromUserId !== request.principalUserId ||
        input.chatId !== input.fromUserId ||
        input.fromUserId !== principal ||
        input.messageId !== request.confirmationMessageId
      ) {
        await acknowledge(input, 'not authorized for this principal confirmation')
        return 'refused'
      }
      if (now() >= request.expiresAt) {
        clearTimeout(request.timer)
        pending.delete(token)
        await acknowledge(input, 'principal confirmation expired')
        return 'refused'
      }
      // Consume exactly once before the first await. Concurrent duplicate
      // callbacks cannot both cross the durable boundary.
      clearTimeout(request.timer)
      pending.delete(token)
      if (decision === 'n') {
        const acknowledged = await acknowledge(input, 'principal declaration cancelled')
        if (!acknowledged) return 'refused'
        await sender.editWithKeyboard(
          request.chatId,
          request.confirmationMessageId,
          `${confirmationCard(request)}\n\n❌ Cancelled — nothing was persisted.`,
          [],
        )
        return 'cancelled'
      }

      // Telegram must acknowledge the exact callback before either durable
      // file can change. A callback transport failure therefore fails closed.
      const acknowledged = await acknowledge(input, 'confirming principal declaration')
      if (!acknowledged) return 'refused'

      try {
        const result = admitPrincipalDeclaration(cfg, {
          schemaVersion: PRINCIPAL_ADMISSION_SCHEMA_VERSION,
          chatId: request.chatId,
          chatType: 'private',
          principalUserId: request.principalUserId,
          commandMessageId: request.commandMessageId,
          commandUpdateId: request.commandUpdateId,
          confirmationMessageId: request.confirmationMessageId,
          callbackQueryId: input.callbackQueryId,
          declarationType: request.declarationType,
          content: request.content,
          authorityGranted: false,
        })
        const outcome = result.status === 'partial_user_note_only'
          ? `⚠️ ${escapeHtml(result.warning)}`
          : result.status === 'already_admitted'
            ? '✅ Already admitted; no duplicate provenance was appended.'
            : '✅ Durable principal provenance admitted. It becomes visible on the next run.'
        await sender.editWithKeyboard(
          request.chatId,
          request.confirmationMessageId,
          `${confirmationCard(request)}\n\n${outcome}`,
          [],
        )
        return result.status === 'partial_user_note_only' ? 'refused' : 'admitted'
      } catch {
        await sender.editWithKeyboard(
          request.chatId,
          request.confirmationMessageId,
          `${confirmationCard(request)}\n\n⛔ Admission refused; no provenance was committed.`,
          [],
        )
        return 'refused'
      }
    },

    pendingCount: () => pending.size,

    cancelAll() {
      const values = [...pending.values()]
      pending.clear()
      for (const request of values) clearTimeout(request.timer)
      return values.length
    },
  }
  return controller
}

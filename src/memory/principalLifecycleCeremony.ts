import crypto from 'node:crypto'
import type { Config } from '../config.js'
import type { TelegramSender } from '../types.js'
import { escapeHtml } from '../telegram/render.js'
import { digestCanonicalJson } from './developmentalMemory.js'
import {
  appendPrincipalLifecycleEvent,
  createPrincipalLifecycleEvent,
  loadCoherentPrincipalLifecycleState,
  type AuthenticatedPrincipalLifecycleReference,
  type PrincipalLifecycleKind,
} from './principalLifecycle.js'
import type { PrincipalDeclaredProvenance } from './principalProvenance.js'

export const PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX = 'plife:' as const
export const PRINCIPAL_LIFECYCLE_CEREMONY_SCHEMA_VERSION = 1 as const

type LifecycleAction = 'REVOKE' | 'SUPERSEDE'

export type PrincipalLifecycleCommandInput = {
  chatId: number | undefined
  chatType: string | undefined
  fromUserId: number | undefined
  messageId: number | undefined
  updateId: number | undefined
  text: string | undefined
  isForwarded: boolean | undefined
}

export type PrincipalLifecycleCallbackInput = {
  data: string
  chatId: number | undefined
  chatType: string | undefined
  fromUserId: number | undefined
  messageId: number | undefined
  updateId: number | undefined
  callbackQueryId: string | undefined
  acknowledge: (text: string) => Promise<boolean>
}

export interface TelegramPrincipalLifecycleReferenceInput {
  readonly schemaVersion: typeof PRINCIPAL_LIFECYCLE_CEREMONY_SCHEMA_VERSION
  readonly lifecycleKind: PrincipalLifecycleKind
  readonly principalReference: string
  readonly commandChatId: number
  readonly commandPrincipalUserId: number
  readonly commandMessageId: number
  readonly commandUpdateId: number
  readonly confirmationChatId: number
  readonly confirmationPrincipalUserId: number
  readonly confirmationMessageId: number
  readonly confirmationUpdateId: number
  readonly callbackQueryId: string
  readonly callbackData: string
  readonly targetProvenanceId: string
  readonly successorProvenanceId?: string
  readonly confirmationIntent: 'CONFIRM_PRINCIPAL_DECLARATION_LIFECYCLE'
  readonly authorityGranted: false
}

type DeclarationCommitment = Readonly<{
  provenanceId: string
  declarationId: string
  contentDigestSha256: string
  declarationType: PrincipalDeclaredProvenance['declarationType']
  content: string
  principalReference: string
}>

type PendingBase = {
  token: string
  action: LifecycleAction
  target: DeclarationCommitment
  lifecycleStateDigestSha256: string
  ceremonyCommitmentSha256: string
  chatId: number
  principalUserId: number
  commandMessageId: number
  commandUpdateId: number
  confirmationMessageId: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

type PendingSelection = PendingBase & {
  stage: 'SELECT_SUCCESSOR'
  action: 'SUPERSEDE'
  candidates: readonly DeclarationCommitment[]
}

type PendingConfirmation = PendingBase & {
  stage: 'CONFIRM'
  successor?: DeclarationCommitment
}

type PendingLifecycle = PendingSelection | PendingConfirmation

export type PrincipalLifecycleCeremonyController = {
  begin: (input: PrincipalLifecycleCommandInput) => Promise<'pending' | 'refused'>
  handleCallback: (
    input: PrincipalLifecycleCallbackInput,
  ) => Promise<'selected' | 'revoked' | 'superseded' | 'cancelled' | 'refused'>
  pendingCount: () => number
  cancelAll: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function validUpdateId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function declarationCommitment(
  declaration: Readonly<PrincipalDeclaredProvenance>,
): DeclarationCommitment {
  return deepFreeze({
    provenanceId: declaration.provenanceId,
    declarationId: declaration.declarationReference.declarationId,
    contentDigestSha256: declaration.contentDigestSha256,
    declarationType: declaration.declarationType,
    content: declaration.content,
    principalReference: declaration.declarationReference.principalReference,
  })
}

function sameDeclaration(
  declaration: Readonly<PrincipalDeclaredProvenance>,
  committed: DeclarationCommitment,
): boolean {
  return declaration.provenanceId === committed.provenanceId &&
    declaration.declarationReference.declarationId === committed.declarationId &&
    declaration.contentDigestSha256 === committed.contentDigestSha256 &&
    declaration.declarationType === committed.declarationType &&
    declaration.content === committed.content &&
    declaration.declarationReference.principalReference === committed.principalReference
}

export function isPrincipalLifecycleCommand(text: string | undefined): boolean {
  return typeof text === 'string' && /^\/remember (?:revoke|supersede)(?: |$)/.test(text)
}

export function parsePrincipalLifecycleCommand(
  text: string,
): Readonly<{ action: LifecycleAction; content: string }> | undefined {
  const match = /^\/remember (revoke|supersede) ([\s\S]+)$/.exec(text)
  if (!match) return undefined
  const content = match[2]!
  if (content.length === 0 || content.trim() !== content || content.includes('§')) return undefined
  return deepFreeze({
    action: match[1] === 'revoke' ? 'REVOKE' as const : 'SUPERSEDE' as const,
    content,
  })
}

/**
 * Pure deterministic privacy boundary. Raw Telegram ceremony identifiers are
 * committed into digests and are never returned in the durable reference.
 */
export function createTelegramPrincipalLifecycleReference(
  input: TelegramPrincipalLifecycleReferenceInput | unknown,
): Readonly<AuthenticatedPrincipalLifecycleReference> {
  if (!isRecord(input)) throw new Error('invalid principal lifecycle confirmation context')
  const commonKeys = [
    'schemaVersion', 'lifecycleKind', 'principalReference',
    'commandChatId', 'commandPrincipalUserId', 'commandMessageId', 'commandUpdateId',
    'confirmationChatId', 'confirmationPrincipalUserId', 'confirmationMessageId',
    'confirmationUpdateId', 'callbackQueryId', 'callbackData', 'targetProvenanceId',
    'confirmationIntent', 'authorityGranted',
  ]
  const keys = input.lifecycleKind === 'PRINCIPAL_DECLARATION_SUPERSEDED'
    ? [...commonKeys, 'successorProvenanceId']
    : commonKeys
  if (
    !exactKeys(input, keys) ||
    input.schemaVersion !== PRINCIPAL_LIFECYCLE_CEREMONY_SCHEMA_VERSION ||
    (input.lifecycleKind !== 'PRINCIPAL_DECLARATION_REVOKED' &&
      input.lifecycleKind !== 'PRINCIPAL_DECLARATION_SUPERSEDED') ||
    !validText(input.principalReference) ||
    !validPositiveId(input.commandChatId) ||
    input.commandPrincipalUserId !== input.commandChatId ||
    !validPositiveId(input.commandMessageId) ||
    !validUpdateId(input.commandUpdateId) ||
    input.confirmationChatId !== input.commandChatId ||
    input.confirmationPrincipalUserId !== input.commandPrincipalUserId ||
    !validPositiveId(input.confirmationMessageId) ||
    !validUpdateId(input.confirmationUpdateId) ||
    !validText(input.callbackQueryId) ||
    !validText(input.callbackData) ||
    !validText(input.targetProvenanceId) ||
    input.confirmationIntent !== 'CONFIRM_PRINCIPAL_DECLARATION_LIFECYCLE' ||
    input.authorityGranted !== false ||
    (input.lifecycleKind === 'PRINCIPAL_DECLARATION_SUPERSEDED'
      ? !validText(input.successorProvenanceId) || input.successorProvenanceId === input.targetProvenanceId
      : 'successorProvenanceId' in input)
  ) {
    throw new Error('invalid principal lifecycle confirmation context')
  }

  const commandIdentityCommitmentSha256 = digestCanonicalJson({
    principalReference: input.principalReference,
    transportPrincipal: 'telegram:system-owner',
    messageId: input.commandMessageId,
    updateId: input.commandUpdateId,
  })
  const finalCallbackIdentityCommitmentSha256 = digestCanonicalJson({
    principalReference: input.principalReference,
    transportPrincipal: 'telegram:system-owner',
    messageId: input.confirmationMessageId,
    updateId: input.confirmationUpdateId,
    callbackQueryId: input.callbackQueryId,
    callbackDataDigestSha256: digestCanonicalJson({ callbackData: input.callbackData }),
  })
  const committed = {
    schemaVersion: PRINCIPAL_LIFECYCLE_CEREMONY_SCHEMA_VERSION,
    source: 'TELEGRAM_PRIVATE_ADMIN_LIFECYCLE_CONFIRMATION',
    lifecycleKind: input.lifecycleKind,
    principalReference: input.principalReference,
    targetProvenanceId: input.targetProvenanceId,
    successorProvenanceId: input.lifecycleKind === 'PRINCIPAL_DECLARATION_SUPERSEDED'
      ? input.successorProvenanceId
      : null,
    commandIdentityCommitmentSha256,
    finalCallbackIdentityCommitmentSha256,
    confirmationIntent: input.confirmationIntent,
    authorityGranted: false as const,
  }
  const lifecycleReferenceId = `principal-lifecycle:${digestCanonicalJson(committed)}`
  return deepFreeze({
    schemaVersion: 1,
    source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE',
    lifecycleReferenceId,
    principalReference: input.principalReference,
    authenticationRecordId: `principal-lifecycle-auth:${digestCanonicalJson({
      lifecycleReferenceId,
      principalReference: input.principalReference,
      commandIdentityCommitmentSha256,
      finalCallbackIdentityCommitmentSha256,
      confirmationIntent: input.confirmationIntent,
      authorityGranted: false,
    })}`,
    authorityGranted: false,
  })
}

function targetCard(action: LifecycleAction, target: DeclarationCommitment, commitment: string): string {
  const consequence = action === 'REVOKE'
    ? 'This declaration will no longer project as active principal policy. USER.md text may remain as an unverified historical or working note.'
    : 'Select an already-admitted active successor. Selection is exact and does not admit or modify any declaration.'
  return (
    `🧭 <b>Principal declaration lifecycle</b>\n\n` +
    `Action: <code>${action}</code>\n` +
    `Type: <code>${target.declarationType}</code>\n` +
    `Exact content:\n<pre>${escapeHtml(target.content)}</pre>\n` +
    `Commitment: <code>${commitment}</code>\n\n` +
    `${consequence}\n` +
    `This grants no trade, execution, signing, wallet, tool, approval, or bypass authority.`
  )
}

function selectionCard(request: Omit<PendingSelection, 'timer'>): string {
  const candidates = request.candidates.map((candidate, index) =>
    `\n${index + 1}. <code>${candidate.declarationType}</code>\n<pre>${escapeHtml(candidate.content)}</pre>`,
  ).join('')
  return `${targetCard('SUPERSEDE', request.target, request.ceremonyCommitmentSha256)}\n\n<b>Eligible successors</b>${candidates}`
}

function confirmationCard(request: Omit<PendingConfirmation, 'timer'>): string {
  if (request.action === 'REVOKE') {
    return targetCard(request.action, request.target, request.ceremonyCommitmentSha256)
  }
  const successor = request.successor!
  return (
    `🧭 <b>Confirm principal declaration supersession</b>\n\n` +
    `<b>OLD</b> — <code>${request.target.declarationType}</code>\n` +
    `<pre>${escapeHtml(request.target.content)}</pre>\n` +
    `<b>NEW</b> — <code>${successor.declarationType}</code>\n` +
    `<pre>${escapeHtml(successor.content)}</pre>\n` +
    `Action: <code>SUPERSEDE</code>\n` +
    `Commitment: <code>${request.ceremonyCommitmentSha256}</code>\n\n` +
    `This changes memory projection only and grants no trade or execution authority.`
  )
}

function ceremonyCommitment(
  action: LifecycleAction,
  target: DeclarationCommitment,
  stateDigest: string,
  successor?: DeclarationCommitment,
): string {
  return digestCanonicalJson({
    action,
    target,
    successor: successor ?? null,
    lifecycleStateDigestSha256: stateDigest,
    confirmationIntent: 'CONFIRM_PRINCIPAL_DECLARATION_LIFECYCLE',
    authorityGranted: false,
  })
}

export function createPrincipalLifecycleCeremonyController(
  cfg: Config,
  sender: TelegramSender,
  options: {
    timeoutMs?: number
    now?: () => number
    token?: () => string
  } = {},
): PrincipalLifecycleCeremonyController {
  const timeoutMs = options.timeoutMs ?? cfg.limits.approvalTimeoutSec * 1000
  const now = options.now ?? Date.now
  const makeToken = options.token ?? (() => crypto.randomBytes(12).toString('hex'))
  const pending = new Map<string, PendingLifecycle>()

  async function refuse(chatId: number | undefined, text: string): Promise<'refused'> {
    if (chatId !== undefined) await sender.send(chatId, escapeHtml(text))
    return 'refused'
  }

  async function acknowledge(input: PrincipalLifecycleCallbackInput, text: string): Promise<boolean> {
    try {
      return await input.acknowledge(text)
    } catch {
      return false
    }
  }

  function validOrigin(input: PrincipalLifecycleCallbackInput, request: PendingLifecycle): boolean {
    const admin = cfg.telegram.adminChatId
    const principal = cfg.telegram.principalUserId
    return admin !== undefined && principal !== undefined &&
      input.chatType === 'private' &&
      input.chatId === request.chatId &&
      input.fromUserId === request.principalUserId &&
      input.chatId === input.fromUserId &&
      input.fromUserId === principal &&
      input.messageId === request.confirmationMessageId &&
      validUpdateId(input.updateId) &&
      validText(input.callbackQueryId)
  }

  function installPending<T extends Omit<PendingLifecycle, 'timer'>>(request: T): void {
    const timer = setTimeout(() => {
      const current = pending.get(request.token)
      if (current === undefined) return
      pending.delete(request.token)
      const card = current.stage === 'SELECT_SUCCESSOR'
        ? selectionCard(current)
        : confirmationCard(current)
      void sender.editWithKeyboard(
        current.chatId,
        current.confirmationMessageId,
        `${card}\n\n⌛ Expired — no lifecycle event was appended.`,
        [],
      )
    }, Math.max(0, request.expiresAt - now()))
    timer.unref?.()
    pending.set(request.token, { ...request, timer } as PendingLifecycle)
  }

  function freshDeclaration(
    request: PendingLifecycle,
    committed: DeclarationCommitment,
  ): Readonly<PrincipalDeclaredProvenance> {
    const state = loadCoherentPrincipalLifecycleState(cfg)
    if (state.lifecycleStateDigestSha256 !== request.lifecycleStateDigestSha256) {
      throw new Error('principal lifecycle state changed; start a fresh command')
    }
    const matches = state.activeDeclarations.filter((item) => item.provenanceId === committed.provenanceId)
    if (matches.length !== 1 || !sameDeclaration(matches[0]!, committed)) {
      throw new Error('the exact declaration is no longer active or unchanged')
    }
    return matches[0]!
  }

  const controller: PrincipalLifecycleCeremonyController = {
    async begin(input) {
      const admin = cfg.telegram.adminChatId
      const principal = cfg.telegram.principalUserId
      if (admin === undefined || principal === undefined) {
        return refuse(input.chatId, 'Principal lifecycle is unavailable: TELEGRAM_ADMIN_CHAT_ID and TELEGRAM_PRINCIPAL_USER_ID must be configured.')
      }
      if (
        input.chatType !== 'private' ||
        input.chatId === undefined ||
        input.fromUserId === undefined ||
        input.chatId !== input.fromUserId ||
        input.chatId !== admin ||
        input.fromUserId !== principal ||
        input.isForwarded !== false ||
        !validPositiveId(input.messageId) ||
        !validUpdateId(input.updateId)
      ) {
        return refuse(input.chatId, 'Principal lifecycle requires the configured principal in their exact private Telegram chat.')
      }
      const parsed = input.text === undefined ? undefined : parsePrincipalLifecycleCommand(input.text)
      if (parsed === undefined) {
        return refuse(input.chatId, 'Usage: /remember revoke <exact active content> or /remember supersede <exact active content>')
      }

      let state
      try {
        state = loadCoherentPrincipalLifecycleState(cfg)
      } catch (error) {
        return refuse(input.chatId, `Principal lifecycle refused: ${error instanceof Error ? error.message : String(error)}`)
      }
      const exact = state.activeDeclarations.filter((record) => record.content === parsed.content)
      if (exact.length !== 1) {
        return refuse(input.chatId, 'Principal lifecycle refused: exact content must match exactly one currently ACTIVE declaration.')
      }
      const target = declarationCommitment(exact[0]!)
      const action = parsed.action
      const candidates = action === 'SUPERSEDE'
        ? state.activeDeclarations
          .filter((record) =>
            record.provenanceId !== target.provenanceId &&
            record.declarationReference.principalReference === target.principalReference,
          )
          .map(declarationCommitment)
        : []
      if (action === 'SUPERSEDE' && candidates.length === 0) {
        return refuse(
          input.chatId,
          'No eligible active successor exists. First admit the new declaration with /remember instruction <content> or /remember preference <content>; after that confirmation succeeds, run /remember supersede <old exact content> again.',
        )
      }
      const token = makeToken()
      if (!/^[a-f0-9]{24}$/.test(token) || pending.has(token)) {
        return refuse(input.chatId, 'Principal lifecycle could not create a unique confirmation request.')
      }
      const base = {
        token,
        action,
        target,
        lifecycleStateDigestSha256: state.lifecycleStateDigestSha256,
        ceremonyCommitmentSha256: ceremonyCommitment(action, target, state.lifecycleStateDigestSha256),
        chatId: input.chatId,
        principalUserId: input.fromUserId,
        commandMessageId: input.messageId,
        commandUpdateId: input.updateId,
        confirmationMessageId: 0,
        expiresAt: now() + timeoutMs,
      }
      const selection = action === 'SUPERSEDE'
        ? { ...base, stage: 'SELECT_SUCCESSOR' as const, action, candidates: deepFreeze(candidates) }
        : undefined
      const confirmation = action === 'REVOKE'
        ? { ...base, stage: 'CONFIRM' as const, action }
        : undefined
      const card = selection === undefined ? confirmationCard(confirmation!) : selectionCard(selection)
      const keyboard = selection === undefined
        ? [[
            { text: '✅ Confirm revoke', callbackData: `${PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX}${token}:y` },
            { text: '❌ Cancel', callbackData: `${PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX}${token}:n` },
          ]]
        : [
            ...candidates.map((_candidate, index) => [{
              text: `Select ${index + 1}`,
              callbackData: `${PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX}${token}:s:${index.toString(16)}`,
            }]),
            [{ text: '❌ Cancel', callbackData: `${PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX}${token}:n` }],
          ]
      const messageId = await sender.sendWithKeyboard(input.chatId, card, keyboard)
      if (!validPositiveId(messageId)) {
        return refuse(input.chatId, 'Principal lifecycle card could not be sent; no lifecycle event was appended.')
      }
      installPending({ ...(selection ?? confirmation!), confirmationMessageId: messageId })
      return 'pending'
    },

    async handleCallback(input) {
      const selectMatch = /^plife:([a-f0-9]{24}):s:([a-f0-9]{1,4})$/.exec(input.data)
      const decisionMatch = /^plife:([a-f0-9]{24}):(y|n)$/.exec(input.data)
      const token = selectMatch?.[1] ?? decisionMatch?.[1]
      if (token === undefined) {
        await acknowledge(input, 'malformed principal lifecycle confirmation')
        return 'refused'
      }
      const request = pending.get(token)
      if (request === undefined) {
        await acknowledge(input, 'expired, replayed, or unknown principal lifecycle confirmation')
        return 'refused'
      }
      if (!validOrigin(input, request)) {
        await acknowledge(input, 'not authorized for this principal lifecycle confirmation')
        return 'refused'
      }
      if (now() >= request.expiresAt) {
        clearTimeout(request.timer)
        pending.delete(token)
        await acknowledge(input, 'principal lifecycle confirmation expired')
        return 'refused'
      }

      const decision = decisionMatch?.[2]
      if (decision === 'n') {
        clearTimeout(request.timer)
        pending.delete(token)
        await acknowledge(input, 'principal lifecycle action cancelled')
        try {
          const card = request.stage === 'SELECT_SUCCESSOR'
            ? selectionCard(request)
            : confirmationCard(request)
          await sender.editWithKeyboard(
            request.chatId,
            request.confirmationMessageId,
            `${card}\n\n❌ Cancelled — no lifecycle event was appended.`,
            [],
          )
        } catch {
          // Cancellation is already complete in ephemeral state.
        }
        return 'cancelled'
      }

      if (selectMatch !== null) {
        if (request.stage !== 'SELECT_SUCCESSOR') {
          await acknowledge(input, 'wrong principal lifecycle confirmation stage')
          return 'refused'
        }
        const index = Number.parseInt(selectMatch[2]!, 16)
        const successor = request.candidates[index]
        if (successor === undefined) {
          await acknowledge(input, 'unknown principal lifecycle successor selection')
          return 'refused'
        }
        // Consume the selection token before the first await. Its exact
        // successor identity—not display text—is carried into a new token.
        clearTimeout(request.timer)
        pending.delete(token)
        let confirmation: Omit<PendingConfirmation, 'timer'>
        try {
          freshDeclaration(request, request.target)
          freshDeclaration(request, successor)
          const nextToken = makeToken()
          if (!/^[a-f0-9]{24}$/.test(nextToken) || pending.has(nextToken)) {
            throw new Error('could not create a unique final confirmation')
          }
          const {
            timer: _timer,
            candidates: _candidates,
            ...confirmationBase
          } = request
          confirmation = {
            ...confirmationBase,
            token: nextToken,
            stage: 'CONFIRM',
            successor,
            ceremonyCommitmentSha256: ceremonyCommitment(
              'SUPERSEDE',
              request.target,
              request.lifecycleStateDigestSha256,
              successor,
            ),
          }
        } catch (error) {
          await acknowledge(input, 'principal lifecycle state changed; start a fresh command')
          await sender.send(request.chatId, escapeHtml(
            `Supersession selection refused: ${error instanceof Error ? error.message : String(error)}`,
          ))
          return 'refused'
        }
        const acknowledged = await acknowledge(input, 'successor selected; confirm supersession')
        if (!acknowledged) return 'refused'
        try {
          await sender.editWithKeyboard(
            request.chatId,
            request.confirmationMessageId,
            confirmationCard(confirmation),
            [[
              { text: '✅ Confirm supersession', callbackData: `${PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX}${confirmation.token}:y` },
              { text: '❌ Cancel', callbackData: `${PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX}${confirmation.token}:n` },
            ]],
          )
        } catch {
          return 'refused'
        }
        installPending(confirmation)
        return 'selected'
      }

      if (decision !== 'y' || request.stage !== 'CONFIRM') {
        await acknowledge(input, 'wrong principal lifecycle confirmation stage')
        return 'refused'
      }

      // Consume exactly once before fresh reads, append, or the first await.
      // A duplicate callback cannot cross the durable boundary.
      clearTimeout(request.timer)
      pending.delete(token)
      let outcome: 'revoked' | 'superseded'
      try {
        const target = freshDeclaration(request, request.target)
        const successor = request.successor === undefined
          ? undefined
          : freshDeclaration(request, request.successor)
        if (request.action === 'SUPERSEDE' && successor === undefined) {
          throw new Error('supersession confirmation has no exact successor')
        }
        const lifecycleKind = request.action === 'REVOKE'
          ? 'PRINCIPAL_DECLARATION_REVOKED' as const
          : 'PRINCIPAL_DECLARATION_SUPERSEDED' as const
        const authenticatedLifecycleReference = createTelegramPrincipalLifecycleReference({
          schemaVersion: 1,
          lifecycleKind,
          principalReference: target.declarationReference.principalReference,
          commandChatId: request.chatId,
          commandPrincipalUserId: request.principalUserId,
          commandMessageId: request.commandMessageId,
          commandUpdateId: request.commandUpdateId,
          confirmationChatId: input.chatId!,
          confirmationPrincipalUserId: input.fromUserId!,
          confirmationMessageId: input.messageId!,
          confirmationUpdateId: input.updateId!,
          callbackQueryId: input.callbackQueryId!,
          callbackData: input.data,
          targetProvenanceId: target.provenanceId,
          ...(successor === undefined ? {} : { successorProvenanceId: successor.provenanceId }),
          confirmationIntent: 'CONFIRM_PRINCIPAL_DECLARATION_LIFECYCLE',
          authorityGranted: false,
        })
        const event = createPrincipalLifecycleEvent({
          schemaVersion: 1,
          lifecycleKind,
          targetProvenanceId: target.provenanceId,
          targetDeclarationId: target.declarationReference.declarationId,
          targetContentDigestSha256: target.contentDigestSha256,
          targetDeclarationType: target.declarationType,
          principalReference: target.declarationReference.principalReference,
          authenticatedLifecycleReference,
          ...(successor === undefined ? {} : {
            successorProvenanceId: successor.provenanceId,
            successorDeclarationId: successor.declarationReference.declarationId,
            successorContentDigestSha256: successor.contentDigestSha256,
            successorDeclarationType: successor.declarationType,
          }),
          authorityGranted: false,
        })
        appendPrincipalLifecycleEvent(cfg, event)
        outcome = request.action === 'REVOKE' ? 'revoked' : 'superseded'
      } catch (error) {
        await acknowledge(input, 'principal lifecycle mutation refused')
        try {
          await sender.editWithKeyboard(
            request.chatId,
            request.confirmationMessageId,
            `${confirmationCard(request)}\n\n⛔ Lifecycle mutation refused; no lifecycle event was appended. Start a fresh command.`,
            [],
          )
        } catch {
          // Durable failure remains a failure even if Telegram cannot render it.
        }
        void error
        return 'refused'
      }

      // The lifecycle record is already the durable receipt. Telegram failure
      // here cannot recreate pending state or cause a second append.
      await acknowledge(input, `principal declaration ${outcome}`)
      try {
        await sender.editWithKeyboard(
          request.chatId,
          request.confirmationMessageId,
          `${confirmationCard(request)}\n\n✅ Lifecycle event appended. Memory projection changes on the next run.`,
          [],
        )
      } catch {
        // Do not downgrade or retry a successfully committed lifecycle event.
      }
      return outcome
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

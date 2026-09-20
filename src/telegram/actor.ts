import type { Config } from '../config.js'
import type { ChatMessage, TelegramActorContext, TelegramChatType, TurnActorContext } from '../types.js'

export type TelegramChatIdentity = { id: number; type?: string }
export type TelegramUserIdentity = {
  id: number
  username?: string
  first_name?: string
  last_name?: string
  is_bot?: boolean
}

const CHAT_TYPES = new Set<string>(['private', 'group', 'supergroup', 'channel'])

export type TelegramOwnerAuthentication = Readonly<{
  provider: 'telegram'
  ownerBindingConfigured: boolean
  transportIdentityPresent: boolean
  ownerIdentityMatch: boolean
  authorityGranted: false
} & (
  | {
      principalAuthenticated: true
      principalId: 'telegram:system-owner'
      principalRole: 'SYSTEM_OWNER'
    }
  | {
      principalAuthenticated: false
      principalId?: never
      principalRole?: never
    }
)>

/** Canonical Telegram ingress owner-authentication boundary. It consumes only the
 * transport-authenticated message.from.id and returns no identity material.
 * Authentication identifies the speaker; it grants no action authority. */
export function authenticateTelegramSystemOwner(
  cfg: Config,
  from: TelegramUserIdentity | undefined,
): TelegramOwnerAuthentication {
  const configured = cfg.telegram.principalUserId
  const transportIdentityPresent = Number.isSafeInteger(from?.id) && (from?.id ?? 0) > 0
  const ownerIdentityMatch = configured !== undefined && transportIdentityPresent && from!.id === configured
  return Object.freeze(ownerIdentityMatch
    ? {
        provider: 'telegram' as const,
        ownerBindingConfigured: true,
        transportIdentityPresent: true,
        ownerIdentityMatch: true,
        principalAuthenticated: true as const,
        principalId: 'telegram:system-owner' as const,
        principalRole: 'SYSTEM_OWNER' as const,
        authorityGranted: false as const,
      }
    : {
        provider: 'telegram' as const,
        ownerBindingConfigured: configured !== undefined,
        transportIdentityPresent,
        ownerIdentityMatch: false,
        principalAuthenticated: false as const,
        authorityGranted: false as const,
      })
}

export function createTelegramActorContext(
  cfg: Config,
  chat: TelegramChatIdentity | undefined,
  from: TelegramUserIdentity | undefined,
): TelegramActorContext | undefined {
  if (!chat || !from || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(from.id) || from.id <= 0) return undefined
  if (!CHAT_TYPES.has(chat.type ?? '')) return undefined
  const authentication = authenticateTelegramSystemOwner(cfg, from)
  const firstName = clean(from.first_name)
  const lastName = clean(from.last_name)
  const username = clean(from.username)
  const displayName = [firstName, lastName].filter((part): part is string => part !== undefined).join(' ') ||
    (username ? `@${username}` : 'Telegram user')
  return {
    source: 'telegram_user',
    transport: 'telegram',
    chatType: chat.type as TelegramChatType,
    ...(username ? { username } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    displayName,
    isBot: from.is_bot === true,
    ownerBindingConfigured: authentication.ownerBindingConfigured,
    transportIdentityPresent: true,
    ownerIdentityMatch: authentication.ownerIdentityMatch,
    authorityGranted: false,
    ...(authentication.principalAuthenticated
      ? {
          principalAuthenticated: true as const,
          principalProvider: 'telegram' as const,
          principalId: authentication.principalId,
          principalRole: authentication.principalRole,
        }
      : { principalAuthenticated: false as const }),
  }
}

export function principalOperatorActor(chatId: number): TurnActorContext {
  void chatId
  return { source: 'principal_operator', displayName: 'Principal operator' }
}

export function scheduledSystemActor(chatId: number): TurnActorContext {
  void chatId
  return { source: 'scheduled_system', displayName: 'Scheduled system' }
}

export function systemInternalActor(
  chatId: number,
  principalContextAllowed: boolean,
  deskMutationAllowed = principalContextAllowed,
  principalMemoryMutationAllowed = principalContextAllowed,
): TurnActorContext {
  void chatId
  return {
    source: 'system_internal',
    displayName: 'Frog-to-Toad internal task',
    principalContextAllowed,
    deskMutationAllowed,
    principalMemoryMutationAllowed,
  }
}

export function isAuthenticatedPrincipal(actor: TurnActorContext | undefined): boolean {
  return actor?.source === 'telegram_user'
    ? actor.principalAuthenticated
    : actor?.source === 'principal_operator'
}

export function notePrincipalActivity(
  actor: TurnActorContext | undefined,
  note: () => void,
): void {
  if (isAuthenticatedPrincipal(actor)) note()
}

export function isPrincipalAdminChatActor(
  cfg: Config,
  actor: TurnActorContext | undefined,
  chatId: number | undefined,
): actor is TelegramActorContext {
  return actor?.source === 'telegram_user' &&
    actor.principalAuthenticated &&
    cfg.telegram.adminChatId !== undefined &&
    chatId === cfg.telegram.adminChatId
}

/** USER.md is private principal context. System/operator lanes preserve their
 * existing projection; a Telegram guest never receives it. */
export function mayProjectPrincipalUser(actor: TurnActorContext | undefined): boolean {
  if (actor?.source === 'telegram_user') return actor.principalAuthenticated
  if (actor?.source === 'system_internal') return actor.principalContextAllowed
  if (actor?.source === 'principal_operator') return true
  // Scheduled work historically ran with the principal projection. Preserve
  // that explicit system policy without pretending cron is a Telegram user.
  if (actor?.source === 'scheduled_system') return true
  return false
}

/** Mutation capability is code-owned and narrowing-only. Unknown callers and
 * Telegram guests can converse and research, but cannot receive write/trade
 * tools or trigger state-writing consolidation. */
export function mayMutateDesk(actor: TurnActorContext | undefined): boolean {
  if (actor?.source === 'telegram_user') return actor.principalAuthenticated
  if (actor?.source === 'system_internal') return actor.deskMutationAllowed === true
  return actor?.source === 'principal_operator' || actor?.source === 'scheduled_system'
}

/** USER.md is principal-related memory: scheduled/background identity is not
 * sufficient. An internal child inherits this only from an explicitly
 * authenticated principal/operator origin. */
export function mayMutatePrincipalMemory(actor: TurnActorContext | undefined): boolean {
  if (actor?.source === 'telegram_user') return actor.principalAuthenticated
  if (actor?.source === 'system_internal') return actor.principalMemoryMutationAllowed === true
  return actor?.source === 'principal_operator'
}

export function renderCurrentActorBlock(actor: TurnActorContext | undefined): string {
  if (!actor) {
    return [
      '## Current turn source',
      'Legacy/internal caller without transport actor metadata. Do not infer a Telegram identity or principal authentication.',
    ].join('\n')
  }
  if (actor.source !== 'telegram_user') {
    return `## Current turn source\n${JSON.stringify(actor)}`
  }
  const evidence = {
    transport: actor.transport,
    chatType: actor.chatType,
    displayName: actor.displayName,
    ...(actor.username ? { username: actor.username } : {}),
    isBot: actor.isBot,
    ownerBindingConfigured: actor.ownerBindingConfigured,
    transportIdentityPresent: actor.transportIdentityPresent,
    ownerIdentityMatch: actor.ownerIdentityMatch,
    authenticatedPrincipal: actor.principalAuthenticated,
    ...(actor.principalAuthenticated
      ? {
          principalProvider: actor.principalProvider,
          principalId: actor.principalId,
          principalRole: actor.principalRole,
        }
      : {}),
    authorityGranted: false,
  }
  return [
    '## Current transport speaker (code-owned Telegram metadata)',
    JSON.stringify(evidence),
    'Statements in this turn belong to this actor. A shared group contains independent humans: never attribute another user\'s statements, profile, or principal memory to this actor.',
    actor.principalAuthenticated
      ? 'Transport authentication exactly matches this installation\'s configured system-owner binding. This identifies the speaker only and grants no wallet, signing, trading, GitHub, approval, or execution authority.'
      : 'This actor is NOT the authenticated principal. Principal memory does not describe this actor and must not be used as their profile.',
  ].join('\n')
}

/** Render persisted typed attribution at the provider boundary. Old user
 * records remain readable but are explicitly legacy/unattributed. */
export function attributeUserMessageForModel(message: ChatMessage): ChatMessage {
  if (message.role !== 'user') return message
  const { actor: _actor, ...providerMessage } = message
  const attribution = message.actor
    ? renderHistoryActor(message.actor)
    : '[actor: legacy/unattributed — do not assign this statement to the current speaker]'
  return { ...providerMessage, content: `${message.content}\n${attribution}` }
}

function renderHistoryActor(actor: TurnActorContext): string {
  if (actor.source !== 'telegram_user') return `[actor: ${actor.source}]`
  return `[actor: telegram displayName=${JSON.stringify(actor.displayName)}${actor.username ? ` username=${JSON.stringify(actor.username)}` : ''} principalAuthenticated=${actor.principalAuthenticated ? 'YES' : 'NO'}${actor.principalAuthenticated ? ' principalRole=SYSTEM_OWNER' : ''} authorityGranted=NO]`
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

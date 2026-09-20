import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt } from '../src/agents/prompts.js'
import { loadConfig, type Config } from '../src/config.js'
import {
  admitPrincipalDeclaration,
  principalProvenanceStorePath,
} from '../src/memory/principalAdmission.js'
import { digestCanonicalJson } from '../src/memory/developmentalMemory.js'
import {
  appendPrincipalLifecycleEvent,
  createPrincipalLifecycleEvent,
  loadCoherentPrincipalLifecycleState,
  loadPrincipalLifecycleCatalog,
  principalLifecycleStorePath,
  type PrincipalLifecycleKind,
} from '../src/memory/principalLifecycle.js'
import {
  createPrincipalLifecycleCeremonyController,
  createTelegramPrincipalLifecycleReference,
  isPrincipalLifecycleCommand,
  parsePrincipalLifecycleCommand,
  PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX,
  type PrincipalLifecycleCallbackInput,
  type PrincipalLifecycleCeremonyController,
} from '../src/memory/principalLifecycleCeremony.js'
import {
  createPrincipalDeclaredProvenance,
  serializePrincipalProvenance,
  type PrincipalDeclaredProvenance,
  type PrincipalDeclarationType,
} from '../src/memory/principalProvenance.js'
import { createApprovalGate } from '../src/safety/approvals.js'
import { applyWorkspaceOp, readWorkspace } from '../src/store/workspace.js'
import { createNullSender } from '../src/telegram/bot.js'
import { memorySaveTool } from '../src/tools/memory.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { principalOperatorActor } from '../src/telegram/actor.js'

let root: string
let cfg: Config
let controllers: PrincipalLifecycleCeremonyController[]

const ADMIN = 987_654_321
const TOKEN_A = 'a'.repeat(24)
const TOKEN_B = 'b'.repeat(24)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-principal-lifecycle-ceremony-'))
  process.env['TRADING_DESK_DIR'] = root
  process.env['SELFTEST'] = '1'
  const loaded = loadConfig()
  cfg = {
    ...loaded,
    telegram: { ...loaded.telegram, adminChatId: ADMIN, principalUserId: ADMIN, allowedChatIds: [ADMIN, 222] },
  }
  controllers = []
})

afterEach(() => {
  for (const controller of controllers) controller.cancelAll()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function admit(
  content: string,
  declarationType: PrincipalDeclarationType = 'INSTRUCTION',
  suffix = content,
): Readonly<PrincipalDeclaredProvenance> {
  const numericSuffix = Math.abs([...suffix].reduce((sum, char) => sum + char.charCodeAt(0), 0)) + 1
  const result = admitPrincipalDeclaration(cfg, {
    schemaVersion: 1,
    chatId: ADMIN,
    chatType: 'private',
    principalUserId: ADMIN,
    commandMessageId: numericSuffix,
    commandUpdateId: numericSuffix + 1,
    confirmationMessageId: numericSuffix + 2,
    callbackQueryId: `admission-${digestCanonicalJson({ suffix })}`,
    declarationType,
    content,
    authorityGranted: false,
  })
  if (result.status === 'partial_user_note_only') throw new Error(result.warning)
  return result.provenance
}

function command(text: string, overrides: Record<string, unknown> = {}) {
  return {
    chatId: ADMIN,
    chatType: 'private',
    fromUserId: ADMIN,
    messageId: 10,
    updateId: 20,
    text,
    isForwarded: false,
    ...overrides,
  }
}

function callback(
  data: string,
  overrides: Partial<PrincipalLifecycleCallbackInput> = {},
): PrincipalLifecycleCallbackInput {
  return {
    data,
    chatId: ADMIN,
    chatType: 'private',
    fromUserId: ADMIN,
    messageId: 1,
    updateId: 40,
    callbackQueryId: 'lifecycle-callback-40',
    acknowledge: async () => true,
    ...overrides,
  }
}

function ceremony(tokens: string[] = [TOKEN_A, TOKEN_B], now: () => number = () => 1_000) {
  const sender = createNullSender()
  let index = 0
  const controller = createPrincipalLifecycleCeremonyController(cfg, sender, {
    timeoutMs: 60_000,
    now,
    token: () => tokens[index++] ?? 'c'.repeat(24),
  })
  controllers.push(controller)
  return { controller, sender }
}

function directReference(principalReference: string, suffix: string) {
  return {
    schemaVersion: 1 as const,
    source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE' as const,
    lifecycleReferenceId: `principal-lifecycle:${digestCanonicalJson({ suffix, kind: 'reference' })}`,
    principalReference,
    authenticationRecordId: `principal-lifecycle-auth:${digestCanonicalJson({ suffix, kind: 'authentication' })}`,
    authorityGranted: false as const,
  }
}

function directRevoke(target: Readonly<PrincipalDeclaredProvenance>, suffix = target.provenanceId) {
  return appendPrincipalLifecycleEvent(cfg, createPrincipalLifecycleEvent({
    schemaVersion: 1,
    lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED',
    targetProvenanceId: target.provenanceId,
    targetDeclarationId: target.declarationReference.declarationId,
    targetContentDigestSha256: target.contentDigestSha256,
    targetDeclarationType: target.declarationType,
    principalReference: target.declarationReference.principalReference,
    authenticatedLifecycleReference: directReference(target.declarationReference.principalReference, suffix),
    authorityGranted: false,
  }))
}

function directSupersede(
  target: Readonly<PrincipalDeclaredProvenance>,
  successor: Readonly<PrincipalDeclaredProvenance>,
  suffix = target.provenanceId,
) {
  return appendPrincipalLifecycleEvent(cfg, createPrincipalLifecycleEvent({
    schemaVersion: 1,
    lifecycleKind: 'PRINCIPAL_DECLARATION_SUPERSEDED',
    targetProvenanceId: target.provenanceId,
    targetDeclarationId: target.declarationReference.declarationId,
    targetContentDigestSha256: target.contentDigestSha256,
    targetDeclarationType: target.declarationType,
    principalReference: target.declarationReference.principalReference,
    authenticatedLifecycleReference: directReference(target.declarationReference.principalReference, suffix),
    successorProvenanceId: successor.provenanceId,
    successorDeclarationId: successor.declarationReference.declarationId,
    successorContentDigestSha256: successor.contentDigestSha256,
    successorDeclarationType: successor.declarationType,
    authorityGranted: false,
  }))
}

function storedPrincipal(
  content: string,
  principalReference: string,
  suffix: string,
): Readonly<PrincipalDeclaredProvenance> {
  const declarationType = 'INSTRUCTION' as const
  const contentDigestSha256 = digestCanonicalJson({ declarationType, content })
  return createPrincipalDeclaredProvenance({
    schemaVersion: 1,
    declarationReference: {
      schemaVersion: 1,
      source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_DECLARATION',
      declarationId: `declaration-${suffix}`,
      principalReference,
      authenticationRecordId: `authentication-${suffix}`,
      contentDigestSha256,
    },
    declarationRecord: {
      schemaVersion: 1,
      declarationId: `declaration-${suffix}`,
      declarationType,
      content,
      contentDigestSha256,
      authorityGranted: false,
    },
    authorityGranted: false,
  })
}

describe('P3C2 exact authentication, grammar, and namespace', () => {
  it('refuses missing admin configuration', async () => {
    const sender = createNullSender()
    const controller = createPrincipalLifecycleCeremonyController(
      { ...cfg, telegram: { ...cfg.telegram, adminChatId: undefined } },
      sender,
    )
    controllers.push(controller)
    expect(await controller.begin(command('/remember revoke Exact.'))).toBe('refused')
    expect(sender.messages[0]?.text).toContain('TELEGRAM_ADMIN_CHAT_ID')
  })

  it.each([
    ['group', { chatType: 'group' }],
    ['channel', { chatType: 'channel' }],
    ['non-admin', { chatId: 222, fromUserId: 222 }],
    ['sender/chat mismatch', { fromUserId: 222 }],
    ['missing sender', { fromUserId: undefined }],
    ['missing command message', { messageId: undefined }],
    ['missing command update', { updateId: undefined }],
    ['forwarded command', { isForwarded: true }],
  ])('refuses %s lifecycle initiation', async (_name, overrides) => {
    const { controller } = ceremony()
    expect(await controller.begin(command('/remember revoke Exact.', overrides))).toBe('refused')
    expect(controller.pendingCount()).toBe(0)
  })

  it('uses exact command grammar and an isolated plife namespace', () => {
    expect(parsePrincipalLifecycleCommand('/remember revoke Exact.')).toEqual({ action: 'REVOKE', content: 'Exact.' })
    expect(parsePrincipalLifecycleCommand('/remember supersede Exact.')).toEqual({ action: 'SUPERSEDE', content: 'Exact.' })
    expect(parsePrincipalLifecycleCommand('/remember revoke  leading')).toBeUndefined()
    expect(parsePrincipalLifecycleCommand('/remember revoke fuzzy § match')).toBeUndefined()
    expect(isPrincipalLifecycleCommand('/remember revoke')).toBe(true)
    expect(PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX).toBe('plife:')
    expect(PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX).not.toBe('pdecl:')
    expect(PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX).not.toBe('apr:')
  })

  it('refuses wrong callback principal, chat, message, update, and callback identity without consuming the valid request', async () => {
    admit('Protected target.')
    const { controller } = ceremony()
    await controller.begin(command('/remember revoke Protected target.'))
    for (const overrides of [
      { fromUserId: 222 },
      { chatId: 222 },
      { chatType: 'group' },
      { messageId: 999 },
      { updateId: undefined },
      { callbackQueryId: undefined },
    ]) {
      expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:y`, overrides))).toBe('refused')
      expect(controller.pendingCount()).toBe(1)
    }
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
  })

  it('cannot confuse apr or pdecl callbacks with lifecycle mutation', async () => {
    admit('Namespace target.')
    const { controller, sender } = ceremony()
    await controller.begin(command('/remember revoke Namespace target.'))
    expect(await controller.handleCallback(callback(`apr:${TOKEN_A}:y`))).toBe('refused')
    expect(await controller.handleCallback(callback(`pdecl:${TOKEN_A}:y`))).toBe('refused')
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])

    const gate = createApprovalGate(cfg, sender)
    gate.handleCallback(`plife:${TOKEN_A}:y`, ADMIN, 'approval-callback')
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
  })
})

describe('P3C2 ephemeral one-shot lifecycle pending state', () => {
  it('creates only ephemeral pending state; command/card failure creates no durable event', async () => {
    admit('Ephemeral target.')
    const { controller, sender } = ceremony()
    expect(await controller.begin(command('/remember revoke Ephemeral target.'))).toBe('pending')
    expect(controller.pendingCount()).toBe(1)
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])

    const failedSender = createNullSender()
    failedSender.sendWithKeyboard = async () => undefined
    const failed = createPrincipalLifecycleCeremonyController(cfg, failedSender)
    controllers.push(failed)
    expect(await failed.begin(command('/remember revoke Ephemeral target.'))).toBe('refused')
    expect(failed.pendingCount()).toBe(0)
    expect(sender.keyboards[0]?.keyboard[0]?.[0]?.callbackData).toBe(`plife:${TOKEN_A}:y`)
  })

  it('expires, restart-cancels, and one-shot cancels without appending', async () => {
    admit('Expiry target.')
    let clock = 1_000
    const expiring = ceremony([TOKEN_A], () => clock).controller
    await expiring.begin(command('/remember revoke Expiry target.'))
    clock = 61_000
    expect(await expiring.handleCallback(callback(`plife:${TOKEN_A}:y`))).toBe('refused')

    const restarting = ceremony([TOKEN_B]).controller
    await restarting.begin(command('/remember revoke Expiry target.'))
    expect(restarting.cancelAll()).toBe(1)
    expect(await restarting.handleCallback(callback(`plife:${TOKEN_B}:y`))).toBe('refused')

    const cancelling = ceremony(['c'.repeat(24)]).controller
    await cancelling.begin(command('/remember revoke Expiry target.'))
    expect(await cancelling.handleCallback(callback(`plife:${'c'.repeat(24)}:n`))).toBe('cancelled')
    expect(await cancelling.handleCallback(callback(`plife:${'c'.repeat(24)}:n`))).toBe('refused')
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
  })

  it('consumes final confirmation before its first await so concurrent replay cannot append twice', async () => {
    admit('One-shot target.')
    const { controller } = ceremony()
    await controller.begin(command('/remember revoke One-shot target.'))
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = controller.handleCallback(callback(`plife:${TOKEN_A}:y`, {
      acknowledge: async () => { await held; return true },
    }))
    expect(controller.pendingCount()).toBe(0)
    expect(loadPrincipalLifecycleCatalog(cfg)).toHaveLength(1)
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:y`))).toBe('refused')
    release()
    expect(await first).toBe('revoked')
    expect(loadPrincipalLifecycleCatalog(cfg)).toHaveLength(1)
  })
})

describe('P3C2 authenticated revoke ceremony', () => {
  it('shows the exact escaped active declaration/type/action and command alone appends nothing', async () => {
    admit('</pre><b>Exact revoke target</b>', 'PREFERENCE')
    const { controller, sender } = ceremony()
    expect(await controller.begin(command('/remember revoke </pre><b>Exact revoke target</b>'))).toBe('pending')
    const card = sender.messages[0]?.text ?? ''
    expect(card).toContain('Action: <code>REVOKE</code>')
    expect(card).toContain('Type: <code>PREFERENCE</code>')
    expect(card).toContain('&lt;/pre&gt;&lt;b&gt;Exact revoke target&lt;/b&gt;')
    expect(card).toContain('no longer project as active principal policy')
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
  })

  it('refuses unmatched, revoked, and superseded exact targets', async () => {
    const target = admit('Revoked target.')
    const old = admit('Superseded target.')
    const successor = admit('Active successor.')
    const first = ceremony(['d'.repeat(24)]).controller
    expect(await first.begin(command('/remember revoke Missing target.'))).toBe('refused')
    directRevoke(target)
    directSupersede(old, successor, 'superseded-target')
    expect(await first.begin(command('/remember revoke Revoked target.'))).toBe('refused')
    expect(await first.begin(command('/remember supersede Superseded target.'))).toBe('refused')
  })

  it('fails closed when an ambiguous declaration catalog is supplied', async () => {
    const target = admit('Ambiguous target.')
    const provenanceFile = principalProvenanceStorePath(cfg)
    fs.appendFileSync(provenanceFile, `${serializePrincipalProvenance(target)}\n`)
    const { controller } = ceremony()
    expect(await controller.begin(command('/remember revoke Ambiguous target.'))).toBe('refused')
    expect(controller.pendingCount()).toBe(0)
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
  })

  it('fresh-state change consumes and refuses the confirmation without appending its target event', async () => {
    const target = admit('Fresh target.')
    const other = admit('Other target.')
    const { controller } = ceremony()
    await controller.begin(command('/remember revoke Fresh target.'))
    directRevoke(other, 'state-change')
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:y`))).toBe('refused')
    expect(controller.pendingCount()).toBe(0)
    expect(loadPrincipalLifecycleCatalog(cfg)).toHaveLength(1)
    expect(loadCoherentPrincipalLifecycleState(cfg).activeDeclarations.map((item) => item.provenanceId))
      .toContain(target.provenanceId)
  })

  it('appends one valid revoke while preserving USER/provenance bytes and downgrading later projection', async () => {
    admit('Policy to revoke.')
    const userFile = path.join(cfg.paths.dataDir, 'workspace', 'USER.md')
    const provenanceFile = principalProvenanceStorePath(cfg)
    const beforeUser = fs.readFileSync(userFile)
    const beforeProvenance = fs.readFileSync(provenanceFile)
    const { controller } = ceremony()
    await controller.begin(command('/remember revoke Policy to revoke.'))
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:y`))).toBe('revoked')
    const events = loadPrincipalLifecycleCatalog(cfg)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED', authorityGranted: false })
    expect(fs.readFileSync(userFile)).toEqual(beforeUser)
    expect(fs.readFileSync(provenanceFile)).toEqual(beforeProvenance)
    const prompt = buildSystemPrompt({
      name: 'orchestrator', emoji: '🎯', description: 'test', maxTurns: 2, systemPrompt: 'test',
    }, cfg, '', undefined, principalOperatorActor(0))
    expect(prompt).toMatch(/"content":"Policy to revoke\."[^}]*"disposition":"UNVERIFIED_WORKING_NOTE"/)
  })

  it('does not retry append failure or recreate pending state', async () => {
    admit('Append failure target.')
    const beforeUser = fs.readFileSync(path.join(cfg.paths.dataDir, 'workspace', 'USER.md'))
    const beforeProvenance = fs.readFileSync(principalProvenanceStorePath(cfg))
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('injected lifecycle append failure')
    })
    const { controller } = ceremony()
    await controller.begin(command('/remember revoke Append failure target.'))
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:y`))).toBe('refused')
    expect(append).toHaveBeenCalledTimes(1)
    expect(controller.pendingCount()).toBe(0)
    expect(fs.existsSync(principalLifecycleStorePath(cfg))).toBe(false)
    expect(fs.readFileSync(path.join(cfg.paths.dataDir, 'workspace', 'USER.md'))).toEqual(beforeUser)
    expect(fs.readFileSync(principalProvenanceStorePath(cfg))).toEqual(beforeProvenance)
  })

  it('treats the durable event as receipt when Telegram acknowledgement/edit fails', async () => {
    admit('Response failure target.')
    const { controller, sender } = ceremony()
    sender.editWithKeyboard = async () => { throw new Error('Telegram edit failed') }
    await controller.begin(command('/remember revoke Response failure target.'))
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:y`, {
      acknowledge: async () => false,
    }))).toBe('revoked')
    expect(loadPrincipalLifecycleCatalog(cfg)).toHaveLength(1)
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:y`))).toBe('refused')
    expect(loadPrincipalLifecycleCatalog(cfg)).toHaveLength(1)
  })
})

describe('P3C2 explicit supersession ceremony and replacement boundary', () => {
  it('refuses safely with two-ceremony guidance when no eligible successor exists', async () => {
    admit('Only active target.')
    const { controller, sender } = ceremony()
    expect(await controller.begin(command('/remember supersede Only active target.'))).toBe('refused')
    expect(sender.messages.at(-1)?.text).toContain('First admit the new declaration')
    expect(sender.messages.at(-1)?.text).toContain('/remember instruction')
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
  })

  it('excludes the target, filters another principal, and requires explicit selection among candidates', async () => {
    const principal = `principal:test:${'1'.repeat(64)}`
    const otherPrincipal = `principal:other:${'2'.repeat(64)}`
    const target = storedPrincipal('Old.', principal, 'old')
    const one = storedPrincipal('New one.', principal, 'one')
    const two = storedPrincipal('New two.', principal, 'two')
    const outsider = storedPrincipal('Other principal.', otherPrincipal, 'other')
    const provenanceFile = principalProvenanceStorePath(cfg)
    fs.mkdirSync(path.dirname(provenanceFile), { recursive: true })
    fs.writeFileSync(provenanceFile, [target, one, two, outsider].map(serializePrincipalProvenance).join('\n') + '\n')
    for (const item of [target, one, two, outsider]) {
      expect(applyWorkspaceOp(cfg.paths.dataDir, 'user', { action: 'add', content: item.content }).ok).toBe(true)
    }
    const { controller, sender } = ceremony()
    expect(await controller.begin(command('/remember supersede Old.'))).toBe('pending')
    const buttons = sender.keyboards[0]!.keyboard.flat()
    expect(buttons.filter((button) => button.text.startsWith('Select'))).toHaveLength(2)
    const card = sender.messages[0]!.text
    expect(card).toContain('<pre>New one.</pre>')
    expect(card).toContain('<pre>New two.</pre>')
    expect(card).not.toContain('<pre>Other principal.</pre>')
    expect(buttons.map((button) => button.callbackData)).not.toContain(target.provenanceId)
  })

  it('binds exact successor identity and displays exact escaped OLD/NEW types before final confirmation', async () => {
    admit('Old <policy>.', 'INSTRUCTION')
    const successor = admit('New </pre><b>policy</b>.', 'PREFERENCE')
    const { controller, sender } = ceremony()
    await controller.begin(command('/remember supersede Old <policy>.'))
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:s:0`))).toBe('selected')
    const confirmation = sender.messages.at(-1)?.text ?? ''
    expect(confirmation).toContain('<b>OLD</b> — <code>INSTRUCTION</code>')
    expect(confirmation).toContain('Old &lt;policy&gt;.')
    expect(confirmation).toContain('<b>NEW</b> — <code>PREFERENCE</code>')
    expect(confirmation).toContain('New &lt;/pre&gt;&lt;b&gt;policy&lt;/b&gt;.')
    expect(sender.keyboards.at(-1)?.keyboard[0]?.[0]?.callbackData).toBe(`plife:${TOKEN_B}:y`)
    expect(confirmation).not.toContain(successor.provenanceId)
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
  })

  it('fresh-state change after selection invalidates final confirmation', async () => {
    admit('Old state.')
    const successor = admit('New state.')
    const extra = admit('Extra state.')
    const { controller } = ceremony()
    await controller.begin(command('/remember supersede Old state.'))
    expect(await controller.handleCallback(callback(`plife:${TOKEN_A}:s:0`))).toBe('selected')
    directRevoke(extra, 'after-selection')
    expect(await controller.handleCallback(callback(`plife:${TOKEN_B}:y`, { updateId: 41 }))).toBe('refused')
    expect(loadPrincipalLifecycleCatalog(cfg)).toHaveLength(1)
    expect(loadCoherentPrincipalLifecycleState(cfg).activeDeclarations.map((item) => item.provenanceId))
      .toContain(successor.provenanceId)
  })

  it('supersedes only after separate successor admission and preserves both existing files', async () => {
    admit('Old durable policy.')
    const successor = admit('Separately admitted successor.', 'PREFERENCE')
    const userFile = path.join(cfg.paths.dataDir, 'workspace', 'USER.md')
    const provenanceFile = principalProvenanceStorePath(cfg)
    const beforeUser = fs.readFileSync(userFile)
    const beforeProvenance = fs.readFileSync(provenanceFile)
    const { controller } = ceremony()
    await controller.begin(command('/remember supersede Old durable policy.'))
    await controller.handleCallback(callback(`plife:${TOKEN_A}:s:0`))
    expect(await controller.handleCallback(callback(`plife:${TOKEN_B}:y`, { updateId: 41 }))).toBe('superseded')
    const state = loadCoherentPrincipalLifecycleState(cfg)
    expect(state.lifecycleEvents).toHaveLength(1)
    expect(state.lifecycleEvents[0]).toMatchObject({
      lifecycleKind: 'PRINCIPAL_DECLARATION_SUPERSEDED',
      successorProvenanceId: successor.provenanceId,
      authorityGranted: false,
    })
    expect(state.activeDeclarations.map((item) => item.provenanceId)).toEqual([successor.provenanceId])
    expect(fs.readFileSync(userFile)).toEqual(beforeUser)
    expect(fs.readFileSync(provenanceFile)).toEqual(beforeProvenance)
    const prompt = buildSystemPrompt({
      name: 'orchestrator', emoji: '🎯', description: 'test', maxTurns: 2, systemPrompt: 'test',
    }, cfg, '', undefined, principalOperatorActor(0))
    expect(prompt).toMatch(/"content":"Old durable policy\."[^}]*"disposition":"UNVERIFIED_WORKING_NOTE"/)
    expect(prompt).toMatch(/"content":"Separately admitted successor\."[^}]*"disposition":"PRINCIPAL_DECLARED"/)
  })

  it('never auto-admits, auto-chains, retries, or reports a failed supersession as replacement complete', async () => {
    admit('Old replacement policy.')
    admit('Already admitted replacement.')
    const beforeProvenance = fs.readFileSync(principalProvenanceStorePath(cfg))
    const { controller, sender } = ceremony()
    await controller.begin(command('/remember supersede Old replacement policy.'))
    await controller.handleCallback(callback(`plife:${TOKEN_A}:s:0`))
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('append refused') })
    expect(await controller.handleCallback(callback(`plife:${TOKEN_B}:y`, { updateId: 41 }))).toBe('refused')
    expect(fs.readFileSync(principalProvenanceStorePath(cfg))).toEqual(beforeProvenance)
    expect(sender.messages.at(-1)?.text).not.toContain('replacement complete')
    expect(controller.pendingCount()).toBe(0)
  })
})

describe('P3C2 durable reference privacy and route exclusion', () => {
  function referenceInput(kind: PrincipalLifecycleKind = 'PRINCIPAL_DECLARATION_REVOKED') {
    return {
      schemaVersion: 1 as const,
      lifecycleKind: kind,
      principalReference: `principal:test:${'1'.repeat(64)}`,
      commandChatId: ADMIN,
      commandPrincipalUserId: ADMIN,
      commandMessageId: 123_456_789,
      commandUpdateId: 223_456_789,
      confirmationChatId: ADMIN,
      confirmationPrincipalUserId: ADMIN,
      confirmationMessageId: 323_456_789,
      confirmationUpdateId: 423_456_789,
      callbackQueryId: 'RAW_CALLBACK_QUERY_SECRET',
      callbackData: `plife:${TOKEN_A}:y`,
      targetProvenanceId: `target:${'3'.repeat(64)}`,
      ...(kind === 'PRINCIPAL_DECLARATION_SUPERSEDED'
        ? { successorProvenanceId: `successor:${'4'.repeat(64)}` }
        : {}),
      confirmationIntent: 'CONFIRM_PRINCIPAL_DECLARATION_LIFECYCLE' as const,
      authorityGranted: false as const,
    }
  }

  it('derives deterministic canonical reference IDs while preserving input and returning immutable no-authority output', () => {
    const input = referenceInput('PRINCIPAL_DECLARATION_SUPERSEDED')
    const before = JSON.parse(JSON.stringify(input))
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('durable reference must not read the ambient clock')
    })
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('durable reference must not use randomness')
    })
    const first = createTelegramPrincipalLifecycleReference(input)
    const second = createTelegramPrincipalLifecycleReference({ ...input })
    expect(second).toEqual(first)
    expect(first.lifecycleReferenceId).toMatch(/^principal-lifecycle:[a-f0-9]{64}$/)
    expect(first.authenticationRecordId).toMatch(/^principal-lifecycle-auth:[a-f0-9]{64}$/)
    expect(first.authorityGranted).toBe(false)
    expect(Object.isFrozen(first)).toBe(true)
    expect(input).toEqual(before)
    expect(now).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
  })

  it('does not hash transport Telegram identifiers into lifecycle commitments', () => {
    const first = createTelegramPrincipalLifecycleReference(referenceInput())
    const second = createTelegramPrincipalLifecycleReference({
      ...referenceInput(),
      commandChatId: 123_123_123,
      commandPrincipalUserId: 123_123_123,
      confirmationChatId: 123_123_123,
      confirmationPrincipalUserId: 123_123_123,
    })

    expect(second).toEqual(first)
    expect(JSON.stringify(first)).not.toContain(String(ADMIN))
    expect(JSON.stringify(second)).not.toContain('123123123')
  })

  it('persists no raw Telegram identifiers, token, callback query, or callback data', async () => {
    admit('Private durable target.')
    const { controller } = ceremony()
    await controller.begin(command('/remember revoke Private durable target.'))
    await controller.handleCallback(callback(`plife:${TOKEN_A}:y`))
    const raw = fs.readFileSync(principalLifecycleStorePath(cfg), 'utf8')
    expect(raw).not.toContain(String(ADMIN))
    expect(raw).not.toContain('RAW_CALLBACK_QUERY_SECRET')
    expect(raw).not.toContain('lifecycle-callback-40')
    expect(raw).not.toContain(`plife:${TOKEN_A}:y`)
    expect(raw).toContain('principal-lifecycle:')
    expect(raw).toContain('principal-lifecycle-auth:')
    expect(raw).toContain('"authorityGranted":false')
  })

  it('refuses malformed lifecycle reference context and authority requests', () => {
    expect(() => createTelegramPrincipalLifecycleReference({ ...referenceInput(), authorityGranted: true })).toThrow()
    expect(() => createTelegramPrincipalLifecycleReference({ ...referenceInput(), confirmationChatId: 1 })).toThrow()
    expect(() => createTelegramPrincipalLifecycleReference({ ...referenceInput(), callbackQueryId: '' })).toThrow()
  })

  it('exposes lifecycle mutation only through the bounded Telegram controller route', () => {
    const tools = new ToolRegistry()
    tools.register(memorySaveTool)
    expect(tools.names()).toEqual(['memory_save'])
    const ceremonySource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'memory', 'principalLifecycleCeremony.ts'),
      'utf8',
    )
    expect(ceremonySource).not.toContain('admitPrincipalDeclaration')
    expect(ceremonySource).not.toMatch(/from ['"]\.\.\/(?:safety|tools|mcp|dashboard|trading|wallet)/)
    expect(ceremonySource).not.toContain('createApprovalGate')
    const botSource = fs.readFileSync(path.join(process.cwd(), 'src', 'telegram', 'bot.ts'), 'utf8')
    expect(botSource).toContain('isPrincipalLifecycleCommand')
    expect(botSource).toContain('PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX')
    expect(botSource).toContain('/remember revoke &lt;exact active content&gt;')
    expect(botSource).toContain('/remember supersede &lt;exact active content&gt;')
    expect(botSource).not.toMatch(/bot\.command\(['"](?:revoke|supersede|replace)/)

    for (const file of [
      'src/status/http.ts',
      'src/mcp/bridge.ts',
      'src/tools/registry.ts',
      'src/tools/schedule.ts',
      'src/tools/swap.ts',
      'src/scheduler/scheduler.ts',
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      expect(source).not.toContain('appendPrincipalLifecycleEvent')
      expect(source).not.toContain('createPrincipalLifecycleCeremonyController')
    }
  })

  it('keeps P3B2 and generic approval paths unable to append lifecycle events', () => {
    const sender = createNullSender()
    const gate = createApprovalGate(cfg, sender)
    gate.handleCallback(`pdecl:${TOKEN_A}:y`, ADMIN, 'generic-pdecl')
    gate.handleCallback(`plife:${TOKEN_A}:y`, ADMIN, 'generic-plife')
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([])
    expect(readWorkspace(cfg.paths.dataDir, 'user')).toBe('')
  })
})

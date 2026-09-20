import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import {
  appendPrincipalLifecycleEvent,
  createPrincipalLifecycleEvent,
  loadCoherentPrincipalLifecycleState,
  loadPrincipalLifecycleCatalog,
  principalLifecycleStorePath,
  resolvePrincipalLifecycleState,
  serializePrincipalLifecycleEvent,
  validatePrincipalLifecycleEvent,
  type PrincipalLifecycleEvent,
} from '../src/memory/principalLifecycle.js'
import {
  createEvidenceDerivedProvenance,
  createPrincipalDeclaredProvenance,
  serializePrincipalProvenance,
  type PrincipalDeclaredProvenance,
  type PrincipalDeclarationType,
} from '../src/memory/principalProvenance.js'
import {
  createDevelopmentalMemoryStore,
  developMemory,
  digestCanonicalJson,
} from '../src/memory/developmentalMemory.js'
import { principalProvenanceStorePath } from '../src/memory/principalAdmission.js'
import { applyWorkspaceOp, readWorkspace } from '../src/store/workspace.js'
import { buildSystemPrompt } from '../src/agents/prompts.js'
import { memorySaveTool } from '../src/tools/memory.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { principalOperatorActor } from '../src/telegram/actor.js'

let root: string
let cfg: Config

const PRINCIPAL = `principal:test:${'1'.repeat(64)}`

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-principal-lifecycle-'))
  process.env['TRADING_DESK_DIR'] = root
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function principal(
  content: string,
  suffix: string,
  declarationType: PrincipalDeclarationType = 'INSTRUCTION',
  principalReference = PRINCIPAL,
): Readonly<PrincipalDeclaredProvenance> {
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

function lifecycleReference(suffix: string) {
  return {
    schemaVersion: 1 as const,
    source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE' as const,
    lifecycleReferenceId: `principal-lifecycle:${digestCanonicalJson({ suffix, kind: 'lifecycle' })}`,
    principalReference: PRINCIPAL,
    authenticationRecordId: `principal-lifecycle-auth:${digestCanonicalJson({ suffix, kind: 'authentication' })}`,
    authorityGranted: false as const,
  }
}

function revoke(target: Readonly<PrincipalDeclaredProvenance>, suffix = target.provenanceId) {
  return createPrincipalLifecycleEvent({
    schemaVersion: 1,
    lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED',
    targetProvenanceId: target.provenanceId,
    targetDeclarationId: target.declarationReference.declarationId,
    targetContentDigestSha256: target.contentDigestSha256,
    targetDeclarationType: target.declarationType,
    principalReference: target.declarationReference.principalReference,
    authenticatedLifecycleReference: lifecycleReference(`revoke-${suffix}`),
    authorityGranted: false,
  })
}

function supersede(
  target: Readonly<PrincipalDeclaredProvenance>,
  successor: Readonly<PrincipalDeclaredProvenance>,
  suffix = `${target.provenanceId}-${successor.provenanceId}`,
) {
  return createPrincipalLifecycleEvent({
    schemaVersion: 1,
    lifecycleKind: 'PRINCIPAL_DECLARATION_SUPERSEDED',
    targetProvenanceId: target.provenanceId,
    targetDeclarationId: target.declarationReference.declarationId,
    targetContentDigestSha256: target.contentDigestSha256,
    targetDeclarationType: target.declarationType,
    principalReference: target.declarationReference.principalReference,
    authenticatedLifecycleReference: lifecycleReference(`supersede-${suffix}`),
    successorProvenanceId: successor.provenanceId,
    successorDeclarationId: successor.declarationReference.declarationId,
    successorContentDigestSha256: successor.contentDigestSha256,
    successorDeclarationType: successor.declarationType,
    authorityGranted: false,
  })
}

function mutable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function writeDeclarations(declarations: readonly Readonly<PrincipalDeclaredProvenance>[]): void {
  const file = principalProvenanceStorePath(cfg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, declarations.map(serializePrincipalProvenance).join('\n') + '\n')
}

function writeLifecycle(events: readonly Readonly<PrincipalLifecycleEvent>[]): void {
  const file = principalLifecycleStorePath(cfg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, events.map(serializePrincipalLifecycleEvent).join('\n') + '\n')
}

function writeUser(...declarations: readonly Readonly<PrincipalDeclaredProvenance>[]): void {
  for (const declaration of declarations) {
    const result = applyWorkspaceOp(cfg.paths.dataDir, 'user', {
      action: 'add',
      content: declaration.content,
    })
    expect(result.ok).toBe(true)
  }
}

function evidenceDerived() {
  const evidence = [{
    source: 'journal' as const,
    recordId: 'journal:lifecycle',
    cycleId: 'cycle-lifecycle',
    contentDigestSha256: 'a'.repeat(64),
  }]
  const outcome = developMemory(
    createDevelopmentalMemoryStore(),
    evidence,
    {
      schemaVersion: 1,
      proposalId: 'proposal-lifecycle',
      memoryId: 'memory-lifecycle',
      previousRevisionId: null,
      kind: 'lesson',
      summary: 'Lifecycle evidence remains advisory.',
      supportingEvidence: [{ ...evidence[0]!, role: 'supports' }],
      contradictingEvidence: [],
      authorityGranted: false,
    },
    {
      maximumMemories: 1,
      maximumRevisions: 1,
      maximumEvidencePerMemory: 2,
      maximumSummaryCharacters: 100,
    },
  )
  if (outcome.status !== 'developed') throw new Error(outcome.reason)
  return createEvidenceDerivedProvenance({
    schemaVersion: 1,
    revision: outcome.revision,
    authorityGranted: false,
  })
}

describe('P3C1 pure lifecycle creation and precedence', () => {
  it('treats a declaration with no terminal event as active', () => {
    const a = principal('A.', 'a')
    const state = resolvePrincipalLifecycleState([a], [])
    expect(state.activeDeclarations.map((item) => item.provenanceId)).toEqual([a.provenanceId])
    expect(state.statusByProvenanceId).toEqual([{ provenanceId: a.provenanceId, status: 'ACTIVE' }])
    expect(state.authorityGranted).toBe(false)
  })

  it('resolves a valid revocation as terminal and inactive', () => {
    const a = principal('A.', 'a')
    const event = revoke(a)
    const state = resolvePrincipalLifecycleState([a], [event])
    expect(state.activeDeclarations).toEqual([])
    expect(state.statusByProvenanceId[0]).toMatchObject({ status: 'REVOKED', terminalLifecycleEventId: event.lifecycleEventId })
  })

  it('resolves supersession as old inactive and exact successor active', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b', 'PREFERENCE')
    const state = resolvePrincipalLifecycleState([a, b], [supersede(a, b)])
    expect(state.activeDeclarations.map((item) => item.provenanceId)).toEqual([b.provenanceId])
    expect(state.statusByProvenanceId.map((item) => item.status)).toEqual(['SUPERSEDED', 'ACTIVE'])
  })

  it('resolves A -> B -> C deterministically without timestamp precedence', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    const c = principal('C.', 'c')
    const events = [supersede(a, b, 'ab'), supersede(b, c, 'bc')]
    const first = resolvePrincipalLifecycleState([a, b, c], events)
    const second = resolvePrincipalLifecycleState([a, b, c], events)
    expect(first).toEqual(second)
    expect(first.lifecycleStateDigestSha256).toBe(second.lifecycleStateDigestSha256)
    expect(first.activeDeclarations.map((item) => item.content)).toEqual(['C.'])
  })

  it('never reactivates A when B is revoked after superseding A', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    const state = resolvePrincipalLifecycleState([a, b], [supersede(a, b), revoke(b)])
    expect(state.activeDeclarations).toEqual([])
    expect(state.statusByProvenanceId.map((item) => item.status)).toEqual(['SUPERSEDED', 'REVOKED'])
  })

  it('revoking a final chain successor leaves no active declaration in the chain', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    const c = principal('C.', 'c')
    const state = resolvePrincipalLifecycleState(
      [a, b, c],
      [supersede(a, b, 'ab'), supersede(b, c, 'bc'), revoke(c)],
    )
    expect(state.activeDeclarations).toEqual([])
  })

  it('creates deterministic canonical IDs, freezes outputs, and preserves caller input', () => {
    const a = principal('Immutable A.', 'a')
    const input = {
      schemaVersion: 1 as const,
      lifecycleKind: 'PRINCIPAL_DECLARATION_REVOKED' as const,
      targetProvenanceId: a.provenanceId,
      targetDeclarationId: a.declarationReference.declarationId,
      targetContentDigestSha256: a.contentDigestSha256,
      targetDeclarationType: a.declarationType,
      principalReference: PRINCIPAL,
      authenticatedLifecycleReference: lifecycleReference('immutable'),
      authorityGranted: false as const,
    }
    const before = mutable(input)
    const first = createPrincipalLifecycleEvent(input)
    const second = createPrincipalLifecycleEvent(mutable(input))
    expect(first).toEqual(second)
    expect(validatePrincipalLifecycleEvent(first)).toEqual(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.authenticatedLifecycleReference)).toBe(true)
    expect(input).toEqual(before)
    const state = resolvePrincipalLifecycleState([a], [first])
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.declarations)).toBe(true)
    expect(Object.isFrozen(state.statusByProvenanceId[0])).toBe(true)
  })

  it('needs and persists no raw Telegram IDs, callback IDs, bot tokens, clock, or randomness', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('pure lifecycle must not read the ambient clock')
    })
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('pure lifecycle must not use randomness')
    })
    const declaration = principal('Opaque lifecycle.', 'opaque')
    const event = revoke(declaration)
    const state = resolvePrincipalLifecycleState([declaration], [event])
    const serialized = serializePrincipalLifecycleEvent(event)
    expect(serialized).not.toMatch(/chatId|callback|botToken|telegram|Date|timestamp/i)
    expect(serialized).toContain('UPSTREAM_AUTHENTICATED_PRINCIPAL_LIFECYCLE')
    expect(event.authorityGranted).toBe(false)
    expect(state.authorityGranted).toBe(false)
    expect(now).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
  })
})

describe('P3C1 ambiguity and binding refusal', () => {
  it('refuses duplicate event IDs and more than one terminal event per target', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    const event = supersede(a, b, 'one')
    expect(() => resolvePrincipalLifecycleState([a, b], [event, event])).toThrow(/DUPLICATE_LIFECYCLE_EVENT/)
    expect(() => resolvePrincipalLifecycleState([a, b], [event, revoke(a, 'two')])).toThrow(/MULTIPLE_TERMINAL_EVENTS/)
  })

  it('refuses self-supersession', () => {
    const a = principal('A.', 'a')
    expect(() => supersede(a, a)).toThrow(/SELF_SUPERSESSION/)
  })

  it('refuses missing targets and missing successors', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    expect(() => resolvePrincipalLifecycleState([], [revoke(a)])).toThrow(/MISSING_TARGET_DECLARATION/)
    expect(() => resolvePrincipalLifecycleState([a], [supersede(a, b)])).toThrow(/MISSING_SUCCESSOR_DECLARATION/)
  })

  it('refuses target and successor digest/type/declaration-identity mismatch', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    const { lifecycleEventId: _targetId, ...targetCommitted } = revoke(a)
    const tamperedTarget = { ...targetCommitted, targetContentDigestSha256: 'f'.repeat(64) }
    const targetMismatch = { ...tamperedTarget, lifecycleEventId: digestCanonicalJson(tamperedTarget) }
    expect(() => resolvePrincipalLifecycleState([a], [targetMismatch])).toThrow(/DECLARATION_BINDING_MISMATCH/)

    const { lifecycleEventId: _successorId, ...successorCommitted } = supersede(a, b)
    const tamperedSuccessor = { ...successorCommitted, successorDeclarationType: 'PREFERENCE' as const }
    const successorMismatch = { ...tamperedSuccessor, lifecycleEventId: digestCanonicalJson(tamperedSuccessor) }
    expect(() => resolvePrincipalLifecycleState([a, b], [successorMismatch])).toThrow(/DECLARATION_BINDING_MISMATCH/)
  })

  it('refuses evidence-derived provenance as a lifecycle declaration catalog member', () => {
    const evidence = evidenceDerived()
    expect(() => resolvePrincipalLifecycleState([evidence], [])).toThrow(/DECLARATION_KIND_REFUSED/)
    const a = principal('A.', 'a')
    expect(() => resolvePrincipalLifecycleState([a, evidence], [revoke(a)])).toThrow(/DECLARATION_KIND_REFUSED/)
  })

  it('refuses supersession cycles and cross-principal successors', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    expect(() => resolvePrincipalLifecycleState([a, b], [supersede(a, b, 'ab'), supersede(b, a, 'ba')]))
      .toThrow(/SUPERSESSION_CYCLE/)

    const other = principal('Other.', 'other', 'INSTRUCTION', `principal:other:${'2'.repeat(64)}`)
    expect(() => resolvePrincipalLifecycleState([a, other], [supersede(a, other)]))
      .toThrow()
  })

  it('refuses tampering, unknown variants, malformed references, and authority requests', () => {
    const event = revoke(principal('A.', 'a'))
    for (const invalid of [
      { ...event, lifecycleKind: 'LATEST_TEXT_WINS' },
      { ...event, targetDeclarationType: 'PREFERENCE' },
      { ...event, authorityGranted: true },
      { ...event, authenticatedLifecycleReference: { ...event.authenticatedLifecycleReference, authorityGranted: true } },
      { ...event, authenticatedLifecycleReference: { ...event.authenticatedLifecycleReference, lifecycleReferenceId: 'apr:forged' } },
      { ...event, surprise: true },
    ]) expect(() => validatePrincipalLifecycleEvent(invalid)).toThrow()
  })
})

describe('P3C1 strict durable store and failure ordering', () => {
  it('treats a missing lifecycle store as a healthy immutable empty catalog', () => {
    const catalog = loadPrincipalLifecycleCatalog(cfg)
    expect(catalog).toEqual([])
    expect(Object.isFrozen(catalog)).toBe(true)
  })

  it.each([
    ['malformed', '{bad}\n'],
    ['partial', '{}'],
    ['empty line', '\n'],
  ])('refuses %s lifecycle JSONL', (_name, raw) => {
    const file = principalLifecycleStorePath(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, raw)
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/INVALID_LIFECYCLE_STORE/)
  })

  it('refuses parseable but noncanonical lifecycle JSONL', () => {
    const event = revoke(principal('Canonical only.', 'canonical'))
    const file = principalLifecycleStorePath(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(event)}\n`)
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/INVALID_LIFECYCLE_STORE/)
  })

  it('refuses duplicate, ambiguous, tampered, and authority-bearing stored events', () => {
    const a = principal('A.', 'a')
    const b = principal('B.', 'b')
    const event = supersede(a, b)
    const line = serializePrincipalLifecycleEvent(event)
    const file = principalLifecycleStorePath(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${line}\n${line}\n`)
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/DUPLICATE_LIFECYCLE_EVENT/)

    fs.writeFileSync(file, `${line}\n${serializePrincipalLifecycleEvent(revoke(a, 'other'))}\n`)
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/MULTIPLE_TERMINAL_EVENTS/)

    fs.writeFileSync(file, `${JSON.stringify({ ...event, targetDeclarationType: 'PREFERENCE' })}\n`)
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/LIFECYCLE_DIGEST_MISMATCH/)

    fs.writeFileSync(file, `${JSON.stringify({ ...event, authorityGranted: true })}\n`)
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/AUTHORITY_REQUESTED/)
  })

  it('refuses a symlinked lifecycle parent or final file', () => {
    const memory = path.dirname(principalLifecycleStorePath(cfg))
    fs.mkdirSync(cfg.paths.dataDir, { recursive: true })
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, memory)
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/INVALID_LIFECYCLE_STORE/)

    fs.unlinkSync(memory)
    fs.mkdirSync(memory)
    const outsideFile = path.join(root, 'outside.jsonl')
    fs.writeFileSync(outsideFile, '')
    fs.symlinkSync(outsideFile, principalLifecycleStorePath(cfg))
    expect(() => loadPrincipalLifecycleCatalog(cfg)).toThrow(/INVALID_LIFECYCLE_STORE/)
  })

  it('validates declaration, lifecycle, USER coherence, and proposed state before one append', () => {
    const a = principal('A.', 'a')
    writeDeclarations([a])
    writeUser(a)
    const event = revoke(a)
    const beforeUser = fs.readFileSync(path.join(cfg.paths.dataDir, 'workspace', 'USER.md'))
    const beforeProvenance = fs.readFileSync(principalProvenanceStorePath(cfg))
    expect(appendPrincipalLifecycleEvent(cfg, event)).toEqual(event)
    expect(loadPrincipalLifecycleCatalog(cfg)).toEqual([event])
    expect(fs.readFileSync(path.join(cfg.paths.dataDir, 'workspace', 'USER.md'))).toEqual(beforeUser)
    expect(fs.readFileSync(principalProvenanceStorePath(cfg))).toEqual(beforeProvenance)
  })

  it('changes neither USER nor declaration provenance when lifecycle append fails', () => {
    const a = principal('A.', 'a')
    writeDeclarations([a])
    writeUser(a)
    const beforeUser = fs.readFileSync(path.join(cfg.paths.dataDir, 'workspace', 'USER.md'))
    const beforeProvenance = fs.readFileSync(principalProvenanceStorePath(cfg))
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('injected lifecycle append failure') })
    expect(() => appendPrincipalLifecycleEvent(cfg, revoke(a))).toThrow(/injected lifecycle append failure/)
    expect(fs.readFileSync(path.join(cfg.paths.dataDir, 'workspace', 'USER.md'))).toEqual(beforeUser)
    expect(fs.readFileSync(principalProvenanceStorePath(cfg))).toEqual(beforeProvenance)
  })
})

describe('P3C1 projection and active-only working-note protection', () => {
  const agent = {
    name: 'orchestrator',
    emoji: '🎯',
    description: 'test',
    maxTurns: 4,
    systemPrompt: 'Test system.',
  }

  it('projects active declarations as principal and revoked declarations as unverified history', () => {
    const active = principal('Active policy.', 'active')
    const revoked = principal('Revoked policy.', 'revoked')
    writeDeclarations([active, revoked])
    writeUser(active, revoked)
    writeLifecycle([revoke(revoked)])
    const prompt = buildSystemPrompt(agent, cfg, '', undefined, principalOperatorActor(0))
    expect(prompt).toMatch(/"content":"Active policy\."[^}]*"disposition":"PRINCIPAL_DECLARED"/)
    expect(prompt).toContain('"disposition":"PRINCIPAL_DECLARED"')
    expect(prompt).toMatch(/"content":"Revoked policy\."[^}]*"disposition":"UNVERIFIED_WORKING_NOTE"/)
  })

  it('projects a superseded declaration unverified and its successor principal-declared', () => {
    const old = principal('Old policy.', 'old')
    const successor = principal('New policy.', 'new', 'PREFERENCE')
    writeDeclarations([old, successor])
    writeUser(old, successor)
    writeLifecycle([supersede(old, successor)])
    const prompt = buildSystemPrompt(agent, cfg, '', undefined, principalOperatorActor(0))
    expect(prompt).toMatch(/"content":"Old policy\."[^}]*"disposition":"UNVERIFIED_WORKING_NOTE"/)
    expect(prompt).toMatch(/"content":"New policy\."[^}]*"disposition":"PRINCIPAL_DECLARED"/)
    expect(prompt).toContain('"declarationType":"PREFERENCE"')
  })

  it('downgrades the entire projection on lifecycle corruption without changing stored bytes', () => {
    const a = principal('Would otherwise be active.', 'a')
    writeDeclarations([a])
    writeUser(a)
    const lifecycleFile = principalLifecycleStorePath(cfg)
    fs.mkdirSync(path.dirname(lifecycleFile), { recursive: true })
    fs.writeFileSync(lifecycleFile, '{broken}\n')
    const userFile = path.join(cfg.paths.dataDir, 'workspace', 'USER.md')
    const beforeUser = fs.readFileSync(userFile)
    const beforeLifecycle = fs.readFileSync(lifecycleFile)
    const prompt = buildSystemPrompt(agent, cfg, '', undefined, principalOperatorActor(0))
    expect(prompt).toContain('SYSTEM WARNING: Principal provenance or lifecycle state is unavailable or incoherent')
    expect(prompt).toContain('"disposition":"UNVERIFIED_WORKING_NOTE"')
    expect(prompt).not.toContain('"disposition":"PRINCIPAL_DECLARED"')
    expect(fs.readFileSync(userFile)).toEqual(beforeUser)
    expect(fs.readFileSync(lifecycleFile)).toEqual(beforeLifecycle)
  })

  it('blocks the runtime memory_save USER mutation when lifecycle is corrupt', async () => {
    const file = principalLifecycleStorePath(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{broken}\n')
    const result = await memorySaveTool.execute(
      { target: 'user', action: 'add', content: 'Never written.' },
      { cfg, agent, actor: principalOperatorActor(0) } as never,
    )
    expect(result.text).toContain('USER.md mutation refused')
    expect(readWorkspace(cfg.paths.dataDir, 'user')).toBe('')
  })

  it('keeps active content protected but releases revoked/superseded content through memory_save', async () => {
    const active = principal('Active.', 'active')
    const revoked = principal('Revoked.', 'revoked')
    const old = principal('Old.', 'old')
    const successor = principal('Successor.', 'successor')
    writeDeclarations([active, revoked, old, successor])
    writeUser(active, revoked, old, successor)
    writeLifecycle([revoke(revoked), supersede(old, successor)])

    const execute = (args: Record<string, unknown>) => memorySaveTool.execute(
      { target: 'user', ...args },
      { cfg, agent, actor: principalOperatorActor(0) } as never,
    )
    expect((await execute({ action: 'remove', find: 'Active.' })).text).toContain('require a lifecycle action')
    expect((await execute({ action: 'remove', find: 'Successor.' })).text).toContain('require a lifecycle action')
    expect((await execute({ action: 'remove', find: 'Revoked.' })).text).toContain('unverified working note saved')
    expect((await execute({ action: 'replace', find: 'Old.', content: 'Historical note.' })).text).toContain('unverified working note saved')
    expect(readWorkspace(cfg.paths.dataDir, 'user')).toContain('Historical note.')
    expect(() => loadCoherentPrincipalLifecycleState(cfg)).not.toThrow()
  })

  it('exposes no lifecycle tool or Telegram command/callback mutation route', () => {
    const registry = new ToolRegistry()
    registry.register(memorySaveTool)
    expect(registry.names()).toEqual(['memory_save'])
    expect(registry.names().some((name) => /lifecycle|revoke|supersede/.test(name))).toBe(false)
    const bot = fs.readFileSync(path.join(process.cwd(), 'src', 'telegram', 'bot.ts'), 'utf8')
    expect(bot).not.toMatch(/bot\.command\(['"](?:revoke|supersede|replace)/)
    expect(bot).not.toContain('principal-lifecycle:')
  })
})

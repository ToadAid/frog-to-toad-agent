import { describe, expect, it } from 'vitest'
import type { TurnActorContext } from '../src/types.js'
import {
  bindAuthenticatedRequestPrincipalV1,
  createRequestOpenedEventV1,
  createRequestStatusChangedEventV1,
  decodeRequestObligationEventV1,
  getRequestObligationV1,
  queryUnresolvedPrincipalObligationsV1,
  replayRequestObligationLedgerV1,
} from '../src/memory/requestObligations.js'

function owner(): TurnActorContext {
  return {
    source: 'telegram_user', transport: 'telegram', chatType: 'private',
    username: 'must-not-persist', displayName: 'Must Not Persist', isBot: false,
    ownerBindingConfigured: true, transportIdentityPresent: true, ownerIdentityMatch: true,
    principalAuthenticated: true, principalProvider: 'telegram',
    principalId: 'telegram:system-owner', principalRole: 'SYSTEM_OWNER', authorityGranted: false,
  }
}
function guest(): TurnActorContext {
  return {
    source: 'telegram_user', transport: 'telegram', chatType: 'private',
    displayName: 'Guest', isBot: false, ownerBindingConfigured: true,
    transportIdentityPresent: true, ownerIdentityMatch: false,
    principalAuthenticated: false, authorityGranted: false,
  }
}
function opened(ref = 'telegram-message:request-1', text = 'Review the exact PR and tell me what still blocks it.', at = 100, actor: TurnActorContext = owner()) {
  return createRequestOpenedEventV1({ actor, sourceRequestRef: ref, requestText: text, recordedAt: at })
}

describe('TEMPORAL-P3 — request / response / obligation ledger', () => {
  it('binds authenticated principal and persists redacted identity only', () => {
    expect(bindAuthenticatedRequestPrincipalV1(owner())).toMatchObject({
      provider: 'telegram', principalId: 'telegram:system-owner', principalRole: 'SYSTEM_OWNER', authorityGranted: false,
    })
    const event = opened()
    expect(JSON.stringify(event)).not.toContain('must-not-persist')
    expect(JSON.stringify(event)).not.toContain('Must Not Persist')
    expect(event.historicalRequestReusableAsAuthority).toBe(false)
  })

  it('refuses guest, scheduled, and internal callers as principal request sources', () => {
    expect(() => opened('a', 'x', 1, guest())).toThrow(/UNAUTHENTICATED_PRINCIPAL/)
    expect(() => opened('b', 'x', 1, { source: 'scheduled_system', displayName: 'Scheduled system' })).toThrow(/UNAUTHENTICATED_PRINCIPAL/)
    expect(() => opened('c', 'x', 1, {
      source: 'system_internal', displayName: 'Frog-to-Toad internal task',
      principalContextAllowed: true, deskMutationAllowed: true, principalMemoryMutationAllowed: true,
    })).toThrow(/UNAUTHENTICATED_PRINCIPAL/)
  })

  it('accepts local principal_operator without pretending it is Telegram', () => {
    const event = opened('local-turn:1', 'Local request', 1, { source: 'principal_operator', displayName: 'Principal operator' })
    expect(event.principal).toMatchObject({ provider: 'local', principalId: 'local:principal-operator' })
  })

  it('opening identity is deterministic and tamper-evident', () => {
    const first = opened()
    const second = opened()
    expect(first.eventId).toBe(second.eventId)
    expect(first.obligationId).toBe(second.obligationId)
    expect(() => decodeRequestObligationEventV1({ ...first, requestText: 'changed' })).toThrow(/EVENT_ID_MISMATCH/)
  })

  it('binds obligation identity to principal + sourceRequestRef so replay time cannot fork one request', () => {
    const first = opened('telegram-message:stable-request', 'Original request', 100)
    const replayedLater = opened('telegram-message:stable-request', 'Original request', 900)
    const conflictingReplay = opened('telegram-message:stable-request', 'Changed request text', 900)

    expect(replayedLater.obligationId).toBe(first.obligationId)
    expect(replayedLater.eventId).not.toBe(first.eventId)
    expect(conflictingReplay.obligationId).toBe(first.obligationId)

    expect(() => replayRequestObligationLedgerV1([first, replayedLater]))
      .toThrow(/DUPLICATE_OBLIGATION/)
    expect(() => replayRequestObligationLedgerV1([first, conflictingReplay]))
      .toThrow(/DUPLICATE_OBLIGATION/)
  })

  it('supports OPEN → IN_PROGRESS → DEFERRED → IN_PROGRESS → RESOLVED', () => {
    const open = opened()
    let state = replayRequestObligationLedgerV1([open])[0]!
    const working = createRequestStatusChangedEventV1({ current: state, status: 'IN_PROGRESS', recordedAt: 110 })
    state = replayRequestObligationLedgerV1([open, working])[0]!
    const deferred = createRequestStatusChangedEventV1({ current: state, status: 'DEFERRED', recordedAt: 120, responseRef: 'response:deferred' })
    state = replayRequestObligationLedgerV1([open, working, deferred])[0]!
    const resumed = createRequestStatusChangedEventV1({ current: state, status: 'IN_PROGRESS', recordedAt: 130 })
    state = replayRequestObligationLedgerV1([open, working, deferred, resumed])[0]!
    const resolved = createRequestStatusChangedEventV1({ current: state, status: 'RESOLVED', recordedAt: 140, responseRef: 'response:resolved' })
    const final = replayRequestObligationLedgerV1([open, working, deferred, resumed, resolved])[0]!
    expect(final.currentStatus).toBe('RESOLVED')
    expect(final.terminal).toBe(true)
    expect(final.latestResponseRef).toBe('response:resolved')
    expect(final.authorityGranted).toBe(false)
  })

  it('requires response refs for DEFERRED/RESOLVED/REFUSED and refuses one for IN_PROGRESS', () => {
    const state = replayRequestObligationLedgerV1([opened()])[0]!
    for (const status of ['DEFERRED', 'RESOLVED', 'REFUSED'] as const) {
      expect(() => createRequestStatusChangedEventV1({ current: state, status, recordedAt: 110 })).toThrow(/RESPONSE_REF_REQUIRED/)
    }
    expect(() => createRequestStatusChangedEventV1({
      current: state, status: 'IN_PROGRESS', recordedAt: 110, responseRef: 'not-yet',
    })).toThrow(/RESPONSE_REF_REFUSED/)
  })

  it('makes RESOLVED and REFUSED terminal', () => {
    const open = opened()
    const state = replayRequestObligationLedgerV1([open])[0]!
    const refused = createRequestStatusChangedEventV1({ current: state, status: 'REFUSED', recordedAt: 110, responseRef: 'response:refused' })
    const terminal = replayRequestObligationLedgerV1([open, refused])[0]!
    expect(() => createRequestStatusChangedEventV1({ current: terminal, status: 'IN_PROGRESS', recordedAt: 120 })).toThrow(/INVALID_TRANSITION/)
    expect(terminal.historicalRequestReusableAsAuthority).toBe(false)
  })

  it('replay fails closed on missing roots and time regression', () => {
    const open = opened()
    const state = replayRequestObligationLedgerV1([open])[0]!
    const working = createRequestStatusChangedEventV1({ current: state, status: 'IN_PROGRESS', recordedAt: 110 })
    expect(() => replayRequestObligationLedgerV1([working])).toThrow(/MISSING_OPEN_EVENT/)
    expect(() => createRequestStatusChangedEventV1({ current: state, status: 'IN_PROGRESS', recordedAt: 99 })).toThrow(/TIME_REGRESSION/)
  })

  it('bounded unresolved query keeps OPEN/IN_PROGRESS/DEFERRED and excludes terminal history', () => {
    const first = opened('request:first', 'First request', 100)
    const second = opened('request:second', 'Second request', 200)
    const third = opened('request:third', 'Third request', 300)
    const resolved = createRequestStatusChangedEventV1({
      current: replayRequestObligationLedgerV1([first])[0]!,
      status: 'RESOLVED', recordedAt: 150, responseRef: 'response:first',
    })
    const working = createRequestStatusChangedEventV1({
      current: replayRequestObligationLedgerV1([second])[0]!,
      status: 'IN_PROGRESS', recordedAt: 210,
    })
    const query = queryUnresolvedPrincipalObligationsV1(
      [first, resolved, second, working, third], 'telegram:system-owner', 1,
    )
    expect(query.totalUnresolved).toBe(2)
    expect(query.truncated).toBe(true)
    expect(query.obligations[0]!.requestText).toBe('Second request')
  })

  it('query limit is explicit and bounded', () => {
    const event = opened()
    expect(() => queryUnresolvedPrincipalObligationsV1([event], 'telegram:system-owner', 0)).toThrow(/INVALID_QUERY_LIMIT/)
    expect(() => queryUnresolvedPrincipalObligationsV1([event], 'telegram:system-owner', 101)).toThrow(/INVALID_QUERY_LIMIT/)
  })

  it('gets one obligation by deterministic id', () => {
    const event = opened()
    expect(getRequestObligationV1([event], event.obligationId).currentStatus).toBe('OPEN')
  })
})

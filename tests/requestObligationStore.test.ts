import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import type { TurnActorContext } from '../src/types.js'
import { createRequestOpenedEventV1, createRequestStatusChangedEventV1 } from '../src/memory/requestObligations.js'
import {
  appendRequestObligationEventV1,
  loadRequestObligationEventsV1,
  loadRequestObligationStatesV1,
  requestObligationStorePath,
} from '../src/memory/requestObligationStore.js'

function cfg(dir: string): Config { return { paths: { dataDir: dir } } as Config }
function owner(): TurnActorContext {
  return {
    source: 'telegram_user', transport: 'telegram', chatType: 'private',
    displayName: 'System owner', isBot: false, ownerBindingConfigured: true,
    transportIdentityPresent: true, ownerIdentityMatch: true, principalAuthenticated: true,
    principalProvider: 'telegram', principalId: 'telegram:system-owner',
    principalRole: 'SYSTEM_OWNER', authorityGranted: false,
  }
}
function open(at = 100) {
  return createRequestOpenedEventV1({
    actor: owner(), sourceRequestRef: `telegram-message:${at}`,
    requestText: `Request at ${at}`, recordedAt: at,
  })
}

describe('TEMPORAL-P3 — strict append-only obligation store', () => {
  it('persists and reloads OPEN → IN_PROGRESS → RESOLVED', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-obligation-'))
    try {
      const config = cfg(dir)
      const first = open()
      appendRequestObligationEventV1(config, first)
      let state = loadRequestObligationStatesV1(config)[0]!
      const working = createRequestStatusChangedEventV1({ current: state, status: 'IN_PROGRESS', recordedAt: 110 })
      appendRequestObligationEventV1(config, working)
      state = loadRequestObligationStatesV1(config)[0]!
      const resolved = createRequestStatusChangedEventV1({ current: state, status: 'RESOLVED', recordedAt: 120, responseRef: 'assistant-response:final' })
      appendRequestObligationEventV1(config, resolved)
      const events = loadRequestObligationEventsV1(config)
      const states = loadRequestObligationStatesV1(config)
      expect(events.map((e) => e.eventId)).toEqual([first.eventId, working.eventId, resolved.eventId])
      expect(states[0]!.currentStatus).toBe('RESOLVED')
      expect(fs.readFileSync(requestObligationStorePath(config), 'utf8').trim().split('\n')).toHaveLength(3)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses corrupt JSON and partial final lines without repairing bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-obligation-corrupt-'))
    try {
      const config = cfg(dir)
      fs.mkdirSync(path.dirname(requestObligationStorePath(config)), { recursive: true })
      const file = requestObligationStorePath(config)
      fs.writeFileSync(file, '{bad json}\n', 'utf8')
      const before = fs.readFileSync(file)
      expect(() => loadRequestObligationEventsV1(config)).toThrow(/INVALID_OBLIGATION_STORE/)
      expect(fs.readFileSync(file)).toEqual(before)
      fs.writeFileSync(file, JSON.stringify(open()), 'utf8')
      const partial = fs.readFileSync(file)
      expect(() => loadRequestObligationEventsV1(config)).toThrow(/partial line/)
      expect(fs.readFileSync(file)).toEqual(partial)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses duplicate append before writing another byte', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-obligation-append-'))
    try {
      const config = cfg(dir)
      const first = open()
      appendRequestObligationEventV1(config, first)
      const file = requestObligationStorePath(config)
      const before = fs.readFileSync(file)
      expect(() => appendRequestObligationEventV1(config, first)).toThrow(/INVALID_OBLIGATION_APPEND/)
      expect(fs.readFileSync(file)).toEqual(before)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses same authenticated source request replayed with a later recording time before writing bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-obligation-source-replay-'))
    try {
      const config = cfg(dir)
      const first = createRequestOpenedEventV1({
        actor: owner(),
        sourceRequestRef: 'telegram-message:stable-source',
        requestText: 'Original request',
        recordedAt: 100,
      })
      appendRequestObligationEventV1(config, first)
      const file = requestObligationStorePath(config)
      const before = fs.readFileSync(file)

      const replayedLater = createRequestOpenedEventV1({
        actor: owner(),
        sourceRequestRef: 'telegram-message:stable-source',
        requestText: 'Changed request must not fork the source identity',
        recordedAt: 999,
      })
      expect(replayedLater.obligationId).toBe(first.obligationId)
      expect(() => appendRequestObligationEventV1(config, replayedLater))
        .toThrow(/INVALID_OBLIGATION_APPEND/)
      expect(fs.readFileSync(file)).toEqual(before)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails closed on symlinked temporal parent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-obligation-symlink-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'request-obligation-outside-'))
    try {
      fs.symlinkSync(outside, path.join(dir, 'temporal'))
      expect(() => appendRequestObligationEventV1(cfg(dir), open())).toThrow(/INVALID_OBLIGATION_STORE/)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not create a missing dataDir as a hidden side effect', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'request-obligation-parent-'))
    try {
      const missing = path.join(parent, 'missing-data')
      expect(() => appendRequestObligationEventV1(cfg(missing), open())).toThrow(/data directory is missing/)
      expect(fs.existsSync(missing)).toBe(false)
    } finally { fs.rmSync(parent, { recursive: true, force: true }) }
  })
})

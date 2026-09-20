import { describe, it, expect } from 'vitest'
import { temporalAnchors, fmtLocalTs, relDay } from '../src/util/temporal.js'
import { buildSystemPrompt } from '../src/agents/prompts.js'
import type { AgentDef } from '../src/types.js'

// A DST boundary: 2026-11-01 01:30 is "the hour that happens twice" in US zones.
// Noon before the fall-back: Oct 31; noon after: Nov 1 — civil math must hold.
const NOON_ET = (iso: string) => new Date(`${iso}T12:00:00-04:00`).getTime()

const cfg = {
  timezone: 'America/New_York',
  paths: { dataDir: '/tmp/desk-temporal-test', agentsDir: '/tmp', skillsDir: '/tmp', assetsDir: '/tmp' },
  brain: 'glm',
  llm: { provider: 'zai', model: 'test-model' },
  dryRun: true,
} as never

describe('temporalAnchors — the desk knows what day it is', () => {
  it('anchors today/yesterday/tomorrow in the principal zone', () => {
    const t = temporalAnchors(cfg, NOON_ET('2026-09-02'))
    expect(t.todayKey).toBe('2026-09-02')
    expect(t.yesterdayKey).toBe('2026-09-01')
    expect(t.tomorrowKey).toBe('2026-09-03')
    expect(t.text).toContain('Wednesday, September 2, 2026')
    expect(t.text).toContain('Tuesday, September 1, 2026')
    expect(t.text).toContain('Thursday, September 3, 2026')
    expect(t.text).toContain('America/New_York')
  })

  it('never guesses the UTC date for late-evening moments', () => {
    // 8:00 PM New York on Sep 2 is 2026-09-03 in UTC — the old journal render
    // showed TOMORROW's date. Anchors must stay on the principal's calendar.
    const late = new Date('2026-09-02T20:00:00-04:00').getTime()
    const t = temporalAnchors(cfg, late)
    expect(t.todayKey).toBe('2026-09-02')
    expect(t.text).toContain('8:00 PM')
  })

  it('crosses a DST fall-back without drifting a day', () => {
    const t = temporalAnchors(cfg, NOON_ET('2026-10-31'))
    expect(t.todayKey).toBe('2026-10-31')
    expect(t.tomorrowKey).toBe('2026-11-01') // Sunday — even though it's a 25h day
    const t2 = temporalAnchors(cfg, new Date('2026-11-02T12:00:00-05:00').getTime())
    expect(t2.yesterdayKey).toBe('2026-11-01')
  })
})

describe('temporal rendering for tool output', () => {
  it('fmtLocalTs renders date + time + zone, not UTC', () => {
    const ts = new Date('2026-09-02T20:00:00-04:00').getTime()
    // zone abbreviation spelling varies by ICU build (EDT vs GMT-4) — check structure
    expect(fmtLocalTs('America/New_York', ts)).toMatch(/^2026-09-02 20:00 \S+$/)
    expect(fmtLocalTs('UTC', ts)).toMatch(/^2026-09-03 00:00 /)
  })

  it('relDay names today, yesterday and day counts', () => {
    const now = NOON_ET('2026-09-02')
    expect(relDay('America/New_York', now, now)).toBe('today')
    expect(relDay('America/New_York', now - 86_400_000, now)).toBe('yesterday')
    expect(relDay('America/New_York', now - 3 * 86_400_000, now)).toBe('3 days ago')
    expect(relDay('America/New_York', now + 86_400_000, now)).toBe('tomorrow')
  })
})

describe('system prompt carries the anchors', () => {
  it('every agent gets the NOW block injected', () => {
    const agent = { name: 'x', emoji: 'x', description: 'x', systemPrompt: 'You are a test agent.' } as unknown as AgentDef
    const prompt = buildSystemPrompt(agent, cfg, '')
    expect(prompt).toContain('You are a test agent.')
    expect(prompt).toContain('## NOW — time anchors')
    expect(prompt).toContain('never guess')
  })

  it('a delegating agent is taught the task-notification synthesis law (mother §5)', () => {
    const agent = { name: 'x', emoji: 'x', description: 'x', systemPrompt: 'You are a test agent.' } as unknown as AgentDef
    const prompt = buildSystemPrompt(agent, cfg, 'researcher 🔬')
    expect(prompt).toContain('## Task notifications')
    expect(prompt).toContain('WORKER REPORTS')
    expect(prompt).toContain('<task-notification>')
    expect(prompt).toContain('based on the findings')
    // A non-delegating agent has no workers, so no notification law.
    const plain = buildSystemPrompt(agent, cfg, '')
    expect(plain).not.toContain('## Task notifications')
  })
})

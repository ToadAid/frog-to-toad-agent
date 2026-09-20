import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { noteCronFired, readWatchdogState, runWatchdog, STALE_CRON_MS } from '../src/rituals/watchdog.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-watchdog-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(path.join(cfg.paths.dataDir, 'state'), { recursive: true, force: true })
})

describe('watchdog — the desk watches itself (Nautilus steal)', () => {
  it('cron heartbeat persists across reloads (atomic write, no .tmp litter)', () => {
    noteCronFired(cfg, 1_000)
    expect(readWatchdogState(cfg).lastCronFired).toBe(1_000)
    const litter = fs.readdirSync(path.join(cfg.paths.dataDir, 'state')).filter((f) => f.endsWith('.tmp'))
    expect(litter).toEqual([])
  })

  it('healthy desk is SILENT — brain answers, rituals firing', async () => {
    const now = Date.now()
    noteCronFired(cfg, now - 60_000) // beat 1 min ago
    const alerts = await runWatchdog(cfg, { brainHealthy: async () => true, now: () => now, bootedAt: () => 0 })
    expect(alerts).toEqual([])
  })

  it('dead brain alerts with the endpoint in the message', async () => {
    const alerts = await runWatchdog(cfg, { brainHealthy: async () => false })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.check).toBe('brain')
    expect(alerts[0]?.alert).toContain('brain unreachable')
    expect(alerts[0]?.alert).toContain(cfg.llm.baseUrl)
  })

  it('silent scheduler (no beat within 6h) alerts staleness', async () => {
    const now = Date.now()
    noteCronFired(cfg, now - STALE_CRON_MS - 3_600_000) // 7h silent
    const alerts = await runWatchdog(cfg, { brainHealthy: async () => true, now: () => now, bootedAt: () => 0 })
    expect(alerts.some((a) => a.check === 'cron_staleness')).toBe(true)
    expect(alerts.find((a) => a.check === 'cron_staleness')?.alert).toContain('7h')
  })

  it('a beat younger than the staleness window never alerts', async () => {
    const now = Date.now()
    noteCronFired(cfg, now - 2 * 3_600_000) // 2h silent — sentinel's own cadence
    const alerts = await runWatchdog(cfg, { brainHealthy: async () => true, now: () => now, bootedAt: () => 0 })
    expect(alerts).toEqual([])
  })

  it('a fresh boot never alerts staleness even with no heartbeat on disk', async () => {
    // no noteCronFired at all; boot happened just now (runWatchdog measures
    // from BOOTED_AT — module load — so staleness can only alert after 6h of
    // process life, never on a fresh boot)
    const alerts = await runWatchdog(cfg, { brainHealthy: async () => true })
    expect(alerts.some((a) => a.check === 'cron_staleness')).toBe(false)
  })

  it('both failures alert together', async () => {
    const now = Date.now()
    noteCronFired(cfg, now - STALE_CRON_MS - 1)
    const alerts = await runWatchdog(cfg, { brainHealthy: async () => false, now: () => now, bootedAt: () => 0 })
    expect(alerts).toHaveLength(2)
  })

  it('emit sink receives every alert (wired to the admin chat in index.ts)', async () => {
    const seen: string[] = []
    noteCronFired(cfg, Date.now() - STALE_CRON_MS - 1)
    await runWatchdog(cfg, { brainHealthy: async () => false, emit: (a) => seen.push(a), bootedAt: () => 0 })
    expect(seen).toHaveLength(2)
  })
})
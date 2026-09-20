import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  APPRENTICESHIP_WAKE_TASK_ID,
  AUTONOMOUS_WAKE_PROMPT,
  configureAutonomousWakeTask,
  readWakeReceipts,
  runAutonomousWake,
  wakeClaimsDir,
  wakeSlotKey,
} from '../src/apprenticeship/autonomousWake.js'
import { Scheduler, type CronTask } from '../src/scheduler/scheduler.js'
import { setDeskState } from '../src/safety/deskState.js'
import { cronRunSettlement } from '../src/telegram/bot.js'

let dir = ''
let cfg: Config

const ENV_KEYS = [
  'TRADING_DESK_DIR',
  'SELFTEST',
  'DRY_RUN',
  'AUTONOMOUS_DRY_RUN',
  'APPRENTICESHIP_SEED_USD',
  'APPRENTICESHIP_WAKE_CRON',
  'TELEGRAM_ADMIN_CHAT_ID',
  'USER_TIMEZONE',
  'GUARDED_TOOLS',
] as const

const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

function task(): CronTask {
  return {
    id: APPRENTICESHIP_WAKE_TASK_ID,
    cron: cfg.apprenticeshipWakeCron!,
    prompt: AUTONOMOUS_WAKE_PROMPT,
    createdAt: Date.now(),
    recurring: true,
    permanent: true,
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-a2-wake-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  process.env['DRY_RUN'] = 'true'
  process.env['AUTONOMOUS_DRY_RUN'] = 'true'
  process.env['APPRENTICESHIP_SEED_USD'] = '150'
  process.env['APPRENTICESHIP_WAKE_CRON'] = '17 */4 * * *'
  process.env['TELEGRAM_ADMIN_CHAT_ID'] = '12345'
  process.env['USER_TIMEZONE'] = 'America/New_York'
  process.env['GUARDED_TOOLS'] = 'swap_execute'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(cfg.paths.dataDir, { recursive: true, force: true })
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true })
  setDeskState(cfg, 'ACTIVE', 'test reset')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const k of ENV_KEYS) {
    const value = saved[k]
    if (value === undefined) delete process.env[k]
    else process.env[k] = value
  }
})

describe('Frog-to-Toad A2 durable autonomous wake', () => {
  it('forces schedule mutation onto the human-gated set even under env override', () => {
    expect(cfg.guardedTools).toContain('swap_execute')
    expect(cfg.guardedTools).toContain('schedule_create')
    expect(cfg.guardedTools).toContain('schedule_delete')
  })

  it('classifies an interrupted cron agent run as aborted, never completed', () => {
    expect(cronRunSettlement({ aborted: true })).toEqual({
      status: 'aborted',
      reason: 'scheduled agent run was aborted before completion',
    })
  })

  it('classifies an agent-loop error event as failed even though RunSummary resolves', () => {
    expect(cronRunSettlement({ aborted: false }, 'synthetic provider failure')).toEqual({
      status: 'failed',
      reason: 'scheduled agent run failed: synthetic provider failure',
    })
    expect(cronRunSettlement({ aborted: false })).toEqual({ status: 'completed' })
  })

  it('refuses a non-5-field wake cron so the durable slot stays minute-granular', () => {
    const previous = process.env['APPRENTICESHIP_WAKE_CRON']
    process.env['APPRENTICESHIP_WAKE_CRON'] = '5 17 */4 * * *'
    try {
      expect(() => loadConfig()).toThrow(/exactly a 5-field cron expression/)
    } finally {
      if (previous === undefined) delete process.env['APPRENTICESHIP_WAKE_CRON']
      else process.env['APPRENTICESHIP_WAKE_CRON'] = previous
    }
  })

  it('refuses a wake cron unless autonomous DRY_RUN is explicitly authorized', () => {
    const previous = process.env['AUTONOMOUS_DRY_RUN']
    process.env['AUTONOMOUS_DRY_RUN'] = 'false'
    try {
      expect(() => loadConfig()).toThrow(
        /APPRENTICESHIP_WAKE_CRON requires AUTONOMOUS_DRY_RUN=true and DRY_RUN=true/,
      )
    } finally {
      if (previous === undefined) delete process.env['AUTONOMOUS_DRY_RUN']
      else process.env['AUTONOMOUS_DRY_RUN'] = previous
    }
  })

  it('refuses a wake cron without an authorized admin conversation lane', () => {
    const previous = process.env['TELEGRAM_ADMIN_CHAT_ID']
    delete process.env['TELEGRAM_ADMIN_CHAT_ID']
    try {
      expect(() => loadConfig()).toThrow(/APPRENTICESHIP_WAKE_CRON requires TELEGRAM_ADMIN_CHAT_ID/)
    } finally {
      if (previous === undefined) delete process.env['TELEGRAM_ADMIN_CHAT_ID']
      else process.env['TELEGRAM_ADMIN_CHAT_ID'] = previous
    }
  })

  it('normalizes one permanent principal-owned task and agent removal cannot delete it', () => {
    const scheduler = new Scheduler(
      () => {},
      path.join(cfg.paths.dataDir, 'scheduled_tasks.json'),
      cfg.timezone,
    )
    const wake = configureAutonomousWakeTask(scheduler, cfg)
    expect(wake).toMatchObject({
      id: APPRENTICESHIP_WAKE_TASK_ID,
      cron: '17 */4 * * *',
      recurring: true,
      permanent: true,
    })
    expect(scheduler.list()).toHaveLength(1)
    expect(scheduler.remove(APPRENTICESHIP_WAKE_TASK_ID)).toBe(false)
    expect(scheduler.list()).toHaveLength(1)

    configureAutonomousWakeTask(scheduler, { ...cfg, apprenticeshipWakeCron: undefined })
    expect(scheduler.list()).toHaveLength(0)
    scheduler.stop()
  })

  it('claims before effect and never executes the same local minute twice', async () => {
    const at = Date.parse('2026-09-04T11:36:15Z') // 07:36 America/New_York
    let runs = 0
    let seenPrompt = ''

    const first = await runAutonomousWake(
      cfg,
      task(),
      async (prompt) => {
        runs += 1
        seenPrompt = prompt
      },
      at,
    )
    const second = await runAutonomousWake(
      cfg,
      task(),
      async () => {
        runs += 1
      },
      at + 20_000,
    )

    expect(first).toMatchObject({ status: 'completed', slot: '2026-09-04T07:36' })
    expect(second).toMatchObject({ status: 'duplicate', slot: '2026-09-04T07:36' })
    expect(runs).toBe(1)
    expect(seenPrompt).toContain('[A2 autonomous apprenticeship wake]')
    expect(seenPrompt).toContain('Finite apprenticeship cash at claim: $150.00 / $150.00 seed')

    const receipts = readWakeReceipts(cfg)
    expect(receipts.map((r) => r.event)).toEqual(['claimed', 'completed'])

    const claim = path.join(wakeClaimsDir(cfg), '2026-09-04T07-36.claim')
    expect(fs.existsSync(claim)).toBe(true)
    expect(fs.statSync(claim).mode & 0o777).toBe(0o600)
  })

  it('does not blindly retry an ambiguous/failed slot', async () => {
    const at = Date.parse('2026-09-04T15:17:01Z')
    let runs = 0

    const first = await runAutonomousWake(
      cfg,
      task(),
      async () => {
        runs += 1
        throw new Error('synthetic brain failure after claim')
      },
      at,
    )
    const retry = await runAutonomousWake(
      cfg,
      task(),
      async () => {
        runs += 1
      },
      at + 10_000,
    )

    expect(first).toMatchObject({ status: 'failed' })
    expect(retry).toMatchObject({ status: 'duplicate' })
    expect(runs).toBe(1)
    expect(readWakeReceipts(cfg).map((r) => r.event)).toEqual(['claimed', 'failed'])
  })

  it('HALTED consumes the slot as skipped and no autonomous agent run begins', async () => {
    setDeskState(cfg, 'HALTED', 'principal kill switch')
    const at = Date.parse('2026-09-04T19:17:00Z')
    let runs = 0

    const result = await runAutonomousWake(
      cfg,
      task(),
      async () => {
        runs += 1
      },
      at,
    )

    expect(result).toMatchObject({ status: 'skipped' })
    expect(result.reason).toContain('HALTED')
    expect(runs).toBe(0)
    expect(readWakeReceipts(cfg).map((r) => r.event)).toEqual(['claimed', 'skipped'])

    const duplicate = await runAutonomousWake(
      cfg,
      task(),
      async () => {
        runs += 1
      },
      at + 30_000,
    )
    expect(duplicate.status).toBe('duplicate')
    expect(runs).toBe(0)
  })

  it('a later minute is a new claim after an earlier completed slot', async () => {
    const at = Date.parse('2026-09-04T23:17:00Z')
    let runs = 0

    await runAutonomousWake(
      cfg,
      task(),
      async () => {
        runs += 1
      },
      at,
    )
    const later = await runAutonomousWake(
      cfg,
      task(),
      async () => {
        runs += 1
      },
      at + 60_000,
    )

    expect(later.status).toBe('completed')
    expect(runs).toBe(2)
    expect(wakeSlotKey(cfg.timezone, at)).not.toBe(wakeSlotKey(cfg.timezone, at + 60_000))
  })
})

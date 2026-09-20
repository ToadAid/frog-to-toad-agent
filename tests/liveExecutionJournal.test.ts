import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  enforceLiveExecutionJournalAtBoot,
  liveExecutionJournalPath,
  markLiveExecutionAccounted,
  markLiveExecutionAmbiguous,
  prepareLiveExecution,
  readLiveExecutionJournal,
} from '../src/safety/liveExecutionJournal.js'

let dir = ''
let cfg: Config

const SAVED = {
  TRADING_DESK_DIR: process.env['TRADING_DESK_DIR'],
  SELFTEST: process.env['SELFTEST'],
  DRY_RUN: process.env['DRY_RUN'],
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-live-execution-journal-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  // Load through the normal safe config path first. This unit suite tests the
  // live-execution journal primitive, not the external-wallet boot contract.
  // Flip only the in-memory Config afterward so production live-mode
  // validation remains fully authoritative and untouched.
  process.env['DRY_RUN'] = 'true'
  cfg = { ...loadConfig(), dryRun: false }
})

beforeEach(() => {
  fs.rmSync(liveExecutionJournalPath(cfg), { force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'desk_state.json'), { force: true })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function intent(runId: string) {
  return {
    runId,
    fromSymbol: 'USDC',
    toSymbol: 'ETH',
    fromAmount: 5,
  }
}

describe('D1-P8 durable live-execution ambiguity journal', () => {
  it('classifies a durable PREPARED receipt without ACCOUNTED as unresolved', () => {
    const prepared = prepareLiveExecution(cfg, intent('unresolved'), 1000)
    const report = readLiveExecutionJournal(cfg)

    expect(report.ok).toBe(true)
    expect(report.unresolved).toHaveLength(1)
    expect(report.unresolved[0]).toMatchObject({
      executionId: prepared.executionId,
      prepared: {
        event: 'prepared',
        at: 1000,
        intent: { runId: 'unresolved' },
      },
    })
  })

  it('resolves an execution only after ACCOUNTED is durable', () => {
    const prepared = prepareLiveExecution(cfg, intent('accounted'), 1000)
    markLiveExecutionAccounted(cfg, prepared.executionId, '0xtx', 2000)

    const report = readLiveExecutionJournal(cfg)
    expect(report.ok).toBe(true)
    expect(report.unresolved).toEqual([])
  })

  it('keeps an AMBIGUOUS annotation unresolved until a later accounting ceremony', () => {
    const prepared = prepareLiveExecution(cfg, intent('ambiguous'), 1000)
    markLiveExecutionAmbiguous(
      cfg,
      prepared.executionId,
      'wallet call outcome unknown',
      '0xmaybe',
      1500,
    )

    const report = readLiveExecutionJournal(cfg)
    expect(report.ok).toBe(true)
    expect(report.unresolved).toHaveLength(1)
    expect(report.unresolved[0]?.ambiguous).toMatchObject({
      event: 'ambiguous',
      reason: 'wallet call outcome unknown',
      txHash: '0xmaybe',
    })
  })

  it('fails closed on corrupt or structurally invalid journal evidence', () => {
    const file = liveExecutionJournalPath(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ event: 'prepared', executionId: 'missing-intent', at: 1, pid: 1 }),
        '{broken',
        '',
      ].join('\n'),
    )

    const report = readLiveExecutionJournal(cfg)
    expect(report.ok).toBe(false)
    expect(report.invalidEntries).toBe(1)
    expect(report.corruptLines).toBe(1)
  })

  it('boot classifier HALTs on unresolved execution and never invents a repair', () => {
    const prepared = prepareLiveExecution(cfg, intent('boot-halt'), 1000)
    const reasons: string[] = []

    const report = enforceLiveExecutionJournalAtBoot(cfg, {
      halt: (reason) => reasons.push(reason),
    })

    expect(report.halted).toBe(true)
    expect(report.unresolved.map((state) => state.executionId)).toEqual([
      prepared.executionId,
    ])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('1 unresolved live execution')
  })

  it('boot classifier stays open when every prepared execution is accounted', () => {
    const prepared = prepareLiveExecution(cfg, intent('boot-clean'), 1000)
    markLiveExecutionAccounted(cfg, prepared.executionId, '0xtx', 2000)

    const reasons: string[] = []
    const report = enforceLiveExecutionJournalAtBoot(cfg, {
      halt: (reason) => reasons.push(reason),
    })

    expect(report.halted).toBe(false)
    expect(report.unresolved).toEqual([])
    expect(reasons).toEqual([])
  })

  it('refuses PREPARED journal creation in dry-run mode', () => {
    const dryCfg = { ...cfg, dryRun: true }
    expect(() => prepareLiveExecution(dryCfg, intent('dry-refused'))).toThrow(
      'LIVE_EXECUTION_JOURNAL_DRY_RUN_REFUSED',
    )
  })
})

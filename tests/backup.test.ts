import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { rotateBackup, rotateStateBackups, BACKUP_GENERATIONS } from '../src/store/backup.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-backup-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  fs.rmSync(cfg.paths.dataDir, { recursive: true, force: true })
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true })
})

function writeLedger(content: string): void {
  fs.writeFileSync(path.join(cfg.paths.dataDir, 'ledger.jsonl'), content, 'utf8')
}

describe('rotating state backups (Nautilus cache-snapshot steal)', () => {
  it('missing source is a no-op', () => {
    expect(rotateBackup(cfg, 'ledger.jsonl')).toBeUndefined()
  })

  it('first rotation copies current → .1 byte-identical', () => {
    writeLedger('{"ts":1}\n')
    const out = rotateBackup(cfg, 'ledger.jsonl')
    expect(out).toBeDefined()
    expect(fs.readFileSync(out!, 'utf8')).toBe('{"ts":1}\n')
  })

  it('a changed file shifts generations: current→.1, old .1→.2', () => {
    writeLedger('gen-A\n')
    rotateBackup(cfg, 'ledger.jsonl')
    writeLedger('gen-B\n')
    rotateBackup(cfg, 'ledger.jsonl')
    const backups = path.join(cfg.paths.dataDir, 'backups')
    expect(fs.readFileSync(path.join(backups, 'ledger.jsonl.1'), 'utf8')).toBe('gen-B\n')
    expect(fs.readFileSync(path.join(backups, 'ledger.jsonl.2'), 'utf8')).toBe('gen-A\n')
  })

  it('unchanged file consumes NO generation', () => {
    writeLedger('same\n')
    rotateBackup(cfg, 'ledger.jsonl')
    rotateBackup(cfg, 'ledger.jsonl')
    rotateBackup(cfg, 'ledger.jsonl')
    const backups = path.join(cfg.paths.dataDir, 'backups')
    expect(fs.existsSync(path.join(backups, 'ledger.jsonl.2'))).toBe(false)
  })

  it('generations cap at maxGenerations — the oldest falls off', () => {
    for (const gen of ['A\n', 'B\n', 'C\n', 'D\n']) {
      writeLedger(gen)
      rotateBackup(cfg, 'ledger.jsonl', 3)
    }
    const backups = path.join(cfg.paths.dataDir, 'backups')
    expect(fs.readFileSync(path.join(backups, 'ledger.jsonl.1'), 'utf8')).toBe('D\n')
    expect(fs.readFileSync(path.join(backups, 'ledger.jsonl.2'), 'utf8')).toBe('C\n')
    expect(fs.readFileSync(path.join(backups, 'ledger.jsonl.3'), 'utf8')).toBe('B\n')
    expect(fs.existsSync(path.join(backups, 'ledger.jsonl.4'))).toBe(false) // A fell off
    expect(BACKUP_GENERATIONS).toBeGreaterThanOrEqual(3)
  })

  it('corrupt CURRENT file is not healed here — but its predecessor survives', () => {
    // The whole point: a truncated write to the live file still leaves .1 good.
    writeLedger('good generation\n')
    rotateBackup(cfg, 'ledger.jsonl')
    writeLedger('{"ts": "trunc') // simulated bad write
    rotateBackup(cfg, 'ledger.jsonl') // rotates the bad file too — but .2 still holds 'good'
    const backups = path.join(cfg.paths.dataDir, 'backups')
    expect(fs.readFileSync(path.join(backups, 'ledger.jsonl.2'), 'utf8')).toBe('good generation\n')
  })

  it('rotateStateBackups covers both unrecoverable-loss files', () => {
    writeLedger('L\n')
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'desk_state.json'), '{"state":"HALTED"}', 'utf8')
    const kept = rotateStateBackups(cfg)
    expect(kept).toHaveLength(2)
    expect(kept.some((p) => p.endsWith('ledger.jsonl.1'))).toBe(true)
    expect(kept.some((p) => p.endsWith('desk_state.json.1'))).toBe(true)
  })

  it('a backup failure never takes the desk down (no throw)', () => {
    // dataDir is a FILE here — mkdir fails; rotateBackup must swallow it.
    const cfgBad = { ...cfg, paths: { ...cfg.paths, dataDir: path.join(dir, 'not-a-dir') } }
    fs.writeFileSync(path.join(dir, 'not-a-dir'), 'x', 'utf8')
    expect(() => rotateBackup(cfgBad, 'ledger.jsonl')).not.toThrow()
  })
})
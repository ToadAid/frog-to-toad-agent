// Memory staleness (mother-repo memoryAge.ts port): models are poor at date
// arithmetic — "47 days ago" triggers staleness reasoning a bare mtime never
// will. A stale memory citing file:line reads as MORE authoritative, not
// less, so memory_read ages the read.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { memoryReadTool } from '../src/tools/memory.js'
import { memoryAgeDays, memoryAge, memoryFreshnessText } from '../src/memory/age.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-memory-age-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const DAY_MS = 86_400_000

describe('memoryAge (pure)', () => {
  it('floors days elapsed: 0 today, 1 yesterday, 2+ older', () => {
    const now = Date.now()
    // Margins of a minute around each boundary — a GC pause must never
    // decide a boundary case.
    expect(memoryAgeDays(now)).toBe(0)
    expect(memoryAgeDays(now - 1)).toBe(0)
    expect(memoryAgeDays(now - DAY_MS + 60_000)).toBe(0)
    expect(memoryAgeDays(now - DAY_MS - 60_000)).toBe(1)
    expect(memoryAgeDays(now - 47 * DAY_MS)).toBe(47)
  })

  it('clamps negative inputs (future mtime, clock skew) to 0', () => {
    expect(memoryAgeDays(Date.now() + 5 * DAY_MS)).toBe(0)
  })

  it('renders human-readable ages', () => {
    const now = Date.now()
    expect(memoryAge(now)).toBe('today')
    expect(memoryAge(now - DAY_MS)).toBe('yesterday')
    expect(memoryAge(now - 47 * DAY_MS)).toBe('47 days ago')
  })

  it('freshness text stays silent for fresh memories (≤1 day) — warning there is noise', () => {
    const now = Date.now()
    expect(memoryFreshnessText(now)).toBe('')
    expect(memoryFreshnessText(now - DAY_MS)).toBe('')
    expect(memoryFreshnessText(now - 2 * DAY_MS)).toContain('2 days old')
    expect(memoryFreshnessText(now - 2 * DAY_MS)).toContain('point-in-time observations')
    expect(memoryFreshnessText(now - 2 * DAY_MS)).toContain('Verify against current state')
  })
})

describe('memory_read staleness note', () => {
  const agent = { name: 'orchestrator' }
  type Ctx = Parameters<typeof memoryReadTool.execute>[1]
  const ctxFor = (): Ctx => ({ cfg, agent }) as unknown as Ctx
  const file = (): string => path.join(cfg.paths.dataDir, 'memory', 'orchestrator.md')

  function backdateDays(days: number): void {
    // fs.utimesSync takes SECONDS (or Dates) — raw ms lands centuries away.
    const old = new Date(Date.now() - days * DAY_MS)
    fs.utimesSync(file(), old, old)
  }

  it('a stale memory file is read WITH a freshness note', async () => {
    fs.mkdirSync(path.join(cfg.paths.dataDir, 'memory'), { recursive: true })
    fs.writeFileSync(file(), 'BTC broke the 0.618 level on 2026-08-01.')
    backdateDays(47)
    const res = await memoryReadTool.execute({}, ctxFor())
    expect(res.text.startsWith('[memory freshness]')).toBe(true)
    expect(res.text).toContain('47 days old')
    expect(res.text).toContain('BTC broke the 0.618 level')
  })

  it('a fresh memory file is read bare — no noise', async () => {
    fs.writeFileSync(file(), 'fresh observation')
    const res = await memoryReadTool.execute({}, ctxFor())
    expect(res.text).toBe('fresh observation')
  })

  it('yesterday-old is still fresh; 2 days old is not', async () => {
    fs.writeFileSync(file(), 'x')
    backdateDays(1)
    expect((await memoryReadTool.execute({}, ctxFor())).text).toBe('x')
    backdateDays(2)
    expect((await memoryReadTool.execute({}, ctxFor())).text.startsWith('[memory freshness]')).toBe(true)
  })

  it('an empty or missing memory file is unchanged', async () => {
    fs.writeFileSync(file(), '   ')
    expect((await memoryReadTool.execute({}, ctxFor())).text).toBe('(memory empty)')
    fs.rmSync(file())
    expect((await memoryReadTool.execute({}, ctxFor())).text).toBe('(memory is empty)')
  })

  it('RENAME RACE: freshness describes the OPENED generation, not the pathname', async () => {
    // The desk writer lands new bytes with temp+rename. If read and stat
    // were two separate path operations, old bytes could be qualified by a
    // NEW file's fresh mtime. Production reads and fstats ONE descriptor —
    // so the pathname may be replaced mid-read without corrupting the note.
    fs.writeFileSync(file(), 'old observation')
    backdateDays(47)
    const realFstat = fs.fstatSync.bind(fs)
    // Seam: after the bytes were read, BEFORE freshness is obtained, the
    // writer's rename lands on the canonical path.
    const spy = vi.spyOn(fs, 'fstatSync').mockImplementation((fd: number, opts?: object) => {
      const tmp = `${file()}.tmp-race`
      fs.writeFileSync(tmp, 'brand new observation')
      fs.renameSync(tmp, file())
      return realFstat(fd, opts)
    })
    try {
      const res = await memoryReadTool.execute({}, ctxFor())
      expect(res.text).toContain('old observation')
      expect(res.text).toContain('[memory freshness]')
      expect(res.text).toContain('47 days old')
      expect(res.text).not.toContain('brand new observation')
    } finally {
      spy.mockRestore()
    }
  })

  it('FSTAT FAILURE AFTER READ: advisory evidence fails open — bare memory, never invented emptiness', async () => {
    fs.writeFileSync(file(), 'durable known-good observation')
    const spy = vi.spyOn(fs, 'fstatSync').mockImplementation(() => {
      throw new Error('fstat down')
    })
    try {
      const res = await memoryReadTool.execute({}, ctxFor())
      expect(res.text).toBe('durable known-good observation')
      expect(res.text).not.toContain('[memory freshness]')
      expect(res.text).not.toBe('(memory is empty)')
    } finally {
      spy.mockRestore()
    }
  })

  it('the descriptor is closed on success AND on fstat failure', async () => {
    const realClose = fs.closeSync.bind(fs)
    const closed: number[] = []
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      closed.push(fd)
      return realClose(fd)
    })
    const realFstat = fs.fstatSync.bind(fs)
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((fd: number, opts?: object) => realFstat(fd, opts))
    try {
      fs.writeFileSync(file(), 'success path content')
      await memoryReadTool.execute({}, ctxFor())
      expect(closed.length).toBeGreaterThanOrEqual(1)

      fstatSpy.mockImplementation(() => {
        throw new Error('fstat down')
      })
      closed.length = 0
      fs.writeFileSync(file(), 'failure path content')
      await memoryReadTool.execute({}, ctxFor())
      expect(closed.length).toBeGreaterThanOrEqual(1)
    } finally {
      fstatSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })
})
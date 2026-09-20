// Store migrations (mother-repo migrationVersion pattern): version stamp
// lives inside the doc, skip-when-current fast path, pure-read ladder, and
// the write half stamps + commits atomically.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NewerStoreVersionError, readStoreMigrated, writeStoreDoc, MIGRATION_VERSION_KEY } from '../src/store/migrations.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-migrations-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const file = (name = 'store.json'): string => path.join(dir, name)

type Doc = { value: string; count: number; migratedV2?: boolean; migratedV3?: boolean; [MIGRATION_VERSION_KEY]?: number }

function ladder3(): { opts: Parameters<typeof readStoreMigrated<Doc>>[0]; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    opts: {
      file: file(),
      current: 3,
      init: () => ({ value: 'fresh', count: 0 }),
      migrations: [
        // v0 → 1: the pre-versioning era — coerce a legacy count and mark it
        { to: 1, apply: (doc) => (calls.push(1), { ...doc, count: Number.isFinite(doc.count) ? doc.count : 0 }) },
        { to: 2, apply: (doc) => (calls.push(2), { ...doc, migratedV2: true }) },
        { to: 3, apply: (doc) => (calls.push(3), { ...doc, migratedV3: true }) },
      ],
    },
  }
}

function readDoc(overrides?: Partial<Parameters<typeof readStoreMigrated<Doc>>[0]>) {
  return readStoreMigrated<Doc>({ ...ladder3().opts, ...overrides })
}

describe('readStoreMigrated', () => {
  it('a missing file yields the init doc STAMPED CURRENT in memory, writing NOTHING', () => {
    const { doc, status } = readDoc()
    expect(status).toBe('created')
    // shaped-at-current means the object SAYS current, not merely that the
    // TypeScript author believes it is current
    expect(doc).toEqual({ value: 'fresh', count: 0, [MIGRATION_VERSION_KEY]: 3 })
    expect(fs.existsSync(file())).toBe(false) // pure read — no file, no temp
  })

  it('a stamped-current doc takes the fast path: parsed as-is, ladder not walked', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'live', count: 7, [MIGRATION_VERSION_KEY]: 3 }))
    const { opts, calls } = ladder3()
    const { doc, status } = readStoreMigrated<Doc>(opts)
    expect(status).toBe('current')
    // the stamp is a real field of the doc — it comes back with the bytes
    expect(doc).toEqual({ value: 'live', count: 7, [MIGRATION_VERSION_KEY]: 3 })
    expect(calls).toEqual([]) // skip-when-current — the mother's whole point
  })

  it('an unstamped (version 0) doc walks the full ladder IN MEMORY, in order', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'legacy', count: 2 }))
    const { opts, calls } = ladder3()
    const { doc, status } = readStoreMigrated<Doc>(opts)
    expect(status).toBe('migrated')
    expect(calls).toEqual([1, 2, 3]) // ascending, one rung at a time, from 0
    expect(doc.migratedV2).toBe(true)
    expect(doc.migratedV3).toBe(true)
    // the returned document describes itself as current — the old (absent)
    // stamp never survives the ladder
    expect(doc[MIGRATION_VERSION_KEY]).toBe(3)
    // and the file on disk is EXACTLY unstamped — bytes upgrade on the next write
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ value: 'legacy', count: 2 })
    expect(fs.readFileSync(file(), 'utf8')).not.toContain(MIGRATION_VERSION_KEY)
  })

  it('a partially-stamped doc resumes from its stamp and ADVANCES the in-memory stamp', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'mid', count: 1, migratedV2: true, [MIGRATION_VERSION_KEY]: 2 }))
    const { doc, status } = readDoc()
    expect(status).toBe('migrated')
    expect(doc.migratedV2).toBe(true) // preserved, not re-derived
    expect(doc.migratedV3).toBe(true)
    expect(doc[MIGRATION_VERSION_KEY]).toBe(3) // not 2 — the stamp advanced
    // disk remains at 2 until an explicit writeStoreDoc materializes it
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))[MIGRATION_VERSION_KEY]).toBe(2)
  })

  it('FAILS CLOSED on a doc stamped by a newer desk — typed refusal', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'future', count: 0, [MIGRATION_VERSION_KEY]: 4 }))
    expect(() => readDoc()).toThrow(NewerStoreVersionError)
    expect(() => readDoc()).toThrow(/NEWER desk/)
  })

  it('FAILS CLOSED on corrupt JSON and on a non-object doc', () => {
    fs.writeFileSync(file(), '{not json')
    expect(() => readDoc()).toThrow(/not valid JSON/)
    fs.writeFileSync(file(), '[1,2,3]')
    expect(() => readDoc()).toThrow(/not a JSON object/)
    fs.writeFileSync(file(), 'null')
    expect(() => readDoc()).toThrow(/not a JSON object/)
  })

  it('FAILS CLOSED on a malformed stamp', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'x', count: 0, [MIGRATION_VERSION_KEY]: 'two' }))
    expect(() => readDoc()).toThrow(/malformed/)
  })

  it('FAILS CLOSED when the ladder has a hole — a silent version skip is a bug', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'gapped', count: 0 }))
    expect(() => readDoc({ current: 3, migrations: [{ to: 3, apply: (d) => d }] })).toThrow(/no migration reaches version 1/)
  })

  it('refuses a malformed ladder at definition time', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'x', count: 0 }))
    expect(() => readDoc({ migrations: [{ to: 0, apply: (d) => d }] })).toThrow(/outside 1..3/)
    expect(() => readDoc({ migrations: [{ to: 2, apply: (d) => d }, { to: 2, apply: (d) => d }] })).toThrow(/ascend strictly/)
  })

  it('re-throws non-ENOENT read failures (permission, EISDIR)', () => {
    fs.mkdirSync(file())
    expect(() => readDoc()).toThrow()
  })
})

describe('writeStoreDoc', () => {
  it('stamps the doc at current version and lands it atomically', () => {
    writeStoreDoc<Doc>(file(), { value: 'done', count: 9 }, 3)
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'))
    expect(onDisk).toEqual({ value: 'done', count: 9, [MIGRATION_VERSION_KEY]: 3 })
    // temp+rename: nothing transient survives the commit
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
    // and the round trip takes the fast path
    expect(readDoc().status).toBe('current')
  })

  it('a write AFTER a migrated read materializes the ladder — one-shot upgrade', () => {
    fs.writeFileSync(file(), JSON.stringify({ value: 'legacy', count: 2 }))
    const { doc } = readDoc()
    expect(doc.migratedV3).toBe(true)
    writeStoreDoc<Doc>(file(), doc, 3)
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))[MIGRATION_VERSION_KEY]).toBe(3)
  })

  it('WRITE BARRIER: refuses to down-version a well-formed document stamped by a newer desk', () => {
    const futureBytes = JSON.stringify({
      value: 'future',
      count: 99,
      newField: 'preserve-me',
      [MIGRATION_VERSION_KEY]: 4,
    })
    fs.writeFileSync(file(), futureBytes)
    expect(() => writeStoreDoc<Doc>(file(), { value: 'old', count: 1 }, 3)).toThrow(NewerStoreVersionError)
    // byte-for-byte unchanged — no mutation, no torn rewrite
    expect(fs.readFileSync(file(), 'utf8')).toBe(futureBytes)
    // no mkdir/temp/rename side effects survive the refusal
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('the write barrier engages on well-formed future stamps ONLY — corrupt and malformed bytes still write normally', () => {
    fs.writeFileSync(file(), '{torn')
    expect(() => writeStoreDoc<Doc>(file(), { value: 'w', count: 0 }, 3)).not.toThrow() // corruption is not a barrier
    fs.writeFileSync(file(), JSON.stringify({ value: 'x', count: 0, [MIGRATION_VERSION_KEY]: 'two' }))
    expect(() => writeStoreDoc<Doc>(file(), { value: 'w', count: 0 }, 3)).not.toThrow() // malformed stamp is not a barrier
    fs.writeFileSync(file(), '[1,2,3]')
    expect(() => writeStoreDoc<Doc>(file(), { value: 'w', count: 0 }, 3)).not.toThrow() // non-object is not a barrier
  })
})
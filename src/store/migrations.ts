/**
 * Store migrations (mother-repo migrationVersion pattern, src/utils/config.ts
 * ~580: a version stamp on the store; when the stamp equals CURRENT, every
 * migration is skipped without touching the file).
 *
 * Desk shape — two halves, deliberately split:
 *  - readStoreMigrated(): a PURE READ. It applies the migration ladder in
 *    memory and never writes. Bytes upgrade when the store's own writer next
 *    runs (lazy materialization), so a version-aware read of a gated or
 *    advisory store cannot mutate the disk behind a caller's back.
 *  - writeStoreDoc(): the write half. Stamps the doc at `current` and lands
 *    it with a temp+rename in the store's own directory — the atomic-commit
 *    pattern the dream lease already proved.
 *
 * Laws:
 *  - The version belongs to the document returned, not merely the bytes on
 *    disk: `migrationVersion` lives INSIDE the store's JSON, and a
 *    created/migrated result describes itself as current (stamped in memory,
 *    never on disk — the pure read writes nothing).
 *  - Skip-when-current: a stamped-current doc is returned as parsed — no
 *    migration ladder walk, no write. This is the mother's whole point.
 *  - A doc with no stamp is version 0 (pre-versioning bytes, e.g. legacy
 *    desk stores) and walks the full ladder.
 *  - Fail closed on the future: a doc stamped NEWER than `current` was
 *    written by a newer desk. Refusing to guess is the only safe move.
 *  - READ FALLBACK IS NOT WRITE AUTHORITY: writeStoreDoc refuses (typed
 *    NewerStoreVersionError, before any byte moves) to down-version a
 *    well-formed document stamped by a newer desk. Corruption engages no
 *    barrier — the writer's behavior on malformed bytes is unchanged.
 *  - Fail closed on corruption at read time: unparsable JSON or a non-object
 *    doc throws — recreating bytes by default is how data loss gets called
 *    "repair".
 *  - Migrations are ordered, one step each (`to` = target version), and must
 *    be idempotent: the read path may re-run a step on every read of an
 *    unstamped doc until a write materializes the stamp.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const MIGRATION_VERSION_KEY = 'migrationVersion'

/** One rung of the ladder: bring a doc from version `to - 1` to `to`. */
export type StoreMigration<T> = {
  to: number
  apply: (doc: T) => T
}

export type MigrationStatus = 'created' | 'current' | 'migrated'

/** A store document declares itself newer than this desk understands.
 * Read fallback is not write authority: the older desk may interpret
 * conservatively, but it may never knowingly down-version newer bytes. */
export class NewerStoreVersionError extends Error {
  constructor(
    readonly file: string,
    readonly foundVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `migration runner: ${file} was written by a NEWER desk ` +
      `(migrationVersion ${foundVersion} > ${currentVersion}) — refusing to guess`,
    )
    this.name = 'NewerStoreVersionError'
  }
}

export type MigratedStore<T> = {
  doc: T
  /** created = file absent (init() doc, nothing written); current = stamped
   * fast path; migrated = ladder applied in memory only. */
  status: MigrationStatus
}

export type ReadStoreOptions<T> = {
  file: string
  /** The store's current schema version. */
  current: number
  /** Doc for a missing file, shaped at `current`. */
  init: () => T
  /** Ascending ladder. Each `to` must be an integer in 1..current. */
  migrations: ReadonlyArray<StoreMigration<T>>
}

function validateLadder<T>(migrations: ReadonlyArray<StoreMigration<T>>, current: number): void {
  let prev = 0
  for (const m of migrations) {
    if (!Number.isInteger(m.to) || m.to < 1 || m.to > current) {
      throw new Error(`migration ladder: step ${m.to} is outside 1..${current}`)
    }
    if (m.to <= prev) {
      throw new Error(`migration ladder: steps must ascend strictly (saw ${prev} then ${m.to})`)
    }
    prev = m.to
  }
}

/** The stamp belongs to the document returned, not merely the bytes on disk:
 * if the runner says the result is at current schema, the object itself says
 * so. In-memory only — the pure read never touches the file. */
function stampCurrent<T extends object>(doc: T, current: number): T {
  return { ...doc, [MIGRATION_VERSION_KEY]: current } as T
}

/** Pure-read migration. Applies the ladder in memory; NEVER writes. */
export function readStoreMigrated<T extends object>(opts: ReadStoreOptions<T>): MigratedStore<T> {
  const { file, current, init, migrations } = opts
  if (!Number.isInteger(current) || current < 1) {
    throw new Error(`migration runner: current version must be a positive integer, got ${current}`)
  }
  validateLadder(migrations, current)

  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { doc: stampCurrent(init(), current), status: 'created' }
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`migration runner: ${file} is not valid JSON — repair or remove it by hand`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`migration runner: ${file} is not a JSON object`)
  }

  const doc = parsed as T & { [MIGRATION_VERSION_KEY]?: unknown }
  const stamp = doc[MIGRATION_VERSION_KEY]
  if (stamp !== undefined) {
    if (typeof stamp !== 'number' || !Number.isInteger(stamp) || stamp < 0) {
      throw new Error(`migration runner: ${file} has a malformed ${MIGRATION_VERSION_KEY}`)
    }
    if (stamp > current) {
      throw new NewerStoreVersionError(file, stamp, current)
    }
    if (stamp === current) {
      return { doc: doc as T, status: 'current' }
    }
  }
  const from = stamp === undefined ? 0 : stamp

  // Walk the ladder one rung at a time. A missing rung is a bug in the
  // store's own definition — throw rather than silently skip versions.
  let migrated: T = doc as T
  for (let step = from + 1; step <= current; step++) {
    const rung = migrations.find((m) => m.to === step)
    if (rung === undefined) {
      throw new Error(`migration runner: ${file} is at version ${from} but no migration reaches version ${step}`)
    }
    migrated = rung.apply(migrated)
  }
  // The old stamp must never survive the returned document — a migrated doc
  // describes itself as current, even though the disk still holds old bytes.
  return { doc: stampCurrent(migrated, current), status: 'migrated' }
}

/** The future-version write barrier. Returns the stamp when the EXISTING
 * file is a well-formed document stamped by a newer desk; undefined when the
 * file is absent, unreadable, corrupt, non-object, or carries no valid
 * newer-than-current stamp. Corruption engages no barrier — the writer's
 * behavior on malformed pre-existing bytes is unchanged. */
function futureVersionStamp(file: string, current: number): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const stamp = (parsed as Record<string, unknown>)[MIGRATION_VERSION_KEY]
  if (typeof stamp !== 'number' || !Number.isInteger(stamp) || stamp < 0) return undefined
  return stamp > current ? stamp : undefined
}

/** Write half: stamp at `current` and commit atomically (temp + rename in
 * the store's own directory, so a crash can never leave a torn doc).
 * BARRIER: a well-formed existing doc stamped by a NEWER desk is refused
 * before any byte moves — no mkdir, no temp, no rename. Read fallback is
 * not write authority. */
export function writeStoreDoc<T extends object>(file: string, doc: T, current: number): void {
  if (!Number.isInteger(current) || current < 1) {
    throw new Error(`migration runner: current version must be a positive integer, got ${current}`)
  }
  const future = futureVersionStamp(file, current)
  if (future !== undefined) {
    throw new NewerStoreVersionError(file, future, current)
  }
  const stamped = stampCurrent(doc, current)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(stamped))
  fs.renameSync(tmp, file)
}
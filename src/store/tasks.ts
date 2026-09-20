import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import { sleep } from '../http.js'

/**
 * Shared task list (the coder-repo tasks.ts pattern, desk-native) — one
 * durable, file-backed task board under data/tasks/ that any hand can read
 * and any WRITING hand can claim from. This is the wiring lane's backbone:
 * multi-step trading workflows get dependency order, and every hand can see
 * what the desk is working on (write grants live in agents/*.md).
 *
 * Shape (per-task JSON files + a high-water-mark so IDs are NEVER reused):
 *   data/tasks/<id>.json        one task per file
 *   data/tasks/.highwatermark   max id ever assigned (survives deletes)
 *   data/tasks/.lock            O_EXCL claim lock (cross-process honesty)
 *
 * Laws (carried from the mother port and the desk's own cuts):
 *  - ONE list lock for every mutation — claim decisions (already_claimed /
 *    blocked / agent_busy) are atomic with the write; no TOCTOU.
 *  - Locks are O_EXCL creates with an ownership token; a stale or malformed
 *    lock is fail-closed with a helpful message (the dream-lease law: stale
 *    is not permission to steal).
 *  - A corrupt or unreadable task file is REFUSED, never silently skipped,
 *    wherever it would poison a decision (claim's blocker check reads every
 *    task — an unevaluable board never yields a claim).
 *  - blocks/blockedBy are twin edges — always written together, always
 *    cleaned together on delete.
 *  - Deleting a task bumps the high-water-mark before unlink: the id is
 *    retired even if the process dies mid-delete.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

export type Task = {
  id: string
  subject: string
  description: string
  /** Present-continuous form for progress rendering (e.g. "Running tests"). */
  activeForm?: string
  /** Claiming agent (agents/*.md `name`) — set ONLY via claimTask's atomic path. */
  owner?: string
  status: TaskStatus
  /** Tasks this task blocks / is blocked by — twin edges, kept in sync. */
  blocks: string[]
  blockedBy: string[]
  /** Free-form coordinate data for the wiring lane (bounded, serialized). */
  metadata?: Record<string, unknown>
}

export type CreateTaskInput = {
  subject: string
  description: string
  activeForm?: string
  /** IDs that must complete before this task can be claimed. */
  blockedBy?: string[]
  metadata?: Record<string, unknown>
}

export type UpdateTaskInput = {
  subject?: string
  description?: string
  activeForm?: string
  status?: TaskStatus
  metadata?: Record<string, unknown>
  addBlockedBy?: string[]
  removeBlockedBy?: string[]
}

export type ClaimTaskResult = {
  success: boolean
  reason?: 'task_not_found' | 'already_claimed' | 'already_resolved' | 'blocked' | 'agent_busy'
  task?: Task
  /** Blocker ids still unresolved (when reason is 'blocked'). */
  blockedByTasks?: string[]
  /** Open task ids the claimant already owns (when reason is 'agent_busy'). */
  busyWithTasks?: string[]
}

export type UnassignResult = { agent: string; unassigned: string[] }

const METADATA_MAX_BYTES = 4096
const SUBJECT_MAX = 200
const DESCRIPTION_MAX = 8192
const TASK_ID = /^\d+$/

/** Lock budget: attempts × delay ≈ worst wait before fail-closed (env-tunable
 * for tests). The desk is one process — same-process callers serialize on the
 * single thread; the lock exists for cross-process honesty (lab driver). */
function lockAttempts(): number {
  return Math.max(1, Number(process.env['TASKS_LOCK_ATTEMPTS']) || 40)
}
function lockDelayMs(): number {
  return Math.max(1, Number(process.env['TASKS_LOCK_DELAY_MS']) || 25)
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as NodeJS.ErrnoException).code === 'string'
}

export function tasksDir(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'tasks')
}

function taskPath(cfg: Config, id: string): string {
  return path.join(tasksDir(cfg), `${id}.json`)
}

function highWaterMarkPath(cfg: Config): string {
  return path.join(tasksDir(cfg), '.highwatermark')
}

function lockPath(cfg: Config): string {
  return path.join(tasksDir(cfg), '.lock')
}

/** Atomic bounded write: bounded temp file in the same directory, then
 * rename — an interruption can never leave partial JSON at the real path. */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function readHighWaterMark(cfg: Config): number {
  let raw: string
  try {
    raw = fs.readFileSync(highWaterMarkPath(cfg), 'utf8').trim()
  } catch (e) {
    // ENOENT is the ONLY condition that maps to 0 — an absent mark is a fact.
    if (isErrnoException(e) && e.code === 'ENOENT') return 0
    throw new Error(`task high-water-mark unreadable: ${(e as Error).message}`)
  }
  // A PRESENT mark must prove itself: a malformed, negative, fractional, or
  // unsafe value could forget retired ids and allow reuse of deleted ids.
  // Fail closed with an honest integrity error — never guess, never
  // auto-"repair" (a wrong guess is id reuse).
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(
      `task high-water-mark integrity error: not valid JSON (${raw.slice(0, 60)}) — ` +
        'retired ids could be reused. Repair the mark FROM TRUSTED EVIDENCE (task files, transcripts, backups) — ' +
        'do NOT delete or reset it merely to make the store run; if the correct value cannot be proven, leave it and keep refusing.',
    )
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `task high-water-mark integrity error: expected a nonnegative integer, got ${raw.slice(0, 60)} — ` +
        'retired ids could be reused. Repair the mark FROM TRUSTED EVIDENCE (task files, transcripts, backups) — ' +
        'do NOT delete or reset it merely to make the store run; if the correct value cannot be proven, leave it and keep refusing.',
    )
  }
  return value
}

function writeHighWaterMark(cfg: Config, value: number): void {
  writeJsonAtomic(highWaterMarkPath(cfg), value) // plain number, JSON.stringify keeps it honest
}

/**
 * Validate a parsed task document from disk. Returns the error message when
 * the record is unusable — a wrong shape is a REFUSAL, never a skip: the
 * claim decision reads every task, and one malformed record must not quietly
 * become "no blockers".
 */
function validateTaskDoc(doc: unknown): string | undefined {
  if (typeof doc !== 'object' || doc === null) return 'not an object'
  const t = doc as Partial<Task>
  if (typeof t.id !== 'string' || !TASK_ID.test(t.id)) return 'bad id'
  if (typeof t.subject !== 'string') return 'bad subject'
  if (typeof t.description !== 'string') return 'bad description'
  if (!TASK_STATUSES.includes(t.status as TaskStatus)) return 'bad status'
  if (!Array.isArray(t.blocks) || !t.blocks.every((b) => typeof b === 'string' && TASK_ID.test(b))) {
    return 'bad blocks (references must be numeric task ids)'
  }
  if (!Array.isArray(t.blockedBy) || !t.blockedBy.every((b) => typeof b === 'string' && TASK_ID.test(b))) {
    return 'bad blockedBy (references must be numeric task ids)'
  }
  if (t.blocks.includes(t.id) || t.blockedBy.includes(t.id)) return 'a task cannot reference itself as a dependency'
  return undefined
}

/**
 * Board topology integrity — the FULL board must be evaluable before any
 * decision is made from it (claim, delete-cleanup, id assignment). Checked
 * after every file parses and passes per-file shape validation:
 *   - no colliding identity (two records claiming one id);
 *   - every dependency reference points to a task that EXISTS on the board;
 *   - twin edges are SYMMETRIC: A.blocks contains B <=> B.blockedBy contains A.
 * A board with missing/asymmetric/unevaluable topology refuses everything —
 * "skipped" is how twins drift and claims emerge from lies.
 */
function validateBoardIntegrity(board: Task[]): void {
  const byId = new Map<string, Task>()
  for (const t of board) {
    if (byId.has(t.id)) throw new Error(`task board integrity error: duplicate task id ${t.id}`)
    byId.set(t.id, t)
  }
  // Pass 1 — every dependency reference must EXIST on the board (checked for
  // the whole board before any symmetry judgment: a missing ref is the
  // primary fact).
  for (const t of board) {
    for (const ref of [...t.blocks, ...t.blockedBy]) {
      if (!byId.has(ref)) {
        throw new Error(`task board integrity error: task ${t.id} references missing task ${ref}`)
      }
    }
  }
  // Pass 2 — twin edges must be SYMMETRIC in both directions.
  for (const t of board) {
    for (const child of t.blocks) {
      if (!byId.get(child)!.blockedBy.includes(t.id)) {
        throw new Error(
          `task board integrity error: asymmetric twin edge — ${t.id}.blocks → ${child} but ${child}.blockedBy omits ${t.id}`,
        )
      }
    }
    for (const parent of t.blockedBy) {
      if (!byId.get(parent)!.blocks.includes(t.id)) {
        throw new Error(
          `task board integrity error: asymmetric twin edge — ${t.id}.blockedBy → ${parent} but ${parent}.blocks omits ${t.id}`,
        )
      }
    }
  }
}

/** ONE list lock around every mutation. O_EXCL create is the "who entered"
 * proof (EEXIST = held); the token identifies the holder so release can
 * prove ownership. A vanished or malformed lock at release is logged and
 * left alone — never steal what you cannot prove is yours. */
async function withTaskLock<T>(cfg: Config, fn: () => T): Promise<T> {
  const lock = lockPath(cfg)
  fs.mkdirSync(tasksDir(cfg), { recursive: true })
  const token = randomUUID()
  let acquired = false
  for (let attempt = 0; attempt < lockAttempts(); attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }))
      fs.closeSync(fd)
      acquired = true
      break
    } catch (e) {
      if (isErrnoException(e) && e.code === 'EEXIST') {
        await sleep(lockDelayMs())
        continue
      }
      throw new Error(`task lock could not be created: ${(e as Error).message}`)
    }
  }
  if (!acquired) {
    let age = ''
    try {
      const raw = JSON.parse(fs.readFileSync(lock, 'utf8') as string) as { at?: number }
      if (typeof raw?.at === 'number') age = `, held since ${new Date(raw.at).toISOString()}`
    } catch {
      age = ', contents unreadable'
    }
    throw new Error(
      `task list is busy — data/tasks/.lock is held${age}. ` +
        'If no other desk process is running, remove the lock file by hand (stale is not permission to steal).',
    )
  }
  try {
    return fn()
  } finally {
    try {
      const raw = JSON.parse(fs.readFileSync(lock, 'utf8') as string) as { token?: string }
      if (raw?.token === token) fs.rmSync(lock, { force: true })
      else logLockAnomaly('release skipped — lock changed hands mid-operation')
    } catch (e) {
      logLockAnomaly(`release skipped — ${(e as Error).message}`)
    }
  }
}

function logLockAnomaly(msg: string): void {
  // Lazy import avoided: log is cheap and side-effect-free.
  void import('../log.js').then(({ log }) => log.warn(`task lock: ${msg}`))
}

function readTaskUnsafe(cfg: Config, id: string): Task | undefined {
  if (!TASK_ID.test(id)) throw new Error(`not a task id: ${JSON.stringify(id)}`)
  let raw: string
  try {
    raw = fs.readFileSync(taskPath(cfg, id), 'utf8')
  } catch (e) {
    if (isErrnoException(e) && e.code === 'ENOENT') return undefined
    throw new Error(`task ${id} unreadable: ${(e as Error).message}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(`task ${id} is not valid JSON — refusing to guess (repair or remove data/tasks/${id}.json by hand): ${(e as Error).message}`)
  }
  const bad = validateTaskDoc(doc)
  if (bad) throw new Error(`task ${id} has the wrong shape (${bad}) — refusing to guess`)
  const task = doc as Task
  // Colliding identity: the file named <id>.json must BE task <id>. Anything
  // else is a board that cannot be evaluated honestly.
  if (task.id !== id) {
    throw new Error(`task board integrity error: file ${id}.json claims id ${task.id} — colliding identity, refusing to guess`)
  }
  return task
}

function writeTaskUnsafe(cfg: Config, task: Task): void {
  writeJsonAtomic(taskPath(cfg, task.id), task)
}

function listTaskIdsUnsafe(cfg: Config): string[] {
  let files: string[]
  try {
    files = fs.readdirSync(tasksDir(cfg))
  } catch (e) {
    if (isErrnoException(e) && e.code === 'ENOENT') return []
    throw new Error(`task directory unreadable: ${(e as Error).message}`)
  }
  return files
    .filter((f) => f.endsWith('.json') && TASK_ID.test(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => Number(a) - Number(b))
}

/**
 * Read the whole board and validate its topology. EVERY file must parse,
 * pass shape validation, and still exist when read — a corrupt, wrong-shape,
 * colliding, or mid-read-vanished record is a REFUSAL (fail closed), because
 * claim decisions and delete cascades read the full board and "skipped" is
 * how twins drift. Vanishing matters even though every mutation holds the
 * list lock: disappearance means the board changed OUTSIDE the proven
 * mutation path, and that is not a board to decide from.
 */
function readBoardUnsafe(cfg: Config): Task[] {
  const board: Task[] = []
  for (const id of listTaskIdsUnsafe(cfg)) {
    const t = readTaskUnsafe(cfg, id)
    if (!t) {
      throw new Error(
        `task board integrity error: task ${id} vanished during board read — ` +
          'the board changed outside the mutation path; refusing to evaluate',
      )
    }
    board.push(t)
  }
  validateBoardIntegrity(board)
  return board
}

function validateMetadata(metadata: Record<string, unknown> | undefined): void {
  if (metadata === undefined) return
  const size = Buffer.byteLength(JSON.stringify(metadata), 'utf8')
  if (size > METADATA_MAX_BYTES) {
    throw new Error(`task metadata too large: ${size} bytes (max ${METADATA_MAX_BYTES}) — coordinates belong in a file, not the board`)
  }
}

function nextTaskIdUnsafe(cfg: Config): string {
  const board = readBoardUnsafe(cfg)
  const maxOnDisk = board.reduce((m, t) => Math.max(m, Number(t.id)), 0)
  return String(Math.max(maxOnDisk, readHighWaterMark(cfg)) + 1)
}

export async function createTask(cfg: Config, input: CreateTaskInput): Promise<Task> {
  const subject = input.subject.trim()
  const description = input.description.trim()
  if (subject === '') throw new Error('task subject is required')
  if (subject.length > SUBJECT_MAX) throw new Error(`task subject too long (max ${SUBJECT_MAX})`)
  if (description === '') throw new Error('task description is required')
  if (description.length > DESCRIPTION_MAX) throw new Error(`task description too long (max ${DESCRIPTION_MAX})`)
  validateMetadata(input.metadata)
  return withTaskLock(cfg, () => {
    const id = nextTaskIdUnsafe(cfg)
    const blockedBy = [...new Set(input.blockedBy ?? [])]
    for (const ref of blockedBy) {
      if (!readTaskUnsafe(cfg, ref)) throw new Error(`blockedBy references a task that does not exist: ${ref}`)
      if (ref === id) throw new Error('a task cannot block itself')
    }
    const task: Task = {
      id,
      subject,
      description,
      ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
      status: 'pending',
      blocks: [],
      blockedBy,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    writeTaskUnsafe(cfg, task)
    // Twin edges: every referenced task learns it blocks this one.
    for (const ref of blockedBy) {
      const parent = readTaskUnsafe(cfg, ref)!
      if (!parent.blocks.includes(id)) writeTaskUnsafe(cfg, { ...parent, blocks: [...parent.blocks, id] })
    }
    return task
  })
}

export async function getTask(cfg: Config, id: string): Promise<Task | undefined> {
  return withTaskLock(cfg, () => readTaskUnsafe(cfg, id))
}

export async function listTasks(cfg: Config): Promise<Task[]> {
  return withTaskLock(cfg, () => readBoardUnsafe(cfg))
}

export async function updateTask(cfg: Config, id: string, updates: UpdateTaskInput): Promise<Task> {
  if (updates.subject !== undefined) {
    updates.subject = updates.subject.trim()
    if (updates.subject === '') throw new Error('task subject cannot be empty')
    if (updates.subject.length > SUBJECT_MAX) throw new Error(`task subject too long (max ${SUBJECT_MAX})`)
  }
  if (updates.description !== undefined) {
    updates.description = updates.description.trim()
    if (updates.description === '') throw new Error('task description cannot be empty')
    if (updates.description.length > DESCRIPTION_MAX) throw new Error(`task description too long (max ${DESCRIPTION_MAX})`)
  }
  if (updates.status !== undefined && !TASK_STATUSES.includes(updates.status)) {
    throw new Error(`invalid status: ${JSON.stringify(updates.status)}`)
  }
  validateMetadata(updates.metadata)
  return withTaskLock(cfg, () => {
    const existing = readTaskUnsafe(cfg, id)
    if (!existing) throw new Error(`task not found: ${id}`)
    const next: Task = { ...existing }
    if (updates.subject !== undefined) next.subject = updates.subject
    if (updates.description !== undefined) next.description = updates.description
    if (updates.activeForm !== undefined) next.activeForm = updates.activeForm
    if (updates.status !== undefined) next.status = updates.status
    if (updates.metadata !== undefined) next.metadata = updates.metadata

    // Twin-edge edits under the same lock — a blockedBy edit rewrites both
    // sides or neither.
    for (const ref of updates.addBlockedBy ?? []) {
      if (ref === id) throw new Error('a task cannot block itself')
      if (!readTaskUnsafe(cfg, ref)) throw new Error(`addBlockedBy references a task that does not exist: ${ref}`)
    }
    if (updates.addBlockedBy?.length || updates.removeBlockedBy?.length) {
      for (const ref of updates.addBlockedBy ?? []) {
        if (!next.blockedBy.includes(ref)) next.blockedBy.push(ref)
        const parent = readTaskUnsafe(cfg, ref)!
        if (!parent.blocks.includes(id)) writeTaskUnsafe(cfg, { ...parent, blocks: [...parent.blocks, id] })
      }
      for (const ref of updates.removeBlockedBy ?? []) {
        if (next.blockedBy.includes(ref)) next.blockedBy = next.blockedBy.filter((b) => b !== ref)
        const parent = readTaskUnsafe(cfg, ref)
        if (parent && parent.blocks.includes(id)) {
          writeTaskUnsafe(cfg, { ...parent, blocks: parent.blocks.filter((b) => b !== id) })
        }
      }
    }
    writeTaskUnsafe(cfg, next)
    return next
  })
}

/**
 * Atomic claim: the decision and the write happen under ONE lock, so two
 * hands can never both win. `checkAgentBusy` additionally refuses a claim
 * when the claimant already owns open tasks — one workflow per hand.
 */
export async function claimTask(
  cfg: Config,
  id: string,
  claimant: string,
  opts: { checkAgentBusy?: boolean } = {},
): Promise<ClaimTaskResult> {
  const claimantId = claimant.trim()
  if (claimantId === '') throw new Error('claimant identity is required')
  return withTaskLock(cfg, () => {
    const board = readBoardUnsafe(cfg) // full read: corrupt anywhere refuses below
    const task = board.find((t) => t.id === id)
    if (!task) return { success: false, reason: 'task_not_found' as const }
    if (task.owner && task.owner !== claimantId) {
      return { success: false, reason: 'already_claimed' as const, task }
    }
    if (task.status === 'completed') {
      return { success: false, reason: 'already_resolved' as const, task }
    }
    const unresolved = new Set(board.filter((t) => t.status !== 'completed').map((t) => t.id))
    const blockedByTasks = task.blockedBy.filter((b) => unresolved.has(b))
    if (blockedByTasks.length > 0) {
      return { success: false, reason: 'blocked' as const, task, blockedByTasks }
    }
    if (opts.checkAgentBusy) {
      const busyWithTasks = board
        .filter((t) => t.status !== 'completed' && t.owner === claimantId && t.id !== id)
        .map((t) => t.id)
      if (busyWithTasks.length > 0) {
        return { success: false, reason: 'agent_busy' as const, task, busyWithTasks }
      }
    }
    const updated: Task = { ...task, owner: claimantId }
    writeTaskUnsafe(cfg, updated)
    return { success: true, task: updated }
  })
}

/**
 * Delete a task. The board is read and VALIDATED BEFORE the unlink — the
 * twin cleanup runs from that proven snapshot, never from a re-read (which
 * would be a temporarily asymmetric board of our own making). The
 * high-water-mark is bumped BEFORE the unlink: an id is retired even if the
 * process dies mid-delete.
 */
export async function deleteTask(cfg: Config, id: string): Promise<boolean> {
  return withTaskLock(cfg, () => {
    const board = readBoardUnsafe(cfg) // the proven snapshot cleanup runs from
    const existing = board.find((t) => t.id === id)
    if (!existing) return false
    const mark = readHighWaterMark(cfg)
    if (Number(id) > mark) writeHighWaterMark(cfg, Number(id))
    fs.rmSync(taskPath(cfg, id), { force: true })
    for (const t of board) {
      if (t.id === id) continue
      const blocks = t.blocks.filter((b) => b !== id)
      const blockedBy = t.blockedBy.filter((b) => b !== id)
      if (blocks.length !== t.blocks.length || blockedBy.length !== t.blockedBy.length) {
        writeTaskUnsafe(cfg, { ...t, blocks, blockedBy })
      }
    }
    return true
  })
}

/**
 * Crash cleanup: strip the owner from every OPEN task a dead hand held.
 * Completed tasks keep their owner — that is the historical record of who
 * finished the work, not a lock.
 */
export async function unassignTasks(cfg: Config, agent: string): Promise<UnassignResult> {
  const agentId = agent.trim()
  if (agentId === '') throw new Error('agent identity is required')
  return withTaskLock(cfg, () => {
    const unassigned: string[] = []
    for (const t of readBoardUnsafe(cfg)) {
      if (t.owner !== agentId || t.status === 'completed') continue
      writeTaskUnsafe(cfg, { ...t, owner: undefined })
      unassigned.push(t.id)
    }
    return { agent: agentId, unassigned }
  })
}

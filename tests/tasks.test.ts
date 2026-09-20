// Shared task list — the laws the cut exists to enforce: atomic claim under
// ONE lock, never-reused ids (high-water-mark), twin-edge dependencies, and
// fail-closed reads (a corrupt board never yields a claim).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  createTask,
  claimTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  unassignTasks,
} from '../src/store/tasks.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-tasks-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  process.env['TASKS_LOCK_ATTEMPTS'] = '3'
  process.env['TASKS_LOCK_DELAY_MS'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function makeTask(subject = 'wire the sizer', blockedBy: string[] = []): Promise<string> {
  const t = await createTask(cfg, { subject, description: `${subject} — done means tests pass`, blockedBy })
  return t.id
}

describe('create + ids', () => {
  it('assigns sequential ids and reads back', async () => {
    const a = await createTask(cfg, { subject: 'first', description: 'd' })
    const b = await createTask(cfg, { subject: 'second', description: 'd' })
    expect(Number(b.id)).toBe(Number(a.id) + 1)
    expect(await getTask(cfg, a.id)).toMatchObject({ subject: 'first', status: 'pending' })
  })

  it('never reuses an id, even after deleting the newest task', async () => {
    const a = await createTask(cfg, { subject: 'a', description: 'd' })
    const b = await createTask(cfg, { subject: 'b', description: 'd' })
    expect(await deleteTask(cfg, b.id)).toBe(true)
    const c = await createTask(cfg, { subject: 'c', description: 'd' })
    expect(Number(c.id)).toBeGreaterThan(Number(b.id))
    void a
  })

  it('validates subject/description/blockedBy', async () => {
    await expect(createTask(cfg, { subject: '  ', description: 'd' })).rejects.toThrow(/subject is required/)
    await expect(createTask(cfg, { subject: 's', description: 'd', blockedBy: ['999999'] })).rejects.toThrow(
      /does not exist/,
    )
    await expect(createTask(cfg, { subject: 'x'.repeat(201), description: 'd' })).rejects.toThrow(/too long/)
  })
})

describe('blockedBy twin edges', () => {
  it('writes both sides on create and cleans both on delete', async () => {
    const parent = await makeTask('parent')
    const child = await makeTask('child', [parent])
    expect(await getTask(cfg, parent)).toMatchObject({ blocks: [child] })
    expect(await getTask(cfg, child)).toMatchObject({ blockedBy: [parent] })

    expect(await deleteTask(cfg, child)).toBe(true)
    expect(await getTask(cfg, parent)).toMatchObject({ blocks: [] })
  })

  it('addBlockedBy / removeBlockedBy keep the twins in sync', async () => {
    const a = await createTask(cfg, { subject: 'a', description: 'd' })
    const b = await createTask(cfg, { subject: 'b', description: 'd' })
    await updateTask(cfg, b.id, { addBlockedBy: [a.id] })
    expect(await getTask(cfg, a.id)).toMatchObject({ blocks: [b.id] })
    await updateTask(cfg, b.id, { removeBlockedBy: [a.id] })
    expect(await getTask(cfg, a.id)).toMatchObject({ blocks: [] })
    expect(await getTask(cfg, b.id)).toMatchObject({ blockedBy: [] })
  })

  it('a task cannot block itself on update (a create self-ref simply does not exist yet)', async () => {
    const t = await createTask(cfg, { subject: 'solo', description: 'd' })
    await expect(updateTask(cfg, t.id, { addBlockedBy: [t.id] })).rejects.toThrow(/cannot block itself/)
  })
})

describe('claim — the atomic decision', () => {
  it('succeeds once, refuses a second hand, and re-claim by the owner is fine', async () => {
    const id = await makeTask('contested')
    expect((await claimTask(cfg, id, 'orchestrator')).success).toBe(true)
    const second = await claimTask(cfg, id, 'researcher')
    expect(second.success).toBe(false)
    expect(second.reason).toBe('already_claimed')
    expect((await claimTask(cfg, id, 'orchestrator')).success).toBe(true)
  })

  it('refuses completed work and missing tasks', async () => {
    const id = await makeTask('done deal')
    await updateTask(cfg, id, { status: 'completed' })
    const r = await claimTask(cfg, id, 'orchestrator')
    expect(r.reason).toBe('already_resolved')
    const missing = await claimTask(cfg, '999999', 'orchestrator')
    expect(missing.reason).toBe('task_not_found')
  })

  it('refuses blocked tasks, naming the unresolved blockers; completion unblocks', async () => {
    const parent = await makeTask('parent blocker')
    const child = await makeTask('dependent', [parent])
    const r = await claimTask(cfg, child, 'orchestrator')
    expect(r.reason).toBe('blocked')
    expect(r.blockedByTasks).toEqual([parent])
    await updateTask(cfg, parent, { status: 'completed' })
    expect((await claimTask(cfg, child, 'orchestrator')).success).toBe(true)
  })

  it('checkAgentBusy refuses a claimant who already owns an open task', async () => {
    const first = await makeTask('first workflow')
    expect((await claimTask(cfg, first, 'executor', { checkAgentBusy: true })).success).toBe(true)
    const second = await makeTask('second workflow')
    const r = await claimTask(cfg, second, 'executor', { checkAgentBusy: true })
    expect(r.reason).toBe('agent_busy')
    expect(r.busyWithTasks).toEqual([first])
  })

  it('corrupt board state fails CLOSED — no claim ever emerges from an unevaluable board', async () => {
    const id = await makeTask('over a corrupt record')
    fs.writeFileSync(path.join(dir, 'data', 'tasks', '777.json'), '{not json', 'utf8')
    // an honest throw — never a claim, never a fake task_not_found
    await expect(claimTask(cfg, id, 'orchestrator')).rejects.toThrow(/777/)
    fs.rmSync(path.join(dir, 'data', 'tasks', '777.json'), { force: true })
  })

  it('wrong-shape task files are refused, never skipped', async () => {
    fs.writeFileSync(
      path.join(dir, 'data', 'tasks', '888.json'),
      JSON.stringify({ id: '888', subject: 42 }),
      'utf8',
    )
    await expect(listTasks(cfg)).rejects.toThrow(/wrong shape/)
    fs.rmSync(path.join(dir, 'data', 'tasks', '888.json'), { force: true })
  })
})

describe('the list lock', () => {
  it('a held lock fails closed after a bounded wait — stale is not permission to steal', async () => {
    fs.mkdirSync(path.join(dir, 'data', 'tasks'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'data', 'tasks', '.lock'),
      JSON.stringify({ token: 'someone-else', pid: 1, at: Date.now() }),
      'utf8',
    )
    await expect(createTask(cfg, { subject: 'x', description: 'd' })).rejects.toThrow(/task list is busy/)
    // the foreign lock is still there — we did not steal it
    expect(fs.existsSync(path.join(dir, 'data', 'tasks', '.lock'))).toBe(true)
    fs.rmSync(path.join(dir, 'data', 'tasks', '.lock'), { force: true })
  })

  it('releases the lock on success and on failure', async () => {
    await createTask(cfg, { subject: 'ok', description: 'd' })
    await expect(createTask(cfg, { subject: '', description: '' })).rejects.toThrow()
    expect(fs.existsSync(path.join(dir, 'data', 'tasks', '.lock'))).toBe(false)
  })
})

describe('unassignTasks — crash cleanup', () => {
  it('strips the owner from open tasks only; completed keep their record', async () => {
    const open = await makeTask('died mid-run')
    await claimTask(cfg, open, 'researcher')
    const done = await makeTask('finished before the crash')
    await claimTask(cfg, done, 'researcher')
    await updateTask(cfg, done, { status: 'completed' })

    const r = await unassignTasks(cfg, 'researcher')
    expect(r.unassigned).toEqual([open])
    expect((await getTask(cfg, open))?.owner).toBeUndefined()
    expect(await getTask(cfg, done)).toMatchObject({ owner: 'researcher' })
  })
})

// ── Review-repair regressions (PR #74) ──────────────────────────────────────

describe('high-water-mark integrity (fail closed)', () => {
  it('a malformed present mark refuses createTask — retired ids are never forgotten or auto-repaired', async () => {
    const a = await createTask(cfg, { subject: 'hwm a', description: 'd' })
    const b = await createTask(cfg, { subject: 'hwm b', description: 'd' })
    expect(await deleteTask(cfg, b.id)).toBe(true) // retirement now depends on the mark
    const markPath = path.join(dir, 'data', 'tasks', '.highwatermark')
    const tasksDirPath = (): string => path.join(dir, 'data', 'tasks')
    for (const corrupt of ['garbage', '"not-a-number"', '1.5', '-5', '{}']) {
      fs.writeFileSync(markPath, corrupt, 'utf8')
      const filesBefore = fs.readdirSync(tasksDirPath()).filter((f) => f.endsWith('.json')).length
      // recovery advice must be the SAFE one: repair from evidence, never
      // delete/reset the mark (removal may erase the only proof of retired ids)
      let message = ''
      try {
        await createTask(cfg, { subject: 'hwm c', description: 'd' })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toMatch(/high-water-mark integrity error/)
      expect(message).toMatch(/FROM TRUSTED EVIDENCE/i)
      expect(message).toMatch(/do NOT delete or reset/i)
      expect(message).toMatch(/keep refusing/i)
      const filesAfter = fs.readdirSync(tasksDirPath()).filter((f) => f.endsWith('.json')).length
      expect(filesAfter).toBe(filesBefore) // no replacement task file was created
      expect(fs.readFileSync(markPath, 'utf8')).toBe(corrupt) // never auto-repaired
    }
    // restoring the honest mark (the retired id) unblocks AND keeps ids past it
    fs.writeFileSync(markPath, String(Number(b.id)), 'utf8')
    const c = await createTask(cfg, { subject: 'hwm c', description: 'd' })
    expect(Number(c.id)).toBeGreaterThan(Number(b.id))
    void a
  })
})

describe('board topology integrity (fail closed before any claim)', () => {
  const tasksDirPath = (): string => path.join(dir, 'data', 'tasks')
  const fileOf = (id: string): string => path.join(tasksDirPath(), `${id}.json`)

  function rewrite(id: string, mutate: (doc: Record<string, unknown>) => void): void {
    const doc = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Record<string, unknown>
    mutate(doc)
    fs.writeFileSync(fileOf(id), JSON.stringify(doc), 'utf8')
  }

  it('A: blockedBy referencing a missing task refuses the claim; owner stays unset', async () => {
    const parent = await createTask(cfg, { subject: 'A parent', description: 'd' })
    const child = await createTask(cfg, { subject: 'A child', description: 'd', blockedBy: [parent.id] })
    rewrite(child.id, (doc) => {
      doc.blockedBy = ['999999']
    })
    try {
      await expect(claimTask(cfg, child.id, 'orchestrator')).rejects.toThrow(/missing task 999999/)
      expect((await getTask(cfg, child.id))?.owner).toBeUndefined()
    } finally {
      fs.rmSync(fileOf(parent.id), { force: true })
      fs.rmSync(fileOf(child.id), { force: true })
    }
  })

  it('B: blocks edge without the blockedBy twin refuses the claim; owner stays unset', async () => {
    const parent = await createTask(cfg, { subject: 'B parent', description: 'd' })
    const child = await createTask(cfg, { subject: 'B child', description: 'd', blockedBy: [parent.id] })
    rewrite(child.id, (doc) => {
      doc.blockedBy = [] // parent.blocks still names the child
    })
    try {
      await expect(claimTask(cfg, child.id, 'orchestrator')).rejects.toThrow(/asymmetric twin edge/)
      expect((await getTask(cfg, child.id))?.owner).toBeUndefined()
    } finally {
      fs.rmSync(fileOf(parent.id), { force: true })
      fs.rmSync(fileOf(child.id), { force: true })
    }
  })

  it('C: blockedBy edge without the blocks twin refuses the claim; owner stays unset', async () => {
    const parent = await createTask(cfg, { subject: 'C parent', description: 'd' })
    const child = await createTask(cfg, { subject: 'C child', description: 'd', blockedBy: [parent.id] })
    rewrite(parent.id, (doc) => {
      doc.blocks = [] // child.blockedBy still names the parent
    })
    try {
      await expect(claimTask(cfg, child.id, 'orchestrator')).rejects.toThrow(/asymmetric twin edge/)
      expect((await getTask(cfg, child.id))?.owner).toBeUndefined()
    } finally {
      fs.rmSync(fileOf(parent.id), { force: true })
      fs.rmSync(fileOf(child.id), { force: true })
    }
  })

  it('D: colliding identity (<id>.json claiming a different id) refuses every board decision', async () => {
    fs.writeFileSync(
      fileOf('123'),
      JSON.stringify({ id: '124', subject: 'imposter', description: 'd', status: 'pending', blocks: [], blockedBy: [] }),
      'utf8',
    )
    await expect(claimTask(cfg, '123', 'orchestrator')).rejects.toThrow(/colliding identity/)
    await expect(listTasks(cfg)).rejects.toThrow(/colliding identity/)
    fs.rmSync(fileOf('123'), { force: true })
  })

  it('a task file that vanishes mid-board-read is a refusal, never a silent skip', async () => {
    const t1 = await createTask(cfg, { subject: 'vanish witness', description: 'd' })
    const t2 = await createTask(cfg, { subject: 'vanish victim', description: 'd' })
    const real = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, opts) => {
      if (typeof p === 'string' && p.endsWith(`/${t2.id}.json`)) {
        const e = new Error('simulated vanish') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      return real(p as never, opts as never)
    })
    try {
      await expect(listTasks(cfg)).rejects.toThrow(/vanish/)
      await expect(claimTask(cfg, t1.id, 'orchestrator')).rejects.toThrow(/vanish/)
    } finally {
      spy.mockRestore()
    }
    expect(fs.existsSync(fileOf(t2.id))).toBe(true) // nothing was stolen or cleaned
    fs.rmSync(fileOf(t1.id), { force: true })
    fs.rmSync(fileOf(t2.id), { force: true })
  })
})

describe('task_update: claim and edits are mutually exclusive (no partial mutation)', () => {
  type ToolCtx = Parameters<typeof import('../src/tools/tasks.js').taskUpdateTool.execute>[1]
  const toolCtx = (): ToolCtx => ({ cfg, agent: { name: 'orchestrator' } } as unknown as ToolCtx)

  it('claim=true plus an edit is refused BEFORE claiming — owner stays undefined', async () => {
    const { taskUpdateTool } = await import('../src/tools/tasks.js')
    const id = await makeTask('clean claim or nothing')
    const res = (await taskUpdateTool.execute({ id, claim: true, subject: '   ' } as never, toolCtx())).text
    expect(res).toMatch(/cannot be combined/i)
    expect((await getTask(cfg, id))?.owner).toBeUndefined()
  })

  it('the positive path: claim-only succeeds as ctx.agent.name; a separate later edit succeeds', async () => {
    const { taskUpdateTool } = await import('../src/tools/tasks.js')
    const id = await makeTask('two honest steps')
    await taskUpdateTool.execute({ id, claim: true } as never, toolCtx())
    expect((await getTask(cfg, id))?.owner).toBe('orchestrator')
    await taskUpdateTool.execute({ id, status: 'in_progress' } as never, toolCtx())
    expect(await getTask(cfg, id)).toMatchObject({ owner: 'orchestrator', status: 'in_progress' })
  })
})

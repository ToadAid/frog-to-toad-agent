import fs from 'node:fs'
import path from 'node:path'
import { Cron } from 'croner'
import { log } from '../log.js'

/**
 * Cron scheduler (the fork's cronScheduler.ts design, simplified):
 * tasks persist in data/scheduled_tasks.json; lastFiredAt is written back after
 * each fire so next-run math survives restarts; missed one-shots fire once with
 * a [missed] prefix then drop.
 */
export type CronTask = {
  id: string
  cron: string
  prompt: string
  agent?: string
  createdAt: number
  lastFiredAt?: number
  recurring: boolean
  permanent?: boolean
}

export class Scheduler {
  private jobs: Cron[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private started = false

  constructor(
    private onFire: (task: CronTask) => void,
    private tasksPath: string,
    /** IANA zone for cron firing — the principal's clock, not the server's. */
    private timezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  private load(): CronTask[] {
    try {
      return JSON.parse(fs.readFileSync(this.tasksPath, 'utf8')) as CronTask[]
    } catch {
      return []
    }
  }

  private save(tasks: CronTask[]): void {
    fs.mkdirSync(path.dirname(this.tasksPath), { recursive: true })
    fs.writeFileSync(this.tasksPath, JSON.stringify(tasks, null, 2))
  }

  start(): void {
    if (this.started) return
    this.started = true

    // Validate all crons up-front — a bad expression should fail at boot.
    for (const task of this.load()) {
      if (!isValidCron(task.cron)) {
        log.error(`scheduler: invalid cron '${task.cron}' on task ${task.id} — skipping`)
      }
    }
    // Fire missed one-shots exactly once, then drop them.
    const missed = this.load().filter(
      (t) => !t.recurring && t.lastFiredAt === undefined && t.createdAt < Date.now() - 60_000,
    )
    for (const t of missed) {
      log.warn(`scheduler: firing missed one-shot ${t.id}`)
      this.onFire({ ...t, prompt: `[missed] ${t.prompt}` })
    }
    this.save(this.load().filter((t) => !missed.some((m) => m.id === t.id)))

    // croner handles scheduling; we re-check every 30s for added/removed tasks
    this.timer = setInterval(() => void this.scheduleAll(), 30_000)
    void this.scheduleAll()
  }

  private async scheduleAll(): Promise<void> {
    for (const job of this.jobs) job.stop()
    this.jobs = []
    for (const task of this.load()) {
      try {
        const job = new Cron(task.cron, { timezone: this.timezone }, () => {
          this.fire(task.id)
        })
        this.jobs.push(job)
      } catch (err) {
        log.error(`scheduler: failed to schedule ${task.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private fire(taskId: string): void {
    const tasks = this.load()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    this.onFire(task)
    task.lastFiredAt = Date.now()
    const updated = tasks.map((t) => (t.id === taskId ? task : t)).filter((t) => t.recurring || t.permanent || t.lastFiredAt === undefined)
    this.save(updated)
  }

  add(task: Omit<CronTask, 'id' | 'createdAt'> & { id?: string }): CronTask {
    if (!isValidCron(task.cron)) throw new Error(`invalid cron expression: ${task.cron}`)
    const full: CronTask = {
      ...task,
      id: task.id ?? Math.random().toString(36).slice(2, 8),
      createdAt: Date.now(),
    }
    const tasks = this.load()
    tasks.push(full)
    this.save(tasks)
    if (this.started) void this.scheduleAll()
    return full
  }

  /**
   * Principal/runtime-owned schedule slot. Agent-facing schedule_create cannot
   * choose an id or mark a task permanent. Existing fire metadata is retained.
   */
  upsertPermanent(
    task: Omit<CronTask, 'createdAt' | 'lastFiredAt' | 'permanent'> & { id: string },
  ): CronTask {
    if (!isValidCron(task.cron)) throw new Error(`invalid cron expression: ${task.cron}`)
    const tasks = this.load()
    const previous = tasks.find((t) => t.id === task.id)
    const full: CronTask = {
      ...task,
      permanent: true,
      createdAt: previous?.createdAt ?? Date.now(),
      ...(previous?.lastFiredAt === undefined ? {} : { lastFiredAt: previous.lastFiredAt }),
    }
    this.save([...tasks.filter((t) => t.id !== task.id), full])
    if (this.started) void this.scheduleAll()
    return full
  }

  list(): CronTask[] {
    return this.load()
  }

  remove(id: string, opts: { includePermanent?: boolean } = {}): boolean {
    const tasks = this.load()
    const target = tasks.find((t) => t.id === id)
    if (!target) return false
    if (target.permanent && opts.includePermanent !== true) return false
    const next = tasks.filter((t) => t.id !== id)
    this.save(next)
    if (this.started) void this.scheduleAll()
    return true
  }

  stop(): void {
    for (const job of this.jobs) job.stop()
    this.jobs = []
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.started = false
  }
}

/** croner exposes no static validator in v9 typings — construct (paused) to validate. */
function isValidCron(expr: string): boolean {
  try {
    new Cron(expr, { paused: true })
    return true
  } catch {
    return false
  }
}
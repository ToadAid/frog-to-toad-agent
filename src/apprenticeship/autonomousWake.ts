import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { log } from '../log.js'
import { loadDeskState } from '../safety/deskState.js'
import { readApprenticeshipTreasury } from '../safety/simulatedTreasury.js'
import type { CronTask, Scheduler } from '../scheduler/scheduler.js'
import { appendJsonl, readJsonl } from '../store/jsonl.js'

export const APPRENTICESHIP_WAKE_TASK_ID = 'frog-apprenticeship-wake'

export const AUTONOMOUS_WAKE_PROMPT = [
  '[A2 autonomous apprenticeship wake]',
  'Run one bounded DRY_RUN learning cycle without asking the principal to choose the opportunity for you.',
  'Start with portfolio_get so you know the finite apprenticeship cash and existing positions.',
  'Inspect current market evidence before deciding. Use researcher, token-auditor, and risk review where the existing desk protocol requires them.',
  'Any simulated entry must go through the existing executor, A0 approval boundary, A1 treasury, trade guard, oracle, precision, and ledger. WALK AWAY is a valid outcome.',
  'Do not use schedule_create or schedule_delete to change your wake cadence. Do not change limits, permissions, wallet authority, source code, or live-mode settings.',
  'Do not claim the placeholder fill model is realistic. Record what you observed, what you chose, and what you still do not know.',
].join('\n')

export type WakeReceiptEvent = {
  event: 'claimed' | 'completed' | 'failed' | 'skipped'
  taskId: string
  cron: string
  slot: string
  at: number
  reason?: string
}

export type AutonomousWakeOutcome = {
  status: 'completed' | 'failed' | 'duplicate' | 'skipped'
  slot: string
  reason?: string
}

export function wakeReceiptsPath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'apprenticeship', 'wake-receipts.jsonl')
}

export function wakeClaimsDir(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'apprenticeship', 'wake-claims')
}

export function readWakeReceipts(cfg: Config): WakeReceiptEvent[] {
  return readJsonl<WakeReceiptEvent>(wakeReceiptsPath(cfg))
}

/** 5-field cron has minute granularity; this is the authoritative local slot key. */
export function wakeSlotKey(timezone: string, atMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(atMs))

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

function claimWakeSlot(
  cfg: Config,
  task: CronTask,
  atMs: number,
): { claimed: true; slot: string } | { claimed: false; slot: string } {
  const slot = wakeSlotKey(cfg.timezone, atMs)
  const dir = wakeClaimsDir(cfg)
  fs.mkdirSync(dir, { recursive: true })
  const claimPath = path.join(dir, `${slot.replace(':', '-')}.claim`)

  let fd: number
  try {
    // O_EXCL is the cross-process authority boundary. There is deliberately no
    // stale-claim reclamation: after a crash, execution outcome is unknowable.
    fd = fs.openSync(claimPath, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { claimed: false, slot }
    }
    throw err
  }

  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        taskId: task.id,
        cron: task.cron,
        slot,
        claimedAt: atMs,
        pid: process.pid,
      }) + '\n',
    )
  } finally {
    fs.closeSync(fd)
  }

  return { claimed: true, slot }
}

function appendReceipt(cfg: Config, receipt: WakeReceiptEvent): void {
  appendJsonl(wakeReceiptsPath(cfg), receipt)
}

/**
 * Run one A2 wake slot.
 *
 * Claim happens BEFORE any agent effect. A claim is never auto-reclaimed:
 * same-slot retry after crash/ambiguity is forbidden. A later cron slot is a
 * new claim and may run normally.
 */
export async function runAutonomousWake(
  cfg: Config,
  task: CronTask,
  run: (prompt: string) => Promise<void>,
  atMs: number = Date.now(),
): Promise<AutonomousWakeOutcome> {
  const slot = wakeSlotKey(cfg.timezone, atMs)

  if (!cfg.dryRun || cfg.autonomousDryRun !== true || cfg.apprenticeshipWakeCron === undefined) {
    return {
      status: 'skipped',
      slot,
      reason: 'autonomous wake is not authorized by DRY_RUN + AUTONOMOUS_DRY_RUN + APPRENTICESHIP_WAKE_CRON',
    }
  }

  let claim: ReturnType<typeof claimWakeSlot>
  try {
    claim = claimWakeSlot(cfg, task, atMs)
  } catch (err) {
    const reason = `wake claim failed: ${err instanceof Error ? err.message : String(err)}`
    log.error(reason)
    return { status: 'failed', slot, reason }
  }

  if (!claim.claimed) {
    return {
      status: 'duplicate',
      slot,
      reason: 'wake slot already claimed; no automatic retry',
    }
  }

  try {
    appendReceipt(cfg, {
      event: 'claimed',
      taskId: task.id,
      cron: task.cron,
      slot,
      at: atMs,
    })
  } catch (err) {
    const reason =
      `wake slot claimed but receipt append failed; refusing execution and retaining claim: ` +
      (err instanceof Error ? err.message : String(err))
    log.error(reason)
    return { status: 'failed', slot, reason }
  }

  let desk: ReturnType<typeof loadDeskState>
  let treasury: ReturnType<typeof readApprenticeshipTreasury>
  try {
    desk = loadDeskState(cfg)
    treasury = readApprenticeshipTreasury(cfg)
  } catch (err) {
    const reason = `wake preflight failed after claim: ${err instanceof Error ? err.message : String(err)}`
    try {
      appendReceipt(cfg, {
        event: 'failed',
        taskId: task.id,
        cron: task.cron,
        slot,
        at: Date.now(),
        reason,
      })
    } catch (receiptErr) {
      log.error(
        `wake ${slot} preflight failed and failure receipt could not be appended: ${
          receiptErr instanceof Error ? receiptErr.message : String(receiptErr)
        }`,
      )
    }
    return { status: 'failed', slot, reason }
  }

  if (desk.state === 'HALTED') {
    const reason = `desk HALTED${desk.reason ? ` — ${desk.reason}` : ''}`
    appendReceipt(cfg, {
      event: 'skipped',
      taskId: task.id,
      cron: task.cron,
      slot,
      at: Date.now(),
      reason,
    })
    return { status: 'skipped', slot, reason }
  }

  if (!treasury.ok) {
    const reason = `${treasury.code}: ${treasury.reason}`
    appendReceipt(cfg, {
      event: 'skipped',
      taskId: task.id,
      cron: task.cron,
      slot,
      at: Date.now(),
      reason,
    })
    return { status: 'skipped', slot, reason }
  }

  const prompt =
    `${task.prompt}\n\n` +
    `[A2 wake receipt context]\n` +
    `Wake slot: ${slot} (${cfg.timezone})\n` +
    `Desk state at claim: ${desk.state}\n` +
    `Finite apprenticeship cash at claim: $${treasury.cashUsd.toFixed(2)} / $${treasury.seedUsd.toFixed(2)} seed\n` +
    `This slot was durably claimed before execution. Do not retry or fork this wake.`

  try {
    await run(prompt)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    try {
      appendReceipt(cfg, {
        event: 'failed',
        taskId: task.id,
        cron: task.cron,
        slot,
        at: Date.now(),
        reason,
      })
    } catch (receiptErr) {
      log.error(
        `wake ${slot} failed and failure receipt could not be appended: ${
          receiptErr instanceof Error ? receiptErr.message : String(receiptErr)
        }`,
      )
    }
    return { status: 'failed', slot, reason }
  }

  try {
    appendReceipt(cfg, {
      event: 'completed',
      taskId: task.id,
      cron: task.cron,
      slot,
      at: Date.now(),
    })
  } catch (err) {
    const reason =
      `agent run completed but completion receipt failed; claim remains authoritative and no retry is allowed: ` +
      (err instanceof Error ? err.message : String(err))
    log.error(reason)
    return { status: 'failed', slot, reason }
  }

  return { status: 'completed', slot }
}

/**
 * Normalize the one principal-owned A2 task BEFORE scheduler.start().
 * Blank config removes a previously persisted wake task; agent tools cannot.
 */
export function configureAutonomousWakeTask(
  scheduler: Scheduler,
  cfg: Config,
): CronTask | undefined {
  if (cfg.apprenticeshipWakeCron === undefined) {
    scheduler.remove(APPRENTICESHIP_WAKE_TASK_ID, { includePermanent: true })
    return undefined
  }

  return scheduler.upsertPermanent({
    id: APPRENTICESHIP_WAKE_TASK_ID,
    cron: cfg.apprenticeshipWakeCron,
    prompt: AUTONOMOUS_WAKE_PROMPT,
    recurring: true,
  })
}

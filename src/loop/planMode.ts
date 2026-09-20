import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import type { RunSummary } from '../types.js'
import { startRun, type RunHandle, type StartRunOptions } from './agentLoop.js'
import { log } from '../log.js'

/**
 * Plan-first run mode (PR 6, the mother-repo plan-mode pattern, desk-sized):
 *
 *   [plan] <task>  →  PLAN RUN (read-only tools only — the PR 5 scout filter
 *                      is the enforcement)  →  plan artifact to
 *                      data/plans/<runId>.md (status PENDING)  →  principal
 *                      approves through the SAME approval gate as any trade
 *                      card  →  only on 'allow' does the EXECUTION run start
 *                      with full tools, seeded with the approved plan.
 *
 * Fail-closed everywhere: no approval gate ⇒ no_channel ⇒ nothing executes;
 * deny/timeout keep the plan PENDING/REJECTED on disk and the run ends with
 * the plan text. The execution run is a normal run — the write/trade gates
 * that apply to it (guarded tools, trade limits) still apply on top.
 */

export function planArtifactsDir(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'plans')
}

function writePlanArtifact(cfg: Config, runId: string, task: string, plan: string, status: string): string {
  const file = path.join(planArtifactsDir(cfg), `${runId}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = [
    `# plan ${runId}`,
    `status: ${status}`,
    `created: ${new Date().toISOString()}`,
    `task: ${task.replace(/\n/g, ' ').slice(0, 200)}`,
    '',
    plan.trim(),
    '',
  ].join('\n')
  fs.writeFileSync(file, body)
  return file
}

const PLAN_BRIEF =
  '[plan-mode] Using READ-ONLY research tools only, produce a concrete step-by-step execution plan for the task ' +
  'below. Do NOT attempt to execute anything — write/trade tools are unavailable in plan mode, and nothing runs ' +
  'until the principal approves the plan. End your reply with the full plan.\n\nTask: '

/** Composite handle — plus the plan artifact path (empty until written). */
export type PlanRunHandle = RunHandle & { planArtifact: string }

/** The composite handle: abort() reaches whichever phase is live. */
export function startPlanFirstRun(opts: StartRunOptions): PlanRunHandle {
  const task = opts.userText.trim()
  let current: RunHandle | undefined
  let planArtifact = ''
  const controller = new AbortController()
  controller.signal.addEventListener('abort', () => current?.abort(), { once: true })

  const done = (async (): Promise<RunSummary> => {
    // Phase 1 — the plan run: read-only, same agent/thread/gates otherwise.
    const planHandle = startRun({ ...opts, userText: `${PLAN_BRIEF}${task}`, readonlyTools: true })
    current = planHandle
    const planSummary = await planHandle.done
    if (planSummary.aborted) return planSummary
    const plan = planSummary.finalText.trim()
    if (plan === '') {
      log.warn('plan-first run: planner returned no plan — nothing to approve, nothing executed')
      return planSummary
    }
    const artifact = writePlanArtifact(opts.cfg, planSummary.runId, task, plan, 'PENDING')
    planArtifact = artifact

    // Phase 2 — the principal's decision through the SAME gate as trades.
    const decision = opts.approvalGate
      ? await opts.approvalGate(
          {
            tool: 'plan_approval',
            input: { task, artifact },
            summary: `📋 plan (${planSummary.runId}) for "${task.slice(0, 80)}": ${plan.slice(0, 400)}…`,
            danger: 'write',
          },
          opts.chatId,
          controller.signal,
        )
      : 'no_channel'
    if (decision !== 'allow') {
      writePlanArtifact(opts.cfg, planSummary.runId, task, plan, decision === 'deny' ? 'REJECTED' : 'PENDING')
      log.info(`plan-first run: plan ${planSummary.runId} not approved (${decision}) — nothing executed`)
      return {
        ...planSummary,
        finalText: `${plan}\n\n📄 plan saved to ${path.relative(process.cwd(), artifact)} — not approved (${decision}), nothing was executed.`,
      }
    }
    writePlanArtifact(opts.cfg, planSummary.runId, task, plan, 'APPROVED')

    // Phase 3 — the execution run: full tools (its own gates still apply),
    // seeded with the approved plan so it follows what was approved.
    const execHandle = startRun({ ...opts, userText: `[approved plan — execute now]\n\n${plan}` })
    current = execHandle
    const execSummary = await execHandle.done
    log.info(`plan-first run: plan ${planSummary.runId} executed (${execSummary.turns} turn(s))`)
    return execSummary
  })()

  return {
    runId: current?.runId ?? 'plan-first',
    signal: controller.signal,
    abort: () => controller.abort(),
    done,
    get planArtifact(): string {
      return planArtifact
    },
  }
}
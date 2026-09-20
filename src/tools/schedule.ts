import { z } from 'zod'
import { defineTool } from './registry.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import { fmtLocalTs } from '../util/temporal.js'

/** Scheduler instance is injected at boot (index.ts). */
let scheduler: Scheduler | undefined

export function setScheduler(s: Scheduler): void {
  scheduler = s
}

export const scheduleCreateTool = defineTool({
  name: 'schedule_create',
  description:
    'Schedule a recurring prompt (5-field cron, local time). Example: {"cron": "0 * * * *", "prompt": "check my positions and alert if anything moved >10%"}. ' +
    'The prompt runs as the orchestrator at fire time.',
  danger: 'write',
  input: z.object({
    cron: z.string().describe('5-field cron expression in local time, e.g. "17 8 * * *"'),
    prompt: z.string().describe('the prompt to run when it fires'),
  }),
  execute: async (input) => {
    if (!scheduler) return { text: '[error] scheduler not running' }
    const task = scheduler.add({ cron: input.cron, prompt: input.prompt, recurring: true })
    return { text: `scheduled: ${task.cron} → "${task.prompt}" (id ${task.id})` }
  },
})

export const scheduleListTool = defineTool({
  name: 'schedule_list',
  description: 'List all scheduled tasks.',
  danger: 'readonly',
  input: z.object({}),
  execute: async (_input, ctx) => {
    if (!scheduler) return { text: '[error] scheduler not running' }
    const tasks = scheduler.list()
    if (tasks.length === 0) return { text: 'no scheduled tasks' }
    const tz = ctx.cfg.timezone
    return {
      text: tasks
        .map((t) => `• ${t.cron} (${tz}) → "${t.prompt}" (id ${t.id}${t.lastFiredAt ? `, last fired ${fmtLocalTs(tz, t.lastFiredAt)}` : ', never fired'})`)
        .join('\n'),
    }
  },
})

export const scheduleDeleteTool = defineTool({
  name: 'schedule_delete',
  description: 'Delete a scheduled task by id (see schedule_list).',
  danger: 'write',
  input: z.object({ id: z.string() }),
  execute: async (input) => {
    if (!scheduler) return { text: '[error] scheduler not running' }
    const task = scheduler.list().find((t) => t.id === input.id)
    if (task?.permanent) {
      return {
        text:
          `[guard] task ${input.id} is principal-managed and permanent. ` +
          `Change its external config and restart instead of deleting it from the agent lane.`,
      }
    }
    const removed = scheduler.remove(input.id)
    return { text: removed ? `deleted task ${input.id}` : `no task with id ${input.id}` }
  },
})
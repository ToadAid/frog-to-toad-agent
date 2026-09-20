import { z } from 'zod'
import { defineTool } from './registry.js'
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  updateTask,
  type ClaimTaskResult,
  type Task,
} from '../store/tasks.js'

/**
 * The shared task board, as tools. One durable list under data/tasks/ that
 * every hand reads and writing hands claim from — the wiring lane's backbone.
 * Ownership is NEVER set directly: the only path to `owner` is task_update's
 * claim flag, which runs the atomic claim (already_claimed / blocked /
 * agent_busy are decisions, not errors). Claimant identity is the calling
 * agent's name from its definition — an agent cannot claim as someone else.
 */

const taskId = z.string().regex(/^\d+$/, 'task id is numeric')

function renderTask(t: Task): string {
  const owner = t.owner ? ` owner=${t.owner}` : ''
  const active = t.activeForm && t.status === 'in_progress' ? ` (${t.activeForm})` : ''
  const blockedBy = t.blockedBy.length > 0 ? ` blockedBy=[${t.blockedBy.join(',')}]` : ''
  const blocks = t.blocks.length > 0 ? ` blocks=[${t.blocks.join(',')}]` : ''
  return `#${t.id} [${t.status}]${owner}${active} ${t.subject}${blockedBy}${blocks}`
}

function renderClaim(r: ClaimTaskResult): string {
  if (r.success) return `claim succeeded:\n${renderTask(r.task!)}`
  const why = r.reason ?? 'unknown'
  if (why === 'blocked') {
    return `claim refused — blocked by unresolved task(s): ${(r.blockedByTasks ?? []).map((i) => `#${i}`).join(', ')}`
  }
  if (why === 'agent_busy') {
    return `claim refused — already busy with open task(s): ${(r.busyWithTasks ?? []).map((i) => `#${i}`).join(', ')}`
  }
  if (why === 'already_claimed') return `claim refused — task is owned by ${r.task?.owner ?? 'another hand'}`
  if (why === 'already_resolved') return 'claim refused — task is already completed'
  return 'claim refused — no such task'
}

export const taskCreateTool = defineTool({
  name: 'task_create',
  description:
    'Create a task on the shared desk board. Give multi-step work a dependency order with blockedBy ' +
    '(ids of tasks that must complete first). Use for wiring-lane coordination, not for notes — the journal is for notes.',
  danger: 'write',
  input: z.object({
    subject: z.string().max(200).describe('short imperative title'),
    description: z.string().max(8192).describe('what done means — acceptance, not narration'),
    active_form: z.string().optional().describe('present-continuous form for progress display, e.g. "Running tests"'),
    blocked_by: z.array(taskId).optional().describe('task ids that must complete before this one can be claimed'),
  }),
  execute: async (input, ctx) => {
    const t = await createTask(ctx.cfg, {
      subject: input.subject,
      description: input.description,
      ...(input.active_form !== undefined ? { activeForm: input.active_form } : {}),
      ...(input.blocked_by !== undefined ? { blockedBy: input.blocked_by } : {}),
    })
    return { text: `created:\n${renderTask(t)}` }
  },
})

export const taskListTool = defineTool({
  name: 'task_list',
  description: 'List every task on the shared desk board (id, status, owner, dependencies).',
  danger: 'readonly',
  input: z.object({}),
  execute: async (_input, ctx) => {
    const board = await listTasks(ctx.cfg)
    if (board.length === 0) return { text: 'the task board is empty' }
    return { text: board.map(renderTask).join('\n') }
  },
})

export const taskGetTool = defineTool({
  name: 'task_get',
  description: 'Read one task from the shared desk board in full (description, metadata, dependencies).',
  danger: 'readonly',
  input: z.object({ id: taskId }),
  execute: async (input, ctx) => {
    const t = await getTask(ctx.cfg, input.id)
    if (!t) return { text: `no task #${input.id}` }
    const meta = t.metadata ? `\nmetadata: ${JSON.stringify(t.metadata)}` : ''
    return { text: `${renderTask(t)}\n${t.description}${meta}` }
  },
})

export const taskUpdateTool = defineTool({
  name: 'task_update',
  description:
    'Update a task on the shared desk board: edit fields, set status, or CLAIM it. Claiming is atomic — ' +
    'a refused claim names the reason (already claimed, blocked by unresolved dependencies, or you are busy ' +
    'with another open task). Ownership is only ever set by claiming; you claim as yourself. ' +
    'A claim CANNOT be combined with field edits in the same call — claim first, then edit.',
  danger: 'write',
  input: z.object({
    id: taskId,
    subject: z.string().max(200).optional(),
    description: z.string().max(8192).optional(),
    active_form: z.string().optional(),
    status: z.enum(['pending', 'in_progress', 'completed']).optional(),
    add_blocked_by: z.array(taskId).optional(),
    remove_blocked_by: z.array(taskId).optional(),
    claim: z.boolean().optional().describe('atomically claim this task as yourself (sets owner + refuses with a reason if it cannot be yours)'),
    check_busy: z.boolean().optional().describe('with claim: also refuse when you already own another open task (one workflow per hand)'),
  }),
  execute: async (input, ctx) => {
    const hasEdits =
      input.subject !== undefined ||
      input.description !== undefined ||
      input.active_form !== undefined ||
      input.status !== undefined ||
      input.add_blocked_by !== undefined ||
      input.remove_blocked_by !== undefined
    if (input.claim) {
      // Smallest safe rule for this cut: claim is ALL this call does. The old
      // shape ran claim + edits as two separate locks — a refused edit after a
      // successful claim left the ownership half-applied. check_busy may ride
      // along (it only tightens the claim itself).
      if (hasEdits) {
        return {
          text:
            'claim refused — a claim cannot be combined with field edits in one call ' +
            '(an edit refused after claiming would leave ownership half-applied). Claim first, then edit separately.',
        }
      }
      const r = await claimTask(ctx.cfg, input.id, ctx.agent.name, { checkAgentBusy: input.check_busy })
      return { text: renderClaim(r) }
    }
    const t = await updateTask(ctx.cfg, input.id, {
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.active_form !== undefined ? { activeForm: input.active_form } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.add_blocked_by !== undefined ? { addBlockedBy: input.add_blocked_by } : {}),
      ...(input.remove_blocked_by !== undefined ? { removeBlockedBy: input.remove_blocked_by } : {}),
    })
    return { text: `updated:\n${renderTask(t)}` }
  },
})

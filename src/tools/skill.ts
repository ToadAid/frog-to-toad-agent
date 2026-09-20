import { z } from 'zod'
import { defineTool } from './registry.js'
import { buildSkillEnvelope, getSkillCommands, skillExecutionOptions } from '../skills/commands.js'

/**
 * skill — invoke a playbook loaded from skills/<name>/SKILL.md. The listing
 * lives in the system prompt (orchestrator, budgeted); the body loads here.
 *
 * Two doors, one law:
 *  - inline (default): the playbook body is returned as THIS tool's result
 *    inside the current run — same hands, same turn.
 *  - context: fork: the playbook runs in a fresh subagent context with the
 *    SAME hands (same agent, depth 1).
 *  - `allowed-tools`, on either context mode, only ever NARROWS the effective
 *    tools (a playbook may be less able than its agent — never more).
 * Enforcement is at the loop.
 */
export const skillTool = defineTool({
  name: 'skill',
  description:
    'Run a playbook from skills/ — an operator-authored step-by-step procedure (see the Skills section of your system prompt). ' +
    'Inline playbooks expand into this conversation; fork playbooks run in a subagent with your own tools (possibly narrowed). ' +
    'Follow the playbook it returns.',
  danger: 'readonly',
  input: z.object({
    skill: z.string().describe('the skill name, e.g. "position-check" (leading / tolerated)'),
    args: z.string().optional().describe('optional arguments ($ARGUMENTS / $1 / named in the playbook)'),
  }),
  execute: async (input, ctx) => {
    const name = input.skill.trim().replace(/^\//, '').toLowerCase()
    const { commands } = getSkillCommands(ctx.cfg)
    const cmd = commands.find((c) => c.name === name)
    if (cmd === undefined) {
      const available = commands.map((c) => c.name).join(', ')
      return {
        text: `[error] unknown skill '${input.skill}'. Available: ${available === '' ? '(none loaded)' : available}`,
      }
    }
    if (cmd.disableModelInvocation) {
      return {
        text: `[error] skill '${cmd.name}' is principal-invocable only (disable-model-invocation) — the owner types /${cmd.name}`,
      }
    }
    const args = input.args ?? ''
    const execution = skillExecutionOptions(cmd)
    if (cmd.context === 'fork') {
      // context: fork = a FRESH context (threadMode: 'isolated' — no parent
      // history, no parent transcript writes) with the SAME hands. If the
      // skill declares `allowed-tools`, that list only ever NARROWS the
      // child's tools (a playbook may be less able than its agent — never
      // more). Both enforced at the loop.
      const result = await ctx.callSubagent(ctx.agent.name, buildSkillEnvelope(cmd, args), execution)
      return { text: `playbook '${cmd.name}' (fork) → subagent result:\n${result}` }
    }
    if (execution.toolAllowlist !== undefined) {
      if (ctx.restrictTools === undefined) {
        return { text: `[error] skill '${cmd.name}' unavailable: tool narrowing enforcement seam is absent` }
      }
      ctx.restrictTools(execution.toolAllowlist)
    }
    return { text: buildSkillEnvelope(cmd, args) }
  },
})

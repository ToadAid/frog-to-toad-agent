import { z } from 'zod'
import { defineTool } from './registry.js'

export const spawnSubagentTool = defineTool({
  name: 'spawn_subagent',
  description:
    'Delegate a task to a desk specialist (researcher, token-auditor, risk-guardian, executor). ' +
    'Give a complete, self-contained brief — the subagent cannot see this conversation. ' +
    'Subagents cannot spawn further subagents.',
  danger: 'readonly',
  input: z.object({
    agent: z.string().describe('target agent name, e.g. "researcher"'),
    prompt: z.string().describe('complete task brief for the subagent'),
  }),
  execute: async (input, ctx) => {
    const text = await ctx.callSubagent(input.agent, input.prompt)
    return { text }
  },
})
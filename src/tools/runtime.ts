import { z } from 'zod'
import { defineTool } from './registry.js'
import { handsGateOpen, readDoctorState } from '../doctor/doctor.js'
import { loadDeskState } from '../safety/deskState.js'

/** Authoritative, secret-free runtime identity for the sandboxed agent. */
export const runtimeStatusTool = defineTool({
  name: 'runtime_status',
  description: 'Report the loaded brain, model, execution mode, safety state, and hands gate without reading .env.',
  danger: 'readonly',
  input: z.object({}),
  execute: async (_input, ctx) => {
    const doctor = readDoctorState(ctx.cfg)
    return { text: [
      `Brain: ${ctx.cfg.brain}`,
      `Provider: ${ctx.cfg.llm.provider}`,
      `Model: ${ctx.cfg.llm.model}`,
      `Execution: ${ctx.cfg.dryRun ? 'DRY RUN (no funds move)' : `LIVE (${ctx.cfg.executionMode})`}`,
      `Trading state: ${loadDeskState(ctx.cfg).state}`,
      `Hands: ${handsGateOpen(ctx.cfg) ? 'OPEN' : 'CLOSED'}`,
      `Doctor cheap check: ${doctor?.cheapOk === true ? 'healthy' : 'unhealthy or unknown'}`,
    ].join('\n') }
  },
})

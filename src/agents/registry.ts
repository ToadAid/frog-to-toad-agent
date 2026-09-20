import type { Config } from '../config.js'
import type { AgentDef } from '../types.js'
import { loadAgents } from './loader.js'
import { log } from '../log.js'

export class AgentRegistry {
  private agents = new Map<string, AgentDef>()

  constructor(agents: Map<string, AgentDef>) {
    for (const [name, def] of agents) this.agents.set(name, def)
  }

  get(name: string): AgentDef | undefined {
    return this.agents.get(name)
  }

  names(): string[] {
    return [...this.agents.keys()]
  }

  /** Delegation roster shown in the orchestrator's system prompt. */
  roster(exclude?: string): string {
    return [...this.agents.values()]
      .filter((a) => a.name !== exclude)
      .map((a) => `- ${a.emoji} ${a.name}: ${a.description}`)
      .join('\n')
  }
}

export async function loadAgentRegistry(cfg: Config): Promise<AgentRegistry> {
  const { agents, failed } = loadAgents(cfg.paths.agentsDir)
  for (const f of failed) log.error(`agent load failure: ${f}`)
  if (agents.size === 0) {
    throw new Error(`no agents loaded from ${cfg.paths.agentsDir}`)
  }
  if (!agents.has('orchestrator')) {
    throw new Error(`no 'orchestrator' agent found in ${cfg.paths.agentsDir}`)
  }
  return new AgentRegistry(agents)
}
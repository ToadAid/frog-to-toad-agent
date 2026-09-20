import { z } from 'zod'
import type { Config } from '../config.js'
import type { AgentDef, ApprovalRequest, ApprovalDecision, TelegramSender, TurnActorContext } from '../types.js'

export type ToolContext = {
  cfg: Config
  agent: AgentDef
  runId: string
  chatId: number
  /** Code-owned initiating actor/source. Undefined is unknown, never principal. */
  actor?: TurnActorContext
  signal: AbortSignal
  /** Stream progress text to the user's chat. */
  notify: (text: string) => Promise<void>
  /** Guarded tools only: ask the human via Telegram approval card. */
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>
  /** Delegate with optional tool narrowing and isolated context. */
  callSubagent: (
    name: string,
    prompt: string,
    opts?: { toolAllowlist?: string[]; threadMode?: 'chat' | 'isolated' },
  ) => Promise<string>
  /** Fan out read-only scouts in parallel. */
  callScouts: (scouts: Array<{ agent: string; prompt: string }>) => Promise<string>
  /** Skills may narrow the current run's effective toolset, never widen it. */
  restrictTools?: (names: string[]) => void
  /** Low-level sender (used by e.g. send_alert). */
  send: TelegramSender
  /** Optional idle recipient wake request; absent keeps mailbox delivery run-bound. */
  requestMailboxWake?: (to: string, from: string) => Promise<
    'spawned' | 'deduped' | 'budget' | 'disabled' | 'unknown-agent' | 'empty'
  >
}

export type ToolResult = { text: string; data?: unknown }

export type ToolSpec<I> = {
  name: string
  description: string
  input: z.ZodType<I>
  /** 'trade' tools additionally pass guard.ts checks inside execute. */
  danger: 'readonly' | 'write' | 'trade'
  approvalRequest?: (input: I, ctx: ToolContext) => Promise<ApprovalRequest | { error: string }>
  onApprovalDecision?: (input: I, decision: ApprovalDecision, ctx: ToolContext) => Promise<void>
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult>
}

export type AnyToolSpec = ToolSpec<Record<string, unknown>> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Type-safe helper: define a tool, erasing the input generic for registration. */
export function defineTool<I extends Record<string, unknown>>(spec: ToolSpec<I>): AnyToolSpec {
  return spec as unknown as AnyToolSpec
}

export class ToolRegistry {
  private tools = new Map<string, AnyToolSpec>()

  register(...tools: AnyToolSpec[]): void {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`duplicate tool name: ${tool.name}`)
      }
      this.tools.set(tool.name, tool)
    }
  }

  get(name: string): AnyToolSpec | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()].sort()
  }

  /** Filter to the agent's frontmatter allowlist (undefined = all tools). */
  forAgent(agent: AgentDef): AnyToolSpec[] {
    if (agent.tools === undefined) return [...this.tools.values()]
    const out: AnyToolSpec[] = []
    for (const name of agent.tools) {
      const tool = this.tools.get(name)
      if (tool) out.push(tool)
    }
    return out
  }
}

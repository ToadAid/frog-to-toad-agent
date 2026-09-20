// Plan-first run mode (PR 6) — the governance-sensitive cut. The permission
// boundary is the point: plan phase cannot reach write/trade tools, NOTHING
// executes without the principal's 'allow' through the existing approval
// gate, and every failure path (no gate / deny / timeout / empty plan /
// abort) leaves the desk untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry, defineTool, type AnyToolSpec } from '../src/tools/registry.js'
import { spawnSubagentTool } from '../src/tools/spawn.js'
import type { LlmClient } from '../src/llm/client.js'
import { createNullSender } from '../src/telegram/bot.js'
import { startPlanFirstRun } from '../src/loop/planMode.js'
import { resetThread } from '../src/loop/context.js'
import { sleep } from '../src/http.js'
import type { ApprovalRequest, ChatMessage, TurnActorContext } from '../src/types.js'
import { z } from 'zod'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-planmode-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const chat of [246960001, 246960002, 246960003, 246960004, 246960005, 246960006]) resetThread(chat)
})

let writeCalls = 0
const dangerWrite: AnyToolSpec = defineTool({
  name: 'danger_write',
  description: 'mutating tool — the plan boundary',
  danger: 'write',
  input: z.object({}),
  execute: async () => {
    writeCalls++
    return { text: 'mutated' }
  },
})
const dummyRead: AnyToolSpec = defineTool({
  name: 'dummy_read',
  description: 'readonly tool',
  danger: 'readonly',
  input: z.object({}),
  execute: async () => ({ text: 'ok' }),
})

function toolRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(dangerWrite, dummyRead, spawnSubagentTool)
  return r
}

function registry() {
  return new AgentRegistry(
    new Map([
      ['orchestrator', { name: 'orchestrator', emoji: '🎯', description: 'd', maxTurns: 3, systemPrompt: 'x' }],
    ]),
  )
}

const PLAN_TEXT = 'PLAN: 1. research the pair 2. size the entry 3. execute'

type Turn = { text?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }

/** Brain routed by the LAST message: plan-mode turns, execution turns, tool results. */
function planBrain(opts: { seenUserTexts: string[]; planTurn?: Turn; execTurn?: Turn }): LlmClient {
  let approved = false
  return {
    model: 'scripted',
    async complete(req) {
      const last = req.messages[req.messages.length - 1]!
      if (last.role === 'user') {
        const text = String(last.content)
        opts.seenUserTexts.push(text)
        if (text.startsWith('[plan-mode]')) return result(opts.planTurn ?? { text: PLAN_TEXT })
        if (text.startsWith('[approved plan')) {
          approved = true
          return result(opts.execTurn ?? { text: 'executed for real' })
        }
      }
      // a tool result: the plan run ends with the plan text; the execution
      // run ends with its own final text
      return result({ text: approved ? 'after-tool text' : PLAN_TEXT })
    },
  }
}

function result(turn: Turn) {
  if (turn.toolCalls) {
    return {
      message: {
        role: 'assistant' as const,
        content: null,
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      },
      usage: { in: 1, out: 1 },
    }
  }
  return { message: { role: 'assistant' as const, content: turn.text ?? '' }, usage: { in: 1, out: 1 } }
}

type Gate = (req: ApprovalRequest, chatId: number, signal: AbortSignal) => Promise<'allow' | 'deny' | 'timeout' | 'no_channel'>

const PRINCIPAL_ACTOR: TurnActorContext = { source: 'principal_operator', displayName: 'Principal operator' }
const GUEST_ACTOR: TurnActorContext = {
  source: 'telegram_user',
  transport: 'telegram',
  chatType: 'private',
  displayName: 'Guest',
  isBot: false,
  ownerBindingConfigured: true,
  transportIdentityPresent: true,
  ownerIdentityMatch: false,
  authorityGranted: false,
  principalAuthenticated: false,
}

function setup(
  brain: LlmClient,
  gate?: Gate,
  userText = 'rebalance the LP position',
  actor: TurnActorContext = PRINCIPAL_ACTOR,
) {
  const handle = startPlanFirstRun({
    cfg,
    agentRegistry: registry(),
    toolRegistry: toolRegistry(),
    llm: brain,
    send: createNullSender(),
    chatId: 246960001,
    agentName: 'orchestrator',
    userText,
    actor,
    approvalGate: gate,
  })
  return { handle }
}

function artifactFor(runId: string): string {
  const file = path.join(dir, 'data', 'plans', `${runId}.md`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

describe('plan-first run mode — the permission boundary', () => {
  it('the PLAN phase cannot reach write tools, even when the brain tries', async () => {
    writeCalls = 0
    const seenUserTexts: string[] = []
    const brain = planBrain({
      seenUserTexts,
      planTurn: { toolCalls: [{ id: 'p1', name: 'danger_write', arguments: '{}' }] },
    })
    const { handle } = setup(brain)
    const summary = await handle.done
    expect(writeCalls).toBe(0) // THE boundary: plan phase never mutates
    expect(seenUserTexts.some((t) => t.startsWith('[approved plan'))).toBe(false) // nothing executed
    expect(summary.finalText).toContain('PLAN:')
    expect(summary.finalText).toContain('not approved (no_channel)') // no gate ⇒ fail-closed
    const { runId } = summary
    expect(artifactFor(runId)).toContain('status: PENDING')
  })

  it('no approval gate ⇒ no execution, plan stays PENDING', async () => {
    const seenUserTexts: string[] = []
    const brain = planBrain({ seenUserTexts })
    const { handle } = setup(brain)
    const summary = await handle.done
    expect(seenUserTexts.some((t) => t.startsWith('[approved plan'))).toBe(false)
    expect(artifactFor(summary.runId)).toContain('status: PENDING')
    expect(summary.finalText).toContain('nothing was executed')
  })

  it('deny ⇒ REJECTED artifact, nothing executed', async () => {
    const seen: ApprovalRequest[] = []
    const gate: Gate = async (req) => {
      seen.push(req)
      return 'deny'
    }
    const seenUserTexts: string[] = []
    const brain = planBrain({ seenUserTexts })
    const { handle } = setup(brain, gate)
    const summary = await handle.done
    expect(seen).toHaveLength(1)
    expect(seen[0]!.tool).toBe('plan_approval')
    expect(seen[0]!.danger).toBe('write')
    expect(seenUserTexts.some((t) => t.startsWith('[approved plan'))).toBe(false)
    expect(artifactFor(summary.runId)).toContain('status: REJECTED')
    expect(summary.finalText).toContain('PLAN:')
  })

  it('timeout ⇒ PENDING artifact, nothing executed (timeout = deny)', async () => {
    const gate: Gate = async () => 'timeout'
    const brain = planBrain({ seenUserTexts: [] })
    const { handle } = setup(brain, gate)
    const summary = await handle.done
    expect(artifactFor(summary.runId)).toContain('status: PENDING')
  })

  it("allow ⇒ the execution run starts and MAY use write tools (the flip is principal-gated)", async () => {
    writeCalls = 0
    const gate: Gate = async () => 'allow'
    const seenUserTexts: string[] = []
    const brain = planBrain({
      seenUserTexts,
      execTurn: { toolCalls: [{ id: 'e1', name: 'danger_write', arguments: '{}' }] },
    })
    const { handle } = setup(brain, gate)
    const summary = await handle.done
    expect(writeCalls).toBe(1) // exactly the execution phase's single write
    expect(seenUserTexts.some((t) => t.startsWith('[approved plan'))).toBe(true)
    expect(summary.finalText).toBe('after-tool text') // the execution run's final text
    // the artifact lives under the PLAN run's id — the handle exposes it
    expect(handle.planArtifact).toContain('data/plans/')
    expect(fs.readFileSync(handle.planArtifact, 'utf8')).toContain('status: APPROVED')
    // the execution run is seeded with the approved plan
    expect(seenUserTexts.find((t) => t.startsWith('[approved plan'))).toContain('PLAN: 1. research')
  })

  it('approval never upgrades a guest-originated plan into principal write authority', async () => {
    writeCalls = 0
    const seenUserTexts: string[] = []
    const brain = planBrain({
      seenUserTexts,
      execTurn: { toolCalls: [{ id: 'guest-e1', name: 'danger_write', arguments: '{}' }] },
    })
    const { handle } = setup(brain, async () => 'allow', 'rebalance the LP position', GUEST_ACTOR)
    const summary = await handle.done

    expect(seenUserTexts.some((t) => t.startsWith('[approved plan'))).toBe(true)
    expect(writeCalls).toBe(0)
    expect(summary.finalText).toBe('after-tool text')
  })

  it('empty plan ⇒ no artifact, gate never asked, nothing executed', async () => {
    let gateCalls = 0
    const gate: Gate = async () => {
      gateCalls++
      return 'allow'
    }
    const seenUserTexts: string[] = []
    const brain = planBrain({ seenUserTexts, planTurn: { text: '  ' } })
    const { handle } = setup(brain, gate)
    const summary = await handle.done
    expect(gateCalls).toBe(0)
    expect(seenUserTexts.some((t) => t.startsWith('[approved plan'))).toBe(false)
    expect(artifactFor(summary.runId)).toBe('')
    expect(summary.finalText.trim()).toBe('')
  })

  it('aborting the composite handle aborts the live phase', async () => {
    const brain: LlmClient = {
      model: 'slow',
      async complete() {
        await sleep(5_000)
        return { message: { role: 'assistant', content: 'never' } }
      },
    }
    const { handle } = setup(brain)
    handle.abort()
    const summary = await handle.done
    expect(summary.aborted).toBe(true)
    expect(artifactFor(summary.runId)).toBe('')
  })
})

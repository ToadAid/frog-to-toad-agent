import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { startRun } from '../src/loop/agentLoop.js'
import { appendToThread, getThread, readTranscriptSnapshot, resetThread } from '../src/loop/context.js'
import {
  clearSkillCommandCache,
  loadSkillCommands,
  resolveSkillInvocation,
  skillExecutionOptions,
} from '../src/skills/commands.js'
import { createNullSender } from '../src/telegram/bot.js'
import { ToolRegistry, defineTool } from '../src/tools/registry.js'
import { skillTool } from '../src/tools/skill.js'
import type { ChatMessage, ToolDef } from '../src/types.js'
import type { LlmClient } from '../src/llm/client.js'

const SENTINEL = 'DIRECT_SLASH_PARENT_SENTINEL_123'
let dir: string
let cfg: Config

function mkSkill(name: string, front: string): void {
  const skillDir = path.join(dir, 'skills', name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${front}\n---\n# ${name}\nrun the playbook`)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-direct-slash-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  mkSkill('forked', 'description: forked\ncontext: fork\nallowed-tools: market_price')
  mkSkill('inline', 'description: inline\ncontext: inline\nallowed-tools: market_price')
  cfg = loadConfig()
  clearSkillCommandCache()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearSkillCommandCache()
})

function agents(tools: string[]): AgentRegistry {
  return new AgentRegistry(new Map([['orchestrator', {
    name: 'orchestrator', emoji: '🎯', description: 'test', maxTurns: 4, systemPrompt: 'test', tools,
  }]]))
}

function toolRegistry(reached: string[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of ['market_price', 'memory_save']) {
    registry.register(defineTool({
      name,
      description: name,
      danger: name === 'memory_save' ? 'write' : 'readonly',
      input: z.object({}),
      execute: async () => {
        reached.push(name)
        return { text: `${name} result` }
      },
    }))
  }
  return registry
}

type Turn = { text: string } | { tool: string }
function recordingLlm(turns: Turn[]): { client: LlmClient; requests: Array<{ messages: ChatMessage[]; tools: ToolDef[] }> } {
  const requests: Array<{ messages: ChatMessage[]; tools: ToolDef[] }> = []
  let index = 0
  return {
    requests,
    client: {
      model: 'mock',
      complete: async ({ messages, tools }) => {
        requests.push({ messages, tools })
        const turn = turns[index++]
        if (turn === undefined) throw new Error('script exhausted')
        if ('tool' in turn) {
          return {
            message: { role: 'assistant' as const, content: null, tool_calls: [{
              id: `call-${index}`, type: 'function' as const, function: { name: turn.tool, arguments: '{}' },
            }] },
            usage: { in: 1, out: 1 },
          }
        }
        return { message: { role: 'assistant' as const, content: turn.text }, usage: { in: 1, out: 1 } }
      },
    },
  }
}

function directInvocation(name: string) {
  const resolved = resolveSkillInvocation(loadSkillCommands(cfg.paths.skillsDir).commands, `/${name}`)
  if (resolved?.kind !== 'invoke') throw new Error(`/${name} did not resolve`)
  return resolved
}

describe('direct /skill execution metadata', () => {
  it('fork is fresh, transcript-clean, narrowed, and returns its final result', async () => {
    const chatId = 78101
    resetThread(chatId)
    appendToThread(cfg, getThread(cfg, chatId), { role: 'user', content: SENTINEL })
    const reached: string[] = []
    const llm = recordingLlm([{ tool: 'memory_save' }, { tool: 'market_price' }, { text: 'direct fork result' }])
    const invocation = directInvocation('forked')
    const summary = await startRun({
      cfg,
      agentRegistry: agents(['market_price', 'memory_save']),
      toolRegistry: toolRegistry(reached),
      llm: llm.client,
      send: createNullSender(),
      chatId,
      agentName: 'orchestrator',
      userText: invocation.text,
      ...skillExecutionOptions(invocation.command),
    }).done

    expect(summary.finalText).toBe('direct fork result')
    expect(llm.requests.every((r) => !JSON.stringify(r.messages).includes(SENTINEL))).toBe(true)
    expect(llm.requests[0]!.tools.map((t) => t.function.name)).toEqual(['market_price'])
    expect(reached).toEqual(['market_price'])
    expect(getThread(cfg, chatId).messages).toEqual([{ role: 'user', content: SENTINEL }])
    const transcript = readTranscriptSnapshot(cfg, chatId)
    expect(transcript.ok && transcript.records.join('\n')).not.toContain('direct fork result')
    expect(transcript.ok && transcript.records.join('\n')).not.toContain('memory_save')
  })

  it('allowed-tools cannot grant a tool the parent agent lacks', async () => {
    const invocation = directInvocation('forked')
    const llm = recordingLlm([{ text: 'no grant' }])
    await startRun({
      cfg,
      agentRegistry: agents(['memory_save']),
      toolRegistry: toolRegistry([]),
      llm: llm.client,
      send: createNullSender(),
      chatId: 78102,
      agentName: 'orchestrator',
      userText: invocation.text,
      ...skillExecutionOptions(invocation.command),
    }).done
    expect(llm.requests[0]!.tools).toEqual([])
  })

  it('inline stays in ordinary chat context while honoring narrowing', async () => {
    const chatId = 78103
    resetThread(chatId)
    appendToThread(cfg, getThread(cfg, chatId), { role: 'user', content: SENTINEL })
    const invocation = directInvocation('inline')
    const llm = recordingLlm([{ text: 'inline result' }])
    await startRun({
      cfg,
      agentRegistry: agents(['market_price', 'memory_save']),
      toolRegistry: toolRegistry([]),
      llm: llm.client,
      send: createNullSender(),
      chatId,
      agentName: 'orchestrator',
      userText: invocation.text,
      ...skillExecutionOptions(invocation.command),
    }).done
    expect(JSON.stringify(llm.requests[0]!.messages)).toContain(SENTINEL)
    expect(llm.requests[0]!.tools.map((t) => t.function.name)).toEqual(['market_price'])
    expect(getThread(cfg, chatId).messages.some((m) => 'content' in m && m.content === 'inline result')).toBe(true)
  })

  it('model-tool and direct slash consume identical fork metadata', async () => {
    const invocation = directInvocation('forked')
    let modelOpts: unknown
    await skillTool.execute({ skill: 'forked' }, {
      cfg,
      agent: agents(['skill']).get('orchestrator')!,
      callSubagent: async (_name: string, _prompt: string, opts?: unknown) => {
        modelOpts = opts
        return 'done'
      },
      restrictTools: () => {},
    } as never)
    expect(modelOpts).toEqual(skillExecutionOptions(invocation.command))
    expect(modelOpts).toEqual({ threadMode: 'isolated', toolAllowlist: ['market_price'] })
  })
})

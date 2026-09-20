// Magic docs (PR 7): `# MAGIC DOC:` files read from the sandbox are living
// documents — registered on read, refreshed with the conversation's learnings
// by an after-turn hook. The header is preserved STRUCTURALLY (the hook writes
// it, the model only supplies the body), the writer is jailed to data/sandbox,
// and the whole lane is gated on handsGateOpen.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { workspaceReadTool, workspaceWriteTool } from '../src/tools/workspace.js'
import { createMockLlmClient } from '../src/llm/mock.js'
import type { LlmClient } from '../src/llm/client.js'
import { createNullSender } from '../src/telegram/bot.js'
import { principalOperatorActor } from '../src/telegram/actor.js'
import { startRun } from '../src/loop/agentLoop.js'
import { clearAfterTurnHooks } from '../src/loop/afterTurn.js'
import { resetThread } from '../src/loop/context.js'
import {
  detectMagicDocHeader,
  flushMagicDocsRefreshForTests,
  registerMagicDocsHook,
  resetMagicDocsStateForTests,
  trackedMagicDocCount,
} from '../src/loop/magicDocs.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-magicdocs-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  resetThread(246970100)
})

beforeEach(() => {
  clearAfterTurnHooks()
  resetMagicDocsStateForTests()
  // Open hands: the doctor is the law — magic docs stay shut while gated.
  fs.mkdirSync(path.join(cfg.paths.dataDir, 'state'), { recursive: true })
  fs.writeFileSync(
    path.join(cfg.paths.dataDir, 'state', 'doctor.json'),
    JSON.stringify({ lastRunTs: Date.now(), cheapOk: true, lastTestGreenAt: Date.now() }),
  )
})

const ORCH = { name: 'orchestrator', emoji: '🎯', description: 'd', maxTurns: 2, systemPrompt: 'x' }
const registry = () => new AgentRegistry(new Map([[ORCH.name, ORCH]]))
const tools = (): ToolRegistry => {
  const reg = new ToolRegistry()
  reg.register(workspaceReadTool)
  reg.register(workspaceWriteTool)
  return reg
}

const DOC = 'notes/playbook.md'
const HEADER = '# MAGIC DOC: desk playbook'
const INSTRUCTIONS = '_keep it terse — desk laws only_'
const OLD_BODY = 'The playbook body from yesterday.'

async function writeDoc(content: string): Promise<void> {
  fs.mkdirSync(path.join(cfg.paths.dataDir, 'sandbox', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(cfg.paths.dataDir, 'sandbox', DOC), content)
}

/** Read the doc through the agent's own hands — that's what registers it. */
async function readDocViaAgent(): Promise<void> {
  const handle = startRun({
    cfg,
    agentRegistry: registry(),
    toolRegistry: tools(),
    llm: createMockLlmClient([{ toolCalls: [{ id: 'r1', name: 'workspace_read', arguments: JSON.stringify({ path: DOC }) }] }, { text: 'read it' }]),
    send: createNullSender(),
    chatId: 246970100,
    agentName: 'orchestrator',
    userText: 'read the playbook',
  })
  await handle.done
  await flushMagicDocsRefreshForTests()
}

async function runTurn(llmScript: Parameters<typeof createMockLlmClient>[0]): Promise<void> {
  const handle = startRun({
    cfg,
    agentRegistry: registry(),
    toolRegistry: tools(),
    llm: createMockLlmClient(llmScript),
    send: createNullSender(),
    chatId: 246970100,
    agentName: 'orchestrator',
    userText: 'soak notes',
  })
  await handle.done
  await flushMagicDocsRefreshForTests()
}

const readDocOnDisk = (): string => fs.readFileSync(path.join(cfg.paths.dataDir, 'sandbox', DOC), 'utf8')

describe('header detection', () => {
  it('detects title + optional italic instruction line', () => {
    expect(detectMagicDocHeader(`${HEADER}\n${INSTRUCTIONS}\n\nbody`)).toEqual({
      title: 'desk playbook',
      instructions: 'keep it terse — desk laws only',
    })
    expect(detectMagicDocHeader('# MAGIC DOC:  plain title \nbody')).toEqual({ title: 'plain title' })
    expect(detectMagicDocHeader('# just a markdown heading\nbody')).toBeNull()
    expect(detectMagicDocHeader('')).toBeNull()
  })
})

describe('registration on read + background refresh', () => {
  it('does not hold the principal run open while the maintenance LLM is slow', async () => {
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n\n${OLD_BODY}`)
    await readDocViaAgent()

    let releaseUpdate!: (value: Awaited<ReturnType<LlmClient['complete']>>) => void
    let signalUpdateStarted!: () => void
    const updateStarted = new Promise<void>((resolve) => { signalUpdateStarted = resolve })
    const slowUpdate = new Promise<Awaited<ReturnType<LlmClient['complete']>>>((resolve) => {
      releaseUpdate = resolve
    })
    let calls = 0
    const llm: LlmClient = {
      model: 'slow-maintenance',
      async complete() {
        calls++
        if (calls === 1) return { message: { role: 'assistant', content: 'principal answer' } }
        signalUpdateStarted()
        return slowUpdate
      },
    }
    const handle = startRun({
      cfg, agentRegistry: registry(), toolRegistry: tools(), llm,
      send: createNullSender(), chatId: 246970100, agentName: 'orchestrator',
      userText: 'answer without waiting for document upkeep', actor: principalOperatorActor(246970100),
    })

    await updateStarted
    await expect(handle.done).resolves.toMatchObject({ finalText: 'principal answer' })
    expect(readDocOnDisk()).toContain(OLD_BODY)

    releaseUpdate({ message: { role: 'assistant', content: 'updated after response' } })
    await flushMagicDocsRefreshForTests()
    expect(readDocOnDisk()).toContain('updated after response')
  })

  it('a read doc is tracked and refreshed after an idle top-level run — header intact', async () => {
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n${INSTRUCTIONS}\n\n${OLD_BODY}`)
    await readDocViaAgent()
    expect(trackedMagicDocCount()).toBe(1)

    // turn 1 = the run's final; turn 2 = the magic-docs update call
    await runTurn([{ text: 'Learned: the 0.618 retrace held again today.' }, { text: 'Playbook updated with the retrace law.\nAdded the new spread floor.' }])

    const updated = readDocOnDisk()
    expect(updated.startsWith(`${HEADER}\n${INSTRUCTIONS}\n\n`)).toBe(true) // header + instructions, structurally preserved
    expect(updated).toContain('retrace law')
    expect(updated).not.toContain(OLD_BODY) // replaced in place, not appended
  })

  it('NO_UPDATE leaves the file byte-identical', async () => {
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n\n${OLD_BODY}`)
    await readDocViaAgent()
    const before = readDocOnDisk()

    await runTurn([{ text: 'nothing new' }, { text: 'NO_UPDATE' }])

    expect(readDocOnDisk()).toBe(before)
  })

  it('the model cannot mangle the header — it only supplies the body', async () => {
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n\n${OLD_BODY}`)
    await readDocViaAgent()

    // The model "helpfully" repeats a WRONG header — the hook must overwrite it.
    await runTurn([{ text: 'ok' }, { text: '# MAGIC DOC: hijacked title\nbody from a confused model' }])

    const updated = readDocOnDisk()
    expect(updated.startsWith(`${HEADER}\n`)).toBe(true)
    expect(updated).not.toContain('hijacked title')
    expect(updated).toContain('body from a confused model')
  })

  it('a file that lost its header is untracked — the next run leaves it alone', async () => {
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n\n${OLD_BODY}`)
    await readDocViaAgent()
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'sandbox', DOC), 'ordinary notes now')
    const before = readDocOnDisk()

    await runTurn([{ text: 'done' }, { text: 'should never be written' }])

    expect(readDocOnDisk()).toBe(before)
    expect(trackedMagicDocCount()).toBe(0)
  })
})

describe('the governance laws', () => {
  it('hands gated → the whole lane stays shut (no LLM call, no write)', async () => {
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n\n${OLD_BODY}`)
    await readDocViaAgent()
    fs.writeFileSync(
      path.join(cfg.paths.dataDir, 'state', 'doctor.json'),
      JSON.stringify({ lastRunTs: Date.now(), cheapOk: false, lastTestGreenAt: Date.now() }),
    )
    const before = readDocOnDisk()

    // turn 2 would be the update call — with hands gated the mock never
    // reaches it, so the script would fail loudly if the lane ran.
    await runTurn([{ text: 'done' }])

    expect(readDocOnDisk()).toBe(before)
  })

  it('a run that ended mid-tool-call never triggers an update', async () => {
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n\n${OLD_BODY}`)
    await readDocViaAgent()
    const before = readDocOnDisk()

    // maxTurns=2 with a tool call on turn 2 → last thread message is a tool
    // result, not an idle assistant turn.
    const handle = startRun({
      cfg,
      agentRegistry: registry(),
      toolRegistry: tools(),
      llm: createMockLlmClient([
        { text: 'thinking' },
        { toolCalls: [{ id: 't9', name: 'workspace_read', arguments: JSON.stringify({ path: DOC }) }] },
        { text: 'should never be written' },
      ]),
      send: createNullSender(),
      chatId: 246970100,
      agentName: 'orchestrator',
      userText: 'busy run',
    })
    await handle.done
    expect(readDocOnDisk()).toBe(before)
  })

  it('the writer stays jailed: a registered path is re-jailed at write time', async () => {
    // The jail is load-bearing twice: registration only accepts sandbox reads,
    // and writeSandboxFile re-resolves the path through the same jail. Prove
    // the write path refuses an escape without needing a malicious read.
    registerMagicDocsHook()
    await writeDoc(`${HEADER}\n\n${OLD_BODY}`)
    await readDocViaAgent()

    // Overwrite the doc's on-disk content with a symlink target OUTSIDE the
    // sandbox — the write must follow the jail, not the symlink.
    const outside = path.join(dir, 'escape.md')
    fs.writeFileSync(outside, 'outside')
    const docTarget = path.join(cfg.paths.dataDir, 'sandbox', DOC)
    fs.unlinkSync(docTarget)
    fs.symlinkSync(outside, docTarget)

    await runTurn([{ text: 'done' }, { text: 'jailbreak body' }])

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside') // untouched
  })
})

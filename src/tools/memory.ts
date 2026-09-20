import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from './registry.js'
import { log } from '../log.js'
import { applyWorkspaceOp, applyWorkspaceOpTo } from '../store/workspace.js'
import type { WorkspaceOp, WorkspaceTarget } from '../store/workspace.js'
import { applyUnverifiedUserWorkspaceOp } from '../memory/principalAdmission.js'
import { memoryFreshnessText } from '../memory/age.js'
import { mayMutatePrincipalMemory } from '../telegram/actor.js'

/**
 * Per-agent memory files (the fork's agentMemory.ts design): each agent may
 * write/read ONLY data/memory/<agentName>.md — path traversal is checked
 * against the resolved data dir.
 */

function memoryFileFor(cfgDataDir: string, agentName: string): string {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, '')
  if (safe !== agentName || safe === '') {
    throw new Error(`invalid agent name for memory: '${agentName}'`)
  }
  const dir = path.resolve(cfgDataDir, 'memory')
  const file = path.resolve(dir, `${safe}.md`)
  if (!file.startsWith(dir + path.sep)) {
    throw new Error('memory path traversal blocked')
  }
  return file
}

export const memorySaveTool = defineTool({
  name: 'memory_save',
  description:
    'Persist durable knowledge so the desk GROWS — not conversation logs. Memory is a HOT CACHE: the durable ' +
    'home for anything long or archival is the journal / durable notes file (ONE write there), never a re-save ' +
    'loop here. Three stores: "self" (your own working notes), "desk" (facts any agent will need: feed quirks, ' +
    'provider behavior), "user" (UNVERIFIED working notes about the principal — ORCHESTRATOR ONLY; never a ' +
    'principal declaration or standing policy). Actions: add (new fact), replace (correct a wrong one — pass a ' +
    'short unique substring of the old entry), remove (delete a stale one). BATCH LAW: several additions go in ' +
    'ONE call — pass `entries` (array) instead of `content`; never re-save evicted entries one-by-one (each ' +
    'save evicts the next-oldest and the restore never finishes). Entries are §-delimited and char-capped; ' +
    'Memory loads next run; writes never mutate the current run.',
  danger: 'write',
  input: z.object({
    target: z.enum(['self', 'desk', 'user']).default('self'),
    action: z.enum(['add', 'replace', 'remove']),
    content: z.string().optional().describe('the entry (add/replace); keep it one durable fact'),
    entries: z
      .array(z.string().min(1))
      .max(64)
      .optional()
      .describe('batch add: several entries in ONE call (replaces `content`); deduped against the store and each other'),
    find: z.string().optional().describe('short unique substring of the existing entry (replace/remove)'),
  }),
  execute: async (input, ctx) => {
    if (input.target === 'user' && !mayMutatePrincipalMemory(ctx.actor)) {
      return { text: '[error] USER.md mutation requires an authenticated principal-origin run' }
    }
    if (input.target === 'user' && ctx.agent.name !== 'orchestrator') {
      return { text: '[error] only the orchestrator writes to USER.md — delegate user-model updates through it' }
    }
    if (input.action !== 'add' && !input.find?.trim()) {
      return { text: '[error] replace/remove need `find` — a short unique substring of the existing entry' }
    }
    if (input.action === 'add' && input.entries && input.content?.trim()) {
      return { text: '[error] pass `entries` (batch) OR `content` (single) — not both' }
    }
    if (input.action === 'add' && !input.entries && !input.content?.trim()) {
      return { text: '[error] add needs `content` (one entry) or `entries` (batch)' }
    }
    if (input.action === 'replace' && !input.content?.trim()) {
      return { text: '[error] replace needs `content` — the entry text' }
    }
    const op: WorkspaceOp =
      input.action === 'add' && input.entries
        ? { action: 'add-many', contents: input.entries }
        : input.action === 'add'
          ? { action: 'add', content: input.content! }
          : input.action === 'remove'
            ? { action: 'remove', find: input.find! }
            : { action: 'replace', find: input.find!, content: input.content! }

    let result
    if (input.target === 'self') {
      result = applyWorkspaceOpTo(memoryFileFor(ctx.cfg.paths.dataDir, ctx.agent.name), op)
    } else if (input.target === 'user') {
      result = applyUnverifiedUserWorkspaceOp(ctx.cfg, op)
    } else {
      result = applyWorkspaceOp(ctx.cfg.paths.dataDir, input.target, op)
    }
    const label = input.target === 'self' ? `${ctx.agent.name}.md` : input.target.toUpperCase()
    if (!result.ok) {
      log.debug(`memory_save rejected: ${result.error}`)
      return { text: `[error] ${result.error}` }
    }
    log.debug(`memory_save: ${label} ${input.action} → ${result.entries} entries, ${result.chars} chars`)
    const base = input.target === 'user'
      ? `unverified working note saved to USER — ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}, ${result.chars} chars. ` +
        `Loads next run as UNVERIFIED_WORKING_NOTE; this is not a principal declaration or standing policy.`
      : `memory saved to ${label} — ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}, ${result.chars} chars. Loads next run.`
    // Auto-eviction is honest: the writer must SEE what was dropped — but the
    // nudge points at the DURABLE home, never back into this store. Re-saving
    // evicted entries one-by-one re-evicts the next-oldest and loops forever
    // (the carousel, 2026-09-13). Batch door: `entries` in ONE call.
    const evicted =
      result.evicted && result.evicted.length > 0
        ? ` EVICTED (oldest first) to fit the cap: ` +
          result.evicted.map((e) => `§${e.slice(0, 70)}${e.length > 70 ? '…' : ''}`).join(' | ') +
          ` — evicted is NOT lost (it lives in the journal / durable notes if it mattered). ` +
          `Do NOT re-save these here one-by-one — every save evicts the next-oldest and the restore never ends. ` +
          `If several entries must go back in, batch them in ONE memory_save call with \`entries\`; ` +
          `otherwise write the long form to the durable notes file instead.`
        : ''
    return { text: base + evicted }
  },
})

export const memoryReadTool = defineTool({
  name: 'memory_read',
  description: 'Read your own persistent memory file.',
  danger: 'readonly',
  input: z.object({}),
  execute: async (_input, ctx) => {
    const file = memoryFileFor(ctx.cfg.paths.dataDir, ctx.agent.name)
    // One opened file. One generation. One truth: bytes AND mtime come from
    // the SAME descriptor, so a concurrent temp+rename over the canonical
    // path can never label old bytes with a new file's freshness. Freshness
    // metadata may qualify memory; it may never erase memory — a failed
    // fstat returns the bare bytes, never invented emptiness.
    let fd: number | undefined
    try {
      try {
        fd = fs.openSync(file, 'r')
      } catch {
        return { text: '(memory is empty)' }
      }
      let content: string
      try {
        content = fs.readFileSync(fd, 'utf8').trim()
      } catch {
        return { text: '(memory is empty)' }
      }
      if (content === '') return { text: '(memory empty)' }
      let mtimeMs: number | undefined
      try {
        mtimeMs = fs.fstatSync(fd).mtimeMs
      } catch {
        // freshness evidence unavailable — advisory, so omit it by omission
      }
      if (mtimeMs === undefined) return { text: content }
      const fresh = memoryFreshnessText(mtimeMs)
      const note = fresh === '' ? '' : `[memory freshness] ${fresh}\n\n`
      return { text: note + content }
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* already closed — nothing to leak either way */
        }
      }
    }
  },
})

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from './registry.js'
import type { Config } from '../config.js'
import { appendJsonl } from '../store/jsonl.js'
import { handsGateOpen } from '../doctor/doctor.js'
import { log } from '../log.js'

/**
 * Workspace access (Phase 12.1) — the frog's SANDBOXED hands. Everything it
 * reads or writes lives inside `data/sandbox/` and ONLY there:
 *  - path-jail: realpath resolution + prefix check, symlinks refused
 *    (a symlink is an escape hatch out of the jail)
 *  - NOTHING in the sandbox ever executes via these tools — 12.3 gates exec
 *    separately with its own allowlist
 *  - size caps both ways (reads that would flood the LLM context, writes that
 *    would fill the disk)
 *  - binary sniff before read (no binaries into the brain's context)
 *  - atomic writes (tmp + rename — the workspace discipline)
 *  - every operation journaled to data/sandbox/.ops.jsonl (append-only truth)
 */

export const READ_MAX_BYTES = 64 * 1024
export const WRITE_MAX_BYTES = 1024 * 1024
const LIST_MAX_ENTRIES = 200

export function sandboxRoot(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'sandbox')
}

/** Source mirror is readable context, never writable scratch space. */
export function isProtectedSandboxPath(relPath: string): boolean {
  // Normalize dot segments before classification so lexical aliases such as
  // scratch/../repo/src/index.ts cannot bypass the read-only mirror boundary.
  const slashNormalized = relPath.replaceAll('\\', '/')
  const normalized = path.posix.normalize(slashNormalized).replace(/^(?:\.\/)+/, '')
  return normalized === 'repo' || normalized.startsWith('repo/')
}

/** The jail: resolve a sandbox-relative path and REFUSE anything outside. */
export function jailResolve(cfg: Config, relPath: string): string {
  const root = sandboxRoot(cfg)
  fs.mkdirSync(root, { recursive: true }) // the jail self-heals — first touch creates it
  const target = path.resolve(root, relPath)
  // No symlink anywhere along the path — a symlink is an escape hatch out of the jail.
  const rel = path.relative(root, target)
  let walked = root
  for (const part of rel.split(path.sep)) {
    if (part === '') continue
    walked = path.join(walked, part)
    try {
      if (fs.lstatSync(walked).isSymbolicLink()) {
        throw new Error(`symlink escapes the sandbox jail: ${relPath}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('jail')) throw e
      // missing component — fine, the target may not exist yet
    }
  }
  // realpath on the deepest EXISTING ancestor (the target may not exist yet —
  // writes create files), then the prefix check.
  let probe = target
  while (probe !== root && !fs.existsSync(probe)) {
    probe = path.dirname(probe)
  }
  const real = fs.realpathSync(probe)
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`path escapes the sandbox jail: ${relPath}`)
  }
  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync(target)
    if (realTarget !== target && !realTarget.startsWith(root + path.sep)) {
      throw new Error(`symlink escapes the sandbox jail: ${relPath}`)
    }
    return realTarget
  }
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the sandbox jail: ${relPath}`)
  }
  return target
}

/** Text sniff: reject binaries (null bytes or heavy non-printable ratio) before they reach the brain. */
export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192)
  if (sample.includes(0)) return true
  let nonText = 0
  for (const b of sample) {
    // printable ASCII + tab/lf/cr + utf8 continuation ranges are fine
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 128) continue
    nonText++
  }
  return nonText / sample.length > 0.1
}

function journalOp(cfg: Config, op: string, detail: Record<string, unknown>, agent: string): void {
  try {
    appendJsonl(path.join(sandboxRoot(cfg), '.ops.jsonl'), { ts: Date.now(), op, agent, ...detail })
  } catch (e) {
    log.warn(`workspace journal failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── Read listeners (magic docs seam, PR 7) ───────────────────────────────────
// The mother detects `# MAGIC DOC:` headers with a FileReadTool listener; the
// desk's read lane is workspace_read, so listeners ride it. Listeners observe
// only — they cannot alter the read result.
export type WorkspaceReadListener = (relPath: string, content: string) => void
const readListeners: WorkspaceReadListener[] = []

export function registerWorkspaceReadListener(listener: WorkspaceReadListener): void {
  readListeners.push(listener)
}

export function clearWorkspaceReadListeners(): void {
  readListeners.length = 0
}

/**
 * Shared write discipline (cap → null-byte sniff → protected-path check →
 * jail → mkdir → .bak → atomic tmp+rename → journal). Both the agent's
 * workspace_write and the magic-docs background writer go through this —
 * one discipline, no second-class writers.
 */
export function writeSandboxFile(
  cfg: Config,
  relPath: string,
  content: string,
  agent: string,
): { ok: true; bytes: number } | { ok: false; error: string } {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > WRITE_MAX_BYTES) {
    return { ok: false, error: `content is ${bytes} bytes — over the ${WRITE_MAX_BYTES}-byte write cap` }
  }
  if (content.includes('\0')) {
    return { ok: false, error: 'content contains null bytes — text files only' }
  }
  if (isProtectedSandboxPath(relPath)) {
    return { ok: false, error: `sandbox:${relPath} is in the read-only repo mirror` }
  }
  let target: string
  try {
    target = jailResolve(cfg, relPath)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) {
      // Keep exactly one previous version — cheap undo for the coding flow.
      fs.copyFileSync(target, `${target}.bak`)
    }
    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, target)
  } catch (e) {
    return { ok: false, error: `write failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  journalOp(cfg, 'write', { path: relPath, bytes }, agent)
  return { ok: true, bytes }
}

/** Shared execute-time hands check (defense in depth — the gate ships first). */
function handsCheck(cfg: Config): string | undefined {
  if (handsGateOpen(cfg)) return undefined
  return '[error] hands are gated: doctor is unhealthy or has never run a full check (npm run doctor). Workspace access is refused.'
}

export const workspaceReadTool = defineTool({
  name: 'workspace_read',
  description:
    'Read a text file from your SANDBOX workspace (data/sandbox/ — the only place you can touch). ' +
    'Relative path. Text files only (binaries refused), 64KB read cap.',
  danger: 'readonly',
  input: z.object({ path: z.string().describe('path INSIDE the sandbox, e.g. "notes/btc.md"') }),
  execute: async (input, ctx) => {
    const gated = handsCheck(ctx.cfg)
    if (gated) return { text: gated }
    let target: string
    try {
      target = jailResolve(ctx.cfg, input.path)
    } catch (e) {
      return { text: `[error] ${e instanceof Error ? e.message : String(e)}` }
    }
    let buf: Buffer
    try {
      const stat = fs.statSync(target)
      if (stat.isDirectory()) return { text: `[error] '${input.path}' is a directory — use workspace_list` }
      if (stat.size > READ_MAX_BYTES) {
        return { text: `[error] '${input.path}' is ${stat.size} bytes — over the ${READ_MAX_BYTES}-byte read cap. Split it or read a narrower file.` }
      }
      buf = fs.readFileSync(target)
    } catch {
      return { text: `[error] cannot read '${input.path}' (missing or unreadable inside the sandbox)` }
    }
    if (looksBinary(buf)) {
      return { text: `[error] '${input.path}' looks binary — refusing to put it into context` }
    }
    const content = buf.toString('utf8')
    for (const listener of readListeners) {
      try {
        listener(input.path, content)
      } catch (e) {
        log.warn(`workspace read listener failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    journalOp(ctx.cfg, 'read', { path: input.path, bytes: buf.length }, ctx.agent.name)
    return { text: content }
  },
})

export const workspaceWriteTool = defineTool({
  name: 'workspace_write',
  description:
    'Write a text file into your SANDBOX workspace (data/sandbox/ — the only place you can touch). ' +
    'Creates parent dirs; 1MB cap; atomic write; the previous version is kept as <name>.bak. ' +
    'Nothing written here ever executes on its own.',
  danger: 'write',
  input: z.object({
    path: z.string().describe('path INSIDE the sandbox, e.g. "notes/btc.md"'),
    content: z.string().describe('full file content (overwrite semantics)'),
  }),
  execute: async (input, ctx) => {
    const gated = handsCheck(ctx.cfg)
    if (gated) return { text: gated }
    const res = writeSandboxFile(ctx.cfg, input.path, input.content, ctx.agent.name)
    if (!res.ok) return { text: `[error] ${res.error}` }
    return { text: `✍️ wrote sandbox:${input.path} (${res.bytes} bytes)` }
  },
})

export const workspaceListToolDef = defineTool({
  name: 'workspace_list',
  description: 'List files in your SANDBOX workspace (data/sandbox/) with sizes. The .ops.jsonl journal is hidden.',
  danger: 'readonly',
  input: z.object({
    subdir: z.string().optional().describe('optional subdirectory to list (default: sandbox root)'),
  }),
  execute: async (input, ctx) => {
    const gated = handsCheck(ctx.cfg)
    if (gated) return { text: gated }
    const sandbox = sandboxRoot(ctx.cfg)
    let root: string
    try {
      root = input.subdir ? jailResolve(ctx.cfg, input.subdir) : sandbox
    } catch (e) {
      return { text: `[error] ${e instanceof Error ? e.message : String(e)}` }
    }
    const entries: string[] = []
    const walk = (dir: string, prefix: string): void => {
      if (entries.length >= LIST_MAX_ENTRIES) return
      let items: fs.Dirent[]
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (entries.length >= LIST_MAX_ENTRIES) return
        if (item.name === '.ops.jsonl') continue
        const full = path.join(dir, item.name)
        if (item.isSymbolicLink()) {
          entries.push(`${prefix}${item.name} → SYMLINK (refused — jail forbids them)`)
          continue
        }
        if (item.isDirectory()) {
          entries.push(`${prefix}${item.name}/`)
          walk(full, `${prefix}${item.name}/`)
        } else {
          let size = 0
          try {
            size = fs.statSync(full).size
          } catch {
            // unreadable entry — list it with unknown size
          }
          entries.push(`${prefix}${item.name} (${size} bytes)`)
        }
      }
    }
    walk(root, '')
    return { text: entries.length > 0 ? `🗂 sandbox:${input.subdir ?? ''}\n${entries.join('\n')}` : `sandbox:${input.subdir ?? ''} is empty` }
  },
})

/** Used by tests to reset the journal between cases. */
export function sandboxOpsPath(cfg: Config): string {
  return path.join(sandboxRoot(cfg), '.ops.jsonl')
}

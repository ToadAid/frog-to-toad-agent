import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from './registry.js'
import type { Config } from '../config.js'
import { handsGateOpen } from '../doctor/doctor.js'
import { jailResolve, looksBinary, READ_MAX_BYTES, sandboxRoot } from './workspace.js'
import { appendJsonl } from '../store/jsonl.js'
import { log } from '../log.js'

/**
 * Coding ability (Phase 12.4) — the frog writes code, tests it, and reports
 * a diff. The PRINCIPAL applies anything to the live desk. Flow:
 *
 *   workspace_snapshot  → freeze the current sandbox as the baseline
 *   (edit with workspace_write, test with exec_run)
 *   workspace_diff      → show every changed/new file vs the baseline
 *
 * Nothing in the sandbox executes on its own and nothing here ever touches
 * src/ — applying a patch to the live desk is a principal step (desk restart
 * is principal-gated; the trading state machine covers the downtime).
 */

const JOURNAL_FILES = new Set(['.ops.jsonl', '.exec.jsonl'])
const DIFF_MAX_BYTES = 24_000
const FILE_LINES_MAX = 1500

export function baselineRoot(cfg: { paths: { dataDir: string } }): string {
  return path.join(cfg.paths.dataDir, 'sandbox-baseline')
}

function isJournalOrTemp(name: string): boolean {
  return JOURNAL_FILES.has(name) || name.endsWith('.bak') || name.includes('.tmp-')
}

function copyTree(src: string, dest: string, excludeRepoAtRoot = false): number {
  let count = 0
  fs.mkdirSync(dest, { recursive: true })
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    if (isJournalOrTemp(item.name)) continue
    if (excludeRepoAtRoot && item.name === 'repo') continue
    const s = path.join(src, item.name)
    const d = path.join(dest, item.name)
    if (item.isSymbolicLink()) continue // jail forbids symlinks anyway
    if (item.isDirectory()) {
      count += copyTree(s, d)
    } else {
      fs.copyFileSync(s, d)
      count++
    }
  }
  return count
}

function resolveWithin(root: string, rel: string): string {
  const target = path.resolve(root, rel)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`path escapes baseline jail: ${rel}`)
  let walked = root
  for (const part of path.relative(root, target).split(path.sep)) {
    if (!part) continue
    walked = path.join(walked, part)
    if (fs.existsSync(walked) && fs.lstatSync(walked).isSymbolicLink()) throw new Error(`symlink refused: ${rel}`)
  }
  return target
}

/** Relative file list of a tree (skips journals/temp — same rule as snapshots). */
function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = []
  if (!fs.existsSync(root)) return out
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (isJournalOrTemp(item.name)) continue
    const rel = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) {
      out.push(...listFiles(path.join(root, item.name), rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

/** Minimal LCS line diff → hunks in unified-ish form, header only + changed lines. */
export function diffLines(before: string, after: string): { hunks: string[]; added: number; removed: number } {
  const a = before.split('\n').slice(0, FILE_LINES_MAX)
  const b = after.split('\n').slice(0, FILE_LINES_MAX)
  const n = a.length
  const m = b.length
  // LCS DP table (files are capped; fine for desk-sized text)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const hunks: string[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (hunks.length > 0) hunks.push(`  ${a[i]}`)
      i++
      j++
      continue
    }
    const takeRemove = j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)
    if (takeRemove) {
      hunks.push(`- ${a[i]}`)
      removed++
      i++
    } else {
      hunks.push(`+ ${b[j]}`)
      added++
      j++
    }
  }
  return { hunks: hunks.slice(0, 400), added, removed }
}

export const workspaceSnapshotTool = defineTool({
  name: 'workspace_snapshot',
  description:
    'Freeze the current sandbox workspace as the coding baseline. Run this BEFORE a coding session; workspace_diff ' +
    'then shows exactly what you changed vs this snapshot.',
  danger: 'readonly',
  input: z.object({}),
  execute: async (_input, ctx) => {
    if (!handsGateOpen(ctx.cfg)) {
      return { text: '[error] hands are gated: doctor is unhealthy or has never run a full check (npm run doctor).' }
    }
    try {
      fs.mkdirSync(sandboxRoot(ctx.cfg), { recursive: true }) // empty sandbox → empty baseline, not an error
      fs.rmSync(baselineRoot(ctx.cfg), { recursive: true, force: true })
      const copied = copyTree(sandboxRoot(ctx.cfg), baselineRoot(ctx.cfg), true)
      return { text: `📸 baseline frozen: ${copied} file(s) under sandbox → data/sandbox-baseline/` }
    } catch (e) {
      return { text: `[error] snapshot failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

export const workspaceDiffTool = defineTool({
  name: 'workspace_diff',
  description:
    'Show the coding changes: every sandbox file added/changed/removed vs the last workspace_snapshot, as line diffs. ' +
    'This is what you report to the principal — applying it to the live desk is THEIR step, never yours.',
  danger: 'readonly',
  input: z.object({
    file: z.string().optional().describe('diff only this sandbox-relative file (default: whole sandbox)'),
  }),
  execute: async (input, ctx) => {
    if (!handsGateOpen(ctx.cfg)) {
      return { text: '[error] hands are gated: doctor is unhealthy or has never run a full check (npm run doctor).' }
    }
    const base = baselineRoot(ctx.cfg)
    if (!fs.existsSync(base)) {
      return { text: '[error] no baseline yet — run workspace_snapshot first' }
    }
    const files = input.file ? [input.file] : listFiles(sandboxRoot(ctx.cfg)).filter((f) => f !== 'repo' && !f.startsWith('repo/'))
    const baselineFiles = new Set(listFiles(base))
    const out: string[] = []
    let totalAdded = 0
    let totalRemoved = 0
    let budget = DIFF_MAX_BYTES
    for (const rel of files) {
      let nowPath: string
      let basePath: string
      try {
        nowPath = jailResolve(ctx.cfg, rel)
        basePath = resolveWithin(base, rel)
      } catch (e) {
        return { text: `[error] ${e instanceof Error ? e.message : String(e)}` }
      }
      if (isJournalOrTemp(path.basename(rel)) || rel.includes('.tmp-')) continue
      const nowExists = fs.existsSync(nowPath)
      const hadBase = baselineFiles.has(rel)
      if (!nowExists && !hadBase) continue
      const beforeBuf = hadBase ? fs.readFileSync(basePath) : Buffer.alloc(0)
      const afterBuf = nowExists ? fs.readFileSync(nowPath) : Buffer.alloc(0)
      if (beforeBuf.length > READ_MAX_BYTES || afterBuf.length > READ_MAX_BYTES) {
        out.push(`[skipped] ${rel}: over ${READ_MAX_BYTES}-byte diff read cap`)
        continue
      }
      if (looksBinary(beforeBuf) || looksBinary(afterBuf)) {
        out.push(`[skipped] ${rel}: binary content`)
        continue
      }
      const before = beforeBuf.toString('utf8')
      const after = afterBuf.toString('utf8')
      if (before === after) continue
      const { hunks, added, removed } = diffLines(before, after)
      totalAdded += added
      totalRemoved += removed
      const kind = !nowExists ? 'DELETED' : !hadBase ? 'NEW' : 'CHANGED'
      const block = [`${kind}: ${rel} (+${added} −${removed})`, ...hunks.map((h) => `  ${h}`), ''].join('\n')
      if (block.length > budget) {
        out.push('… diff truncated (budget)')
        break
      }
      budget -= block.length
      out.push(block)
    }
    if (out.length === 0) return { text: '🧬 no changes vs baseline' }
    journalDiff(ctx, files.length, totalAdded, totalRemoved)
    return { text: `🧬 diff vs baseline (${files.length} file(s) considered)\n\n${out.join('\n')}` }
  },
})

function journalDiff(ctx: { cfg: Config; agent: { name: string } }, files: number, added: number, removed: number): void {
  try {
    appendJsonl(path.join(sandboxRoot(ctx.cfg), '.ops.jsonl'), {
      ts: Date.now(),
      op: 'diff',
      files,
      added,
      removed,
      agent: ctx.agent.name,
    })
  } catch (e) {
    log.warn(`diff journal failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

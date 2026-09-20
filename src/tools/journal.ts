import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from './registry.js'
import { appendJsonl, readJsonl } from '../store/jsonl.js'
import type { Config } from '../config.js'
import { log } from '../log.js'
import { fmtLocalTs, relDay } from '../util/temporal.js'

/**
 * The trade journal — memory that makes the desk smarter over time.
 * Every trade gets an entry; the nightly reviewer distills LESSONS with a
 * sample-size gate enforced here in code (n >= cfg.lessonsSampleMin).
 */

export type JournalEntry = {
  ts: number
  symbol: string
  decision: string // what was decided and why (thesis at entry)
  outcome?: string // what happened
  grade?: 'good-process' | 'bad-process' // decision quality, not outcome quality
  lesson?: string
  runId?: string
}

export function journalPath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'journal.jsonl')
}

export function readJournal(cfg: Config): JournalEntry[] {
  return readJsonl<JournalEntry>(journalPath(cfg))
}

export const journalAppendTool = defineTool({
  name: 'journal_append',
  description:
    'Append a journal entry for a trade or decision. Journal the THESIS and the decision quality — ' +
    'a good decision can lose money, a bad one can win. Grade the process.',
  danger: 'write',
  input: z.object({
    symbol: z.string(),
    decision: z.string().describe('the thesis / decision being journaled'),
    outcome: z.string().optional(),
    grade: z.enum(['good-process', 'bad-process']).optional(),
  }),
  execute: async (input, ctx) => {
    appendJsonl(journalPath(ctx.cfg), {
      ts: Date.now(),
      symbol: input.symbol.toUpperCase(),
      decision: input.decision,
      outcome: input.outcome,
      grade: input.grade,
      runId: ctx.runId,
    } satisfies JournalEntry)
    return { text: `journal entry recorded for ${input.symbol.toUpperCase()}` }
  },
})

export const journalReadTool = defineTool({
  name: 'journal_read',
  description: 'Read recent journal entries (optionally filtered by symbol) — the desk memory.',
  danger: 'readonly',
  input: z.object({
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(50).default(10),
  }),
  execute: async (input, ctx) => {
    let entries = readJournal(ctx.cfg)
    if (input.symbol) {
      const s = input.symbol.toUpperCase()
      entries = entries.filter((e) => e.symbol === s)
    }
    const tail = entries.slice(-input.limit)
    if (tail.length === 0) return { text: 'journal is empty (or no entries match)' }
    const nowMs = Date.now()
    const tz = ctx.cfg.timezone
    return {
      text: tail
        .map(
          (e) =>
            `${fmtLocalTs(tz, e.ts)} (${relDay(tz, e.ts, nowMs)}) ${e.symbol}: ${e.decision}` +
            (e.outcome ? ` → ${e.outcome}` : '') +
            (e.grade ? ` [${e.grade}]` : ''),
        )
        .join('\n'),
    }
  },
})

// ── Lesson distillation (reviewer pass) ─────────────────────────────────────

export type DistillResult = {
  written: string[]
  skipped: Array<{ pattern: string; n: number }>
}

/**
 * Group journal entries by symbol + grade and promote lessons ONLY when a
 * pattern has enough samples (code-level gate — not the model's judgment).
 * Called by the nightly reviewer cron, not by the agent directly.
 */
export function distillLessons(cfg: Config): DistillResult {
  const entries = readJournal(cfg)
  const minSamples = cfg.lessonsSampleMin
  const result: DistillResult = { written: [], skipped: [] }

  const byPattern = new Map<string, JournalEntry[]>()
  for (const e of entries) {
    if (!e.grade || !e.lesson) continue
    const key = `${e.symbol}:${e.grade}`
    const list = byPattern.get(key) ?? []
    list.push(e)
    byPattern.set(key, list)
  }

  for (const [pattern, list] of byPattern) {
    if (list.length < minSamples) {
      result.skipped.push({ pattern, n: list.length })
      continue
    }
    const dir = path.join(cfg.paths.dataDir, 'lessons')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'lessons.md')
    const [symbol, grade] = pattern.split(':')
    // Marker line doubles as the dedupe key — a pattern is written once, ever.
    const marker = `lesson:${pattern}`
    const line =
      `- [n=${list.length}, conf=med] ${symbol}: pattern "${grade}" observed ${list.length}x. ` +
      `Representative: ${list[list.length - 1]!.lesson} (re-verify quarterly.) <!-- ${marker} -->\n`
    try {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      if (!existing.includes(marker)) {
        fs.appendFileSync(file, line)
        result.written.push(pattern)
      }
    } catch (err) {
      // lessons are best-effort
      void err
    }
  }
  return result
}
import fs from 'node:fs'
import path from 'node:path'
import {
  projectUserEntries,
  serializeUserProjection,
  type UserProjectionInput,
} from '../memory/userProjection.js'

/**
 * Desk continuity (the Hermes pattern, desk-fitted): two shared stores in
 * data/workspace/ —
 *   USER.md  what the desk knows about the PRINCIPAL (risk appetite, style,
 *            habits, standing instructions). Orchestrator-only writes.
 *   AGENT.md (or legacy DESK.md) agent-level facts learned. Every agent may write.
 *
 * Stolen mechanics that make memory GROW instead of ACCUMULATE:
 * - § entry delimiter: entries are multiline, split on the section sign
 * - add / replace / remove with SHORT UNIQUE SUBSTRING matching (not IDs) —
 *   a wrong fact can be corrected, not just appended over
 * - CHAR caps (not tokens — model-independent): 1375 for USER.md, 2200 for
 *   AGENT.md/DESK.md. `add` refuses an entry that won't fit instead of silently
 *   truncating the principal's own file
 * - frozen snapshot: injected into the system prompt once per run; writes hit
 *   disk immediately but never mutate the running prompt (prefix-cache safe)
 */

export type WorkspaceTarget = 'user' | 'desk'

/** Entry delimiter — matches the upstream convention so imports stay trivial. */
export const ENTRY_DELIMITER = '§'

/** Char caps are model-independent discipline, not hard limits — override via
 * env (MEMORY_USER_CHARS / MEMORY_DESK_CHARS) without a recompile. Defaults:
 * the original Hermes-fitted values (1375/2200). */
export const USER_CHAR_LIMIT = Math.max(400, Number(process.env['MEMORY_USER_CHARS']) || 1375)
export const DESK_CHAR_LIMIT = Math.max(400, Number(process.env['MEMORY_DESK_CHARS']) || 2200)

export type WorkspaceOp =
  | { action: 'add'; content: string }
  | { action: 'add-many'; contents: string[] }
  | { action: 'replace'; find: string; content: string }
  | { action: 'remove'; find: string }

export type WorkspaceResult =
  | { ok: true; entries: number; chars: number; evicted?: string[] }
  | { ok: false; error: string }

export function workspaceFilePath(dataDir: string, target: WorkspaceTarget): string {
  if (target === 'user') return path.join(dataDir, 'workspace', 'USER.md')
  const agentPath = path.join(dataDir, 'workspace', 'AGENT.md')
  if (fs.existsSync(agentPath)) return agentPath
  return path.join(dataDir, 'workspace', 'DESK.md')
}

function limitFor(target: WorkspaceTarget): number {
  return target === 'user' ? USER_CHAR_LIMIT : DESK_CHAR_LIMIT
}

/** Split file content into entries (§ delimiter), dropping empties. */
export function parseEntries(content: string): string[] {
  return content
    .split(ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter((e) => e !== '')
}

function serializeEntries(entries: string[]): string {
  return entries.map((e) => e.trim()).join(`\n${ENTRY_DELIMITER}\n`)
}

/** Prompt-injection armor: strip fence tags so stored text can't break out of
 * the <memory-context> block it will be injected inside. */
export function sanitizeForFence(text: string): string {
  return text.replace(/<\/?memory-context>/gi, '')
}

export function readWorkspace(dataDir: string, target: WorkspaceTarget): string {
  return readWorkspaceFile(workspaceFilePath(dataDir, target))
}

export function readWorkspaceFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function entryCount(content: string): number {
  return parseEntries(content).length
}

/**
 * Apply one operation to a workspace store. Fail-closed: a bad find substring
 * or an over-cap add returns an error the LLM can act on — never a silent
 * partial write.
 */
export function applyWorkspaceOp(
  dataDir: string,
  target: WorkspaceTarget,
  op: WorkspaceOp,
): WorkspaceResult {
  return applyWorkspaceOpTo(workspaceFilePath(dataDir, target), op, limitFor(target))
}

/** Core op engine against an explicit file (used for per-agent memory files too). */
export function applyWorkspaceOpTo(file: string, op: WorkspaceOp, limit = DESK_CHAR_LIMIT): WorkspaceResult {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const current = readWorkspaceFile(file)
  const entries = parseEntries(current)

  if (op.action === 'add') {
    const content = op.content.trim()
    if (content === '') return { ok: false, error: 'nothing to add (empty entry)' }
    if (content.includes(ENTRY_DELIMITER)) {
      return { ok: false, error: `entry must not contain the '${ENTRY_DELIMITER}' delimiter` }
    }
    // Duplicate guard: an exact entry already stored is a no-op, not noise —
    // checked BEFORE eviction so a re-save never drops anything.
    if (entries.some((e) => e === content)) {
      return { ok: true, entries: entries.length, chars: current.length }
    }
    const joined = [...entries, content].join(`\n${ENTRY_DELIMITER}\n`)
    if (joined.length > limit) {
      if (content.length > limit) {
        return {
          ok: false,
          error:
            `this single entry is ${content.length} chars — over the ${limit}-char limit on its own. ` +
            `Shorten it to one durable fact, or put the long version in the journal and save the one-line lesson here.`,
        }
      }
      // Auto-evict (2026-09-03): the store was refusing adds when full, and a
      // full store turned one save into a 16-retry shave loop that ended in an
      // empty-brain turn. Memory is a bounded, newest-first lane: drop the
      // OLDEST entries until the add fits, and report exactly what was dropped
      // so the agent can re-save anything that mattered. The cap still binds —
      // memory just stops blocking its own writer.
      const evicted: string[] = []
      const kept = [...entries]
      while (kept.length > 0 && [...kept, content].join(`\n${ENTRY_DELIMITER}\n`).length > limit) {
        evicted.push(kept.shift()!)
      }
      const after = [...kept, content].join(`\n${ENTRY_DELIMITER}\n`)
      write(file, after)
      return { ok: true, entries: kept.length + 1, chars: after.length, evicted }
    }
    write(file, joined)
    return { ok: true, entries: entries.length + 1, chars: joined.length }
  }

  if (op.action === 'add-many') {
    // Batch restore (the carousel fix, 2026-09-13): a full store + N one-at-
    // a-time re-saves is an infinite loop — every save evicts the oldest, so
    // a nudge-driven restore can never finish. ONE call takes ALL the
    // additions, dedupes them against the store AND each other, evicts the
    // oldest entries at most once, and writes ONCE. Fail-closed: a batch
    // that cannot fit even on an empty store refuses whole — it never evicts
    // everything just to fail.
    const seen = new Set(entries)
    const additions: string[] = []
    for (const raw of op.contents) {
      const content = raw.trim()
      if (content === '') continue
      if (content.includes(ENTRY_DELIMITER)) {
        return { ok: false, error: `entry must not contain the '${ENTRY_DELIMITER}' delimiter` }
      }
      if (seen.has(content)) continue
      seen.add(content)
      additions.push(content)
    }
    if (additions.length === 0) {
      return { ok: true, entries: entries.length, chars: current.length }
    }
    const newChars = additions.join(`\n${ENTRY_DELIMITER}\n`).length + 2 * (additions.length - 1)
    if (additions.some((c) => c.length > limit)) {
      const over = additions.filter((c) => c.length > limit).length
      return {
        ok: false,
        error:
          `${over} of ${additions.length} entries are individually over the ${limit}-char limit. ` +
          `Shorten them to one durable fact each, or put the long versions in the journal.`,
      }
    }
    if (newChars > limit) {
      // Total over cap → refuse whole, even on an empty store: eviction can
      // only make room for what FITS, never make an over-cap batch fit.
      return {
        ok: false,
        error:
          `this batch of ${additions.length} entries is ${newChars} chars — over the ${limit}-char limit on its own. ` +
          `Split it across runs or move the bulk to the durable notes; memory is a hot cache, not an archive.`,
      }
    }
    const evicted: string[] = []
    const kept = [...entries]
    while (kept.length > 0 && [...kept, ...additions].join(`\n${ENTRY_DELIMITER}\n`).length > limit) {
      evicted.push(kept.shift()!)
    }
    const after = [...kept, ...additions].join(`\n${ENTRY_DELIMITER}\n`)
    write(file, after)
    return { ok: true, entries: kept.length + additions.length, chars: after.length, evicted }
  }

  const find = op.find.trim()
  if (find === '') return { ok: false, error: 'find must be a short unique substring' }
  const idx = entries.findIndex((e) => e.includes(find))
  if (idx < 0) {
    return { ok: false, error: `no entry contains "${find}" — nothing changed` }
  }
  if (entries.filter((e) => e.includes(find)).length > 1) {
    return { ok: false, error: `"${find}" matches ${entries.filter((e) => e.includes(find)).length} entries — use a longer unique substring` }
  }

  if (op.action === 'remove') {
    entries.splice(idx, 1)
  } else {
    // replace
    const content = op.content.trim()
    if (content === '') return { ok: false, error: 'nothing to replace with (empty entry)' }
    if (content.includes(ENTRY_DELIMITER)) {
      return { ok: false, error: `entry must not contain the '${ENTRY_DELIMITER}' delimiter` }
    }
    const candidate = [...entries.slice(0, idx), content, ...entries.slice(idx + 1)]
    const joined = candidate.join(`\n${ENTRY_DELIMITER}\n`)
    if (joined.length > limit) {
      return {
        ok: false,
        error:
          `replacement would exceed the ${limit}-char limit (${joined.length} total). ` +
          `Shorten it or remove another entry first.`,
      }
    }
    entries.splice(idx, 1, content)
  }
  write(file, entries.join(`\n${ENTRY_DELIMITER}\n`))
  const chars = entries.join(`\n${ENTRY_DELIMITER}\n`).length
  return { ok: true, entries: entries.length, chars }
}

function write(file: string, content: string): void {
  // Atomic-ish: write temp then rename, so a crash never leaves a half file.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Build the fenced context block for prompt injection (the injection armor:
 * the model is told this is reference data, not new user input).
 */
export function workspaceContextBlock(
  dataDir: string,
  target: WorkspaceTarget,
): { text: string; chars: number } | undefined {
  const content = readWorkspace(dataDir, target)
  if (content === '') return undefined
  return {
    text: `<memory-context>\n${sanitizeContext(content)}\n</memory-context>`,
    chars: content.length,
  }
}

/**
 * Build the prompt-facing USER.md projection. P3B1 callers must supply the
 * provenance catalog explicitly; runtime supplies [] until authenticated
 * admission and durable provenance wiring exist in P3B2.
 */
export function userProjectionContextBlock(
  dataDir: string,
  provenanceCatalog: UserProjectionInput['provenanceCatalog'],
): { text: string; chars: number } | undefined {
  const content = readWorkspace(dataDir, 'user')
  if (content === '') return undefined
  const projection = projectUserEntries({
    schemaVersion: 1,
    entries: parseEntries(content),
    provenanceCatalog,
    authorityGranted: false,
  })
  const serialized = serializeUserProjection(projection)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
  return {
    text:
      `<memory-context>\n` +
      `<user-memory-projection>\n${serialized}\n</user-memory-projection>\n` +
      `</memory-context>`,
    chars: content.length,
  }
}

export function sanitizeContext(raw: string): string {
  const withoutFences = raw.replace(/<\/?memory-context>/gi, '')
  const withoutSystemNotes = withoutFences.replace(/\[system:/gi, '[sanitized:')
  return withoutSystemNotes.trim()
}

/** Visibility line — the run log shows memory was used, even when quiet. */
export function recallLine(blocks: Array<{ chars: number } | undefined>): string | undefined {
  const total = blocks.reduce((a, b) => a + (b?.chars ?? 0), 0)
  if (total === 0) return undefined
  return `recalled ${total} chars of workspace memory`
}
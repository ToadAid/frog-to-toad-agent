import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { log } from '../log.js'

/**
 * Markdown skills/commands (mother-repo north-star cut, desk-sized).
 *
 * ONE Command type serves two doors:
 *  - a user slash-command (`/position-check` on Telegram/TUI), and
 *  - a model-invocable playbook (the `skill` tool, listing in the system prompt).
 *
 * Discovery: `<skillsDir>/<name>/SKILL.md` only — the name is the DIRECTORY
 * name (mother law), never frontmatter. Bodies load with the file (desk files
 * are small) but the LISTING is budgeted from frontmatter only, so a large
 * playbook costs nothing until invoked.
 *
 * Deliberately NOT ported from the mother (money desk):
 *  - `!`cmd`` shell execution inside bodies — body text is inert data, never run
 *  - skill `model`/`effort` overrides — the brain is cfg-owned
 *  - hooks frontmatter, MCP/bundled/managed sources, dynamic dir discovery,
 *    conditional `paths` activation
 *  - `allowed-tools` as a permission GRANT. Desk law is the inversion: a
 *    playbook may be LESS able than the base agent, never more — the list only
 *    ever NARROWS an invocation's tools (enforced at the loop, PR-style).
 *
 * Error behavior: no global hard failures. A malformed skill is refused
 * locally and reported by the loader; other playbooks and the desk stay up.
 */

export type DeskCommand = {
  /** The directory name under skillsDir — the slash-command spelling. */
  name: string
  description: string
  whenToUse?: string
  argumentHint?: string
  /** Positional arg names from `arguments:` ($symbol…) — numeric-only rejected. */
  argNames: string[]
  /** Narrowing filter for this invocation. Never a grant. */
  allowedTools?: string[]
  /** fork = the playbook runs in a fresh subagent context (same hands). */
  context: 'inline' | 'fork'
  /** true → the skill tool refuses; only the principal may type /name. */
  disableModelInvocation: boolean
  /** true (default) → the principal may invoke it as a slash-command. */
  userInvocable: boolean
  body: string
  contentLength: number
  sourcePath: string
}

const SKILL_FILE = 'SKILL.md'
/** A playbook larger than this is not a playbook, it's a data dump — refused. */
const MAX_SKILL_BYTES = 128 * 1024
/** Directory names must be typeable as a slash-command (Telegram charset + dash). */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/** Authority booleans fail closed when present: only exact true/false. */
function parseAuthorityBoolean(raw: string | undefined, field: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`invalid ${field} '${raw}' (expected true or false)`)
}

function fallbackDescription(body: string): string {
  const first = body
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '')
  if (first === undefined || first === '') return ''
  return first.length > 97 ? `${first.slice(0, 97)}…` : first
}

export type ParsedSkill = { frontmatter: Map<string, string>; body: string }

/** No block ⇒ all body. A started block must close or the skill is refused. */
export function parseSkillFrontmatter(content: string): ParsedSkill {
  const m = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)([\s\S]*)$/m.exec(content)
  if (!m) {
    if (/^---(?:\r?\n|$)/.test(content)) throw new Error('frontmatter block started but has no valid closing --- delimiter')
    return { frontmatter: new Map(), body: content }
  }
  const front = new Map<string, string>()
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) front.set(key, value)
  }
  return { frontmatter: front, body: m[2] ?? '' }
}

/** `allowed-tools` — comma-separated; `*` means "no narrowing" (undefined). */
export function parseAllowedTools(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const list = raw.split(',').map((s) => s.trim())
  if (list.length === 0 || list.some((s) => s.length === 0)) {
    throw new Error('invalid allowed-tools (expected * or a comma-separated non-empty list)')
  }
  if (list.length === 1 && list[0] === '*') return undefined
  if (list.includes('*')) throw new Error("invalid allowed-tools ('*' must appear alone)")
  return list
}

/** `arguments: symbol side` — positional names; numeric-only collide with $0/$1. */
export function parseArgumentNames(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^\d+$/.test(s))
}

function parseSkill(content: string, name: string, sourcePath: string): DeskCommand {
  const { frontmatter: fm, body } = parseSkillFrontmatter(content)
  const description = fm.get('description') ?? fallbackDescription(body)
  const contextRaw = fm.get('context')
  if (contextRaw !== undefined && contextRaw !== 'inline' && contextRaw !== 'fork') {
    throw new Error(`invalid context '${contextRaw}' (expected inline or fork)`)
  }
  const context = contextRaw ?? 'inline'
  return {
    name,
    description,
    whenToUse: fm.get('when_to_use') ?? fm.get('whenToUse') ?? undefined,
    argumentHint: fm.get('argument-hint') ?? fm.get('argumentHint') ?? undefined,
    argNames: parseArgumentNames(fm.get('arguments')),
    allowedTools: parseAllowedTools(fm.get('allowed-tools')),
    context,
    disableModelInvocation: parseAuthorityBoolean(fm.get('disable-model-invocation'), 'disable-model-invocation', false),
    // Mother law: skills default to user-invocable; only an explicit
    // `user-invocable: false` takes the slash door away.
    userInvocable: parseAuthorityBoolean(fm.get('user-invocable'), 'user-invocable', true),
    body,
    contentLength: body.length,
    sourcePath,
  }
}

export function loadSkillCommands(skillsDir: string): { commands: DeskCommand[]; failed: string[] } {
  const commands: DeskCommand[] = []
  const failed: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch (err) {
    // A missing skills dir is the normal fresh-boot shape — silent, like the
    // mother. Anything else (EACCES, ELOOP…) is worth one honest warn.
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') {
      log.warn(`skills dir '${skillsDir}' unreadable: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { commands, failed }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (!NAME_RE.test(name)) {
      failed.push(`${name}: directory name must be lowercase letters/digits/dashes`)
      continue
    }
    const sourcePath = path.join(skillsDir, name, SKILL_FILE)
    try {
      const stat = fs.statSync(sourcePath)
      if (stat.size > MAX_SKILL_BYTES) {
        failed.push(`${name}: SKILL.md is ${(stat.size / 1024).toFixed(0)}KB — cap ${(MAX_SKILL_BYTES / 1024).toFixed(0)}KB`)
        continue
      }
      const cmd = parseSkill(fs.readFileSync(sourcePath, 'utf8'), name, sourcePath)
      commands.push(cmd)
    } catch (err) {
      // No SKILL.md in an otherwise-fine directory is the common lazy state —
      // silent (mother law). Real read failures surface in `failed`.
      const code = (err as { code?: string }).code
      if (code === 'ENOENT') continue
      failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  commands.sort((a, b) => a.name.localeCompare(b.name))
  return { commands, failed }
}

// ── Cached access (per config) ───────────────────────────────────────────────
let cache: { dir: string; loaded: ReturnType<typeof loadSkillCommands> } | undefined

export function getSkillCommands(cfg: Config): { commands: DeskCommand[]; failed: string[] } {
  const dir = cfg.paths.skillsDir
  if (cache === undefined || cache.dir !== dir) {
    cache = { dir, loaded: loadSkillCommands(dir) }
    if (cache.loaded.commands.length > 0) {
      log.info(`skills loaded: ${cache.loaded.commands.map((c) => c.name).join(', ')}`)
    }
    for (const f of cache.loaded.failed) log.warn(`skill failed to load: ${f}`)
  }
  return cache.loaded
}

/** Test seam: force a rescan on the next getSkillCommands. */
export function clearSkillCommandCache(): void {
  cache = undefined
}

// ── Bounded listing (mother prompt.ts law) ───────────────────────────────────
export const SKILL_LIST_CHAR_BUDGET_DEFAULT = 8_000
export const MAX_LISTING_DESC_CHARS = 250
const MIN_DESC_LENGTH = 20

export function getSkillListingCharBudget(): number {
  const raw = Number(process.env.SKILL_LIST_CHAR_BUDGET)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return SKILL_LIST_CHAR_BUDGET_DEFAULT
}

function listingEntry(cmd: DeskCommand): string {
  const desc = cmd.whenToUse ? `${cmd.description} - ${cmd.whenToUse}` : cmd.description
  const capped = desc.length > MAX_LISTING_DESC_CHARS ? `${desc.slice(0, MAX_LISTING_DESC_CHARS - 1)}…` : desc
  return `- ${cmd.name}: ${capped}`
}

/**
 * Waterfall port of the mother's formatCommandsWithinBudget: full entries if
 * they fit; otherwise descriptions trimmed to an equal share; below 20 chars
 * per share, names only. Verbose whenToUse strings waste listing budget
 * without improving match rate — the cap is generous, the truncation is honest.
 */
export function formatSkillListing(commands: DeskCommand[], charBudget: number): string {
  if (commands.length === 0) return ''
  const entries = commands.map(listingEntry)
  const total = entries.reduce((sum, e) => sum + e.length, 0) + entries.length - 1
  if (total <= charBudget) return entries.join('\n')

  const nameOverhead = commands.reduce((sum, c) => sum + c.name.length + 4, 0) + commands.length - 1
  const availableForDescs = charBudget - nameOverhead
  const maxDescLen = Math.floor(availableForDescs / commands.length)
  if (maxDescLen < MIN_DESC_LENGTH) return commands.map((c) => `- ${c.name}`).join('\n')
  return entries.map((e) => (e.length > maxDescLen ? `${e.slice(0, maxDescLen - 1)}…` : e)).join('\n')
}

// ── Argument substitution (mother argumentSubstitution.ts, desk-sized) ───────

/**
 * `$ARGUMENTS` = the whole args string; `$0` = the whole args string;
 * `$1`, `$2`, … = positional tokens; `$symbol` = named args from
 * `arguments:` frontmatter (unset ⇒ empty). If the body has NO placeholder
 * and args are non-empty, the args are appended (never silently dropped).
 */
export function substituteSkillArguments(body: string, args: string, argNames: string[]): string {
  const raw = args.trim()
  const tokens = raw === '' ? [] : raw.split(/\s+/)
  let matched = false
  let out = body

  const sub = (re: RegExp, value: string | ((substring: string, ...args: string[]) => string)): void => {
    if (re.test(out)) {
      matched = true
      out = typeof value === 'string' ? out.replace(re, value) : out.replace(re, value)
    }
  }

  // 1. $ARGUMENTS[n] before $ARGUMENTS (else the bare form eats the bracket).
  sub(/\$ARGUMENTS\[(\d+)\]/g, (_all, n: string) => tokens[Number(n)] ?? '')
  // 2. Named args — word-boundary-ish lookarounds keep $symbolism intact.
  argNames.forEach((name, i) => {
    sub(new RegExp(`\\$${name}(?![\\[\\w])`, 'g'), tokens[i] ?? '')
  })
  // 3. $ARGUMENTS and $0 = the full args; $1+ = positional tokens.
  sub(/\$ARGUMENTS\b/g, raw)
  sub(/\$(\d+)(?!\w)/g, (_all, n: string) => (Number(n) === 0 ? raw : tokens[Number(n) - 1] ?? ''))

  if (!matched && raw !== '') out = `${out}\n\nARGUMENTS: ${raw}`
  return out
}

// ── Invocation ───────────────────────────────────────────────────────────────

/**
 * The durable provenance envelope: one `[skill:name]` marker line, then the
 * expanded playbook body. Everything after the marker is frog-authored
 * playbook content running as user text — the marker is what makes the
 * provenance legible in the transcript, the audit, and the rewind preview.
 *
 * The args are encoded with JSON.stringify (never hand-escaped): a quote,
 * backslash, or newline in raw argument text must not be able to forge a
 * second provenance line or break the marker's one-line shape. No args keeps
 * the compact `[skill:name]` form. The playbook body itself is untouched —
 * this is provenance encoding only.
 */
export function buildSkillEnvelope(cmd: DeskCommand, args: string): string {
  const raw = args.trim()
  const argLine = raw === '' ? '' : ` args: ${JSON.stringify(raw)}`
  return `[skill:${cmd.name}]${argLine}\n${substituteSkillArguments(cmd.body, args, cmd.argNames)}`
}

export type SkillInvocation =
  | { kind: 'invoke'; command: DeskCommand; text: string }
  | { kind: 'not-user-invocable'; text: string }

export type SkillExecutionOptions = {
  toolAllowlist?: string[]
  threadMode?: 'isolated'
}

/** One metadata seam for the slash and model-tool doors. */
export function skillExecutionOptions(cmd: DeskCommand): SkillExecutionOptions {
  return {
    ...(cmd.allowedTools !== undefined ? { toolAllowlist: cmd.allowedTools } : {}),
    ...(cmd.context === 'fork' ? { threadMode: 'isolated' as const } : {}),
  }
}

/**
 * Match a slash-command-shaped text against the loaded skills. Built-in
 * commands win by construction (grammY bot.command() handlers + the TUI
 * if-chain run first); this only sees what falls through. A `/name` that
 * matches NO skill is NOT an error — it stays ordinary prompt text (the brain
 * decides what a path-like slash means), exactly like today.
 */
export function resolveSkillInvocation(commands: DeskCommand[], text: string): SkillInvocation | undefined {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return undefined
  const name = m[1]!.toLowerCase()
  const cmd = commands.find((c) => c.name === name)
  if (cmd === undefined) return undefined
  if (!cmd.userInvocable) {
    return {
      kind: 'not-user-invocable',
      text: `🔒 '${cmd.name}' is a model-invocable playbook only — ask the desk to use its skill for you.`,
    }
  }
  return { kind: 'invoke', command: cmd, text: buildSkillEnvelope(cmd, m[2] ?? '') }
}

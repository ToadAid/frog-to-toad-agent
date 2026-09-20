import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { parseSkillFrontmatter } from '../skills/commands.js'
import { log } from '../log.js'

/**
 * Output styles (mother-repo north-star Tier 2 #6, the loadOutputStylesDir
 * pattern, desk-sized): named markdown files whose body is an authoritative
 * tone/format directive appended to the system prompt. Data, not code — the
 * operator edits a style file, no TS redeploy.
 *
 * Two layers, the mother's project/user layering desk-sized:
 *   - assets/output-styles/*.md            repo-shipped defaults (layer 'repo')
 *   - <dataDir>/output-styles/*.md         operator edits (layer 'operator',
 *                                          same name OVERRIDES the repo file)
 * Lenient by law: a broken style file is skipped and reported, never fatal —
 * a style is reference data and never closes a gate.
 *
 * Selection: DESK_OUTPUT_STYLE env (explicit operator choice — the Telegram
 * service and the TUI are separate processes, each picks its own). Unset ⇒
 * the prompt is byte-for-byte unchanged. Named-but-missing ⇒ warn + no block.
 *
 * NOT ported from the mother: keep-coding-instructions (the desk has no
 * coding-instruction section), plugin force-for-plugin, memoize (styles are
 * read per prompt build, like the memory/lessons reads beside them), dynamic
 * dir discovery.
 */

export type OutputStyle = {
  name: string
  description: string
  prompt: string
  source: 'repo' | 'operator'
}

export function loadOutputStyles(cfg: Config): { styles: OutputStyle[]; failed: string[] } {
  const byName = new Map<string, OutputStyle>()
  const failed: string[] = []
  collect(byName, failed, path.join(cfg.paths.assetsDir, 'output-styles'), 'repo')
  // The operator layer runs SECOND so a same-name file replaces the repo
  // default — Map insertion order makes the override free.
  collect(byName, failed, path.join(cfg.paths.dataDir, 'output-styles'), 'operator')
  return { styles: [...byName.values()], failed }
}

function collect(
  byName: Map<string, OutputStyle>,
  failed: string[],
  dir: string,
  source: 'repo' | 'operator',
): void {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return // absent dir = no layer; absent is not an error
  }
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8')
      const { frontmatter: fm, body } = parseSkillFrontmatter(raw)
      const prompt = body.trim()
      if (prompt === '') {
        failed.push(`${source}:${file} (empty body)`)
        continue
      }
      const name = fm.get('name')?.trim() || file.replace(/\.md$/, '')
      const description = fm.get('description')?.trim() || fallbackDescription(prompt)
      byName.set(name, { name, description, prompt, source })
    } catch (err) {
      // Degrade-never-fail: a broken style file stays visible in `failed`,
      // never blocks boot, never closes a gate.
      failed.push(`${source}:${file} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
}

function fallbackDescription(body: string): string {
  const first = body
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '')
  if (first === undefined || first === '') return ''
  return first.length > 97 ? `${first.slice(0, 97)}…` : first
}

/** The operator's selection, or undefined when none is chosen (the unset law:
 * no DESK_OUTPUT_STYLE ⇒ the system prompt is byte-for-byte unchanged). */
export function resolveOutputStyle(cfg: Config): OutputStyle | undefined {
  const wanted = process.env['DESK_OUTPUT_STYLE']?.trim()
  if (!wanted) return undefined
  const { styles, failed } = loadOutputStyles(cfg)
  const style = styles.find((s) => s.name === wanted)
  if (!style) {
    log.warn(
      `output style '${wanted}' not found in assets/output-styles or ${path.join(cfg.paths.dataDir, 'output-styles')}` +
        (failed.length > 0 ? ` (${failed.length} style file(s) failed to parse: ${failed.join('; ')})` : ''),
    )
    return undefined
  }
  return style
}

/** The prompt block: an additive tone/format directive, fenced like every
 * other reference block. It shapes HOW the desk speaks — never tools,
 * authority, or safety gates (a style is not a grant). */
export function outputStylePromptBlock(style: OutputStyle): string {
  return (
    `\n## Output style (active: ${style.name})\n` +
    `The directive below is the operator-selected output style for EVERY reply you write ` +
    `(provenance: ${style.source} style file). It shapes tone and format only — ` +
    `never tool access, authority, or safety gates.\n` +
    style.prompt
  )
}
// Output styles (north-star Tier 2 #6): named markdown files whose body is an
// authoritative tone/format directive appended to the system prompt. Laws
// under proof:
//   · two layers — repo assets defaults, dataDir operator edits, same name
//     OVERRIDES the repo file
//   · lenient by law — a broken/empty style file is reported in `failed`,
//     never fatal, never closes a gate
//   · DESK_OUTPUT_STYLE unset ⇒ the prompt is byte-for-byte unchanged
//   · named-but-missing ⇒ warn + no block (degrade-never-fail)
//   · the block is ADDITIVE tone/format data — never tool access or gates
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { AgentRegistry } from '../src/agents/registry.js'
import { buildSystemPrompt } from '../src/agents/prompts.js'
import { loadOutputStyles, resolveOutputStyle, outputStylePromptBlock } from '../src/agents/outputStyles.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-styles-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  delete process.env['DESK_OUTPUT_STYLE']
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'assets', 'output-styles'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'assets', 'output-styles', 'terse.md'),
    '---\nname: terse\ndescription: Terminal style — short, declarative, no filler\n---\nBe terse.\n',
  )
  fs.writeFileSync(
    path.join(dir, 'assets', 'output-styles', 'numbers.md'),
    '---\nname: numbers\n---\nLead with the numbers.\n',
  )
  cfg = loadConfig()
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env['DESK_OUTPUT_STYLE']
})

const AGENT = { name: 'orch', emoji: '🎯', description: 'd', maxTurns: 1, systemPrompt: 'base body' }

describe('the loader (two layers, lenient)', () => {
  it('loads repo styles with frontmatter name/description defaults', () => {
    const { styles, failed } = loadOutputStyles(cfg)
    expect(failed).toEqual([])
    const terse = styles.find((s) => s.name === 'terse')
    expect(terse?.source).toBe('repo')
    expect(terse?.description).toBe('Terminal style — short, declarative, no filler')
    expect(terse?.prompt).toBe('Be terse.')
    // numbers.md has NO description frontmatter → falls back to the first body line
    const numbers = styles.find((s) => s.name === 'numbers')
    expect(numbers?.description).toContain('Lead with the numbers')
  })

  it('the operator layer OVERRIDES a same-name repo style', () => {
    fs.mkdirSync(path.join(cfg.paths.dataDir, 'output-styles'), { recursive: true })
    fs.writeFileSync(
      path.join(cfg.paths.dataDir, 'output-styles', 'terse.md'),
      '---\nname: terse\ndescription: operator edit\n---\nOperator body wins.\n',
    )
    const { styles } = loadOutputStyles(cfg)
    const terse = styles.find((s) => s.name === 'terse')
    expect(terse?.source).toBe('operator')
    expect(terse?.prompt).toBe('Operator body wins.')
    // cleanup: other tests must see the repo layer
    fs.rmSync(path.join(cfg.paths.dataDir, 'output-styles'), { recursive: true, force: true })
  })

  it('a broken or empty style file is reported in `failed`, never fatal', () => {
    fs.mkdirSync(path.join(cfg.paths.dataDir, 'output-styles'), { recursive: true })
    // a frontmatter block that started but never closed — the parser refuses it
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'output-styles', 'broken.md'), '---\nname: broken\nno closing delimiter at all')
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'output-styles', 'empty.md'), '---\nname: empty\n---\n\n')
    const { styles, failed } = loadOutputStyles(cfg)
    expect(styles.find((s) => s.name === 'broken')).toBeUndefined()
    expect(styles.find((s) => s.name === 'empty')).toBeUndefined()
    expect(failed.some((f) => f.startsWith('operator:broken.md'))).toBe(true)
    expect(failed.some((f) => f.startsWith('operator:empty.md'))).toBe(true)
    // the repo layer survived the broken operator files
    expect(styles.find((s) => s.name === 'terse')).toBeDefined()
    fs.rmSync(path.join(cfg.paths.dataDir, 'output-styles'), { recursive: true, force: true })
  })
})

describe('selection + the prompt seam', () => {
  it('no DESK_OUTPUT_STYLE ⇒ the prompt is byte-for-byte unchanged', () => {
    delete process.env['DESK_OUTPUT_STYLE']
    expect(resolveOutputStyle(cfg)).toBeUndefined()
    const withStyle = buildSystemPrompt(AGENT, cfg, '')
    const without = buildSystemPrompt(AGENT, cfg, '')
    expect(withStyle).toBe(without)
    expect(without).not.toContain('## Output style')
  })

  it('a selected style appends the additive tone block after the agent body', () => {
    process.env['DESK_OUTPUT_STYLE'] = 'terse'
    const style = resolveOutputStyle(cfg)
    expect(style?.name).toBe('terse')
    const prompt = buildSystemPrompt(AGENT, cfg, '')
    expect(prompt).toContain('base body') // additive — the agent body stays
    expect(prompt).toContain('## Output style (active: terse)')
    expect(prompt).toContain('Be terse.')
    expect(prompt.indexOf('base body')).toBeLessThan(prompt.indexOf('## Output style'))
  })

  it('a named-but-missing style degrades to no block (degrade-never-fail)', () => {
    process.env['DESK_OUTPUT_STYLE'] = 'no_such_style'
    expect(resolveOutputStyle(cfg)).toBeUndefined()
    const prompt = buildSystemPrompt(AGENT, cfg, '')
    expect(prompt).not.toContain('## Output style')
    expect(prompt).toContain('base body') // the agent still runs
  })

  it('the block itself never grants anything — tone and format only', () => {
    const block = outputStylePromptBlock({
      name: 'terse',
      description: 'd',
      prompt: 'Be terse.',
      source: 'repo',
    })
    expect(block).toContain('tone and format only')
    expect(block).toContain('never tool access, authority, or safety gates')
  })

  it('both shipped seeds parse and load from the real repo assets dir', () => {
    // the REAL repo checkout: seeds must load clean with no `failed` entries
    const realCfg = loadConfigFor(process.cwd())
    const { styles, failed } = loadOutputStyles(realCfg)
    expect(failed).toEqual([])
    expect(styles.find((s) => s.name === 'terse')?.prompt).toContain('terminal')
    expect(styles.find((s) => s.name === 'numbers')?.prompt).toContain('numbers')
  })
})

function loadConfigFor(root: string): Config {
  // point TRADING_DESK_DIR at the real repo root, load, then restore
  const prev = process.env['TRADING_DESK_DIR']
  const prevSelftest = process.env['SELFTEST']
  process.env['TRADING_DESK_DIR'] = root
  process.env['SELFTEST'] = '1'
  try {
    return loadConfig()
  } finally {
    if (prev === undefined) delete process.env['TRADING_DESK_DIR']
    else process.env['TRADING_DESK_DIR'] = prev
    if (prevSelftest === undefined) delete process.env['SELFTEST']
    else process.env['SELFTEST'] = prevSelftest
  }
}
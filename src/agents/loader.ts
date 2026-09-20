import fs from 'node:fs'
import path from 'node:path'
import type { AgentDef } from '../types.js'

/**
 * Markdown agent definitions (design from the parent fork's loadAgentsDir.ts):
 *
 *   ---
 *   name: researcher
 *   emoji: 🔍
 *   description: Delegates market research. Use for price/flow questions.
 *   tools: market_price, market_trending, portfolio_get
 *   model: glm-4.6          (optional override)
 *   maxTurns: 8
 *   ---
 *   System prompt body...
 *
 * Body of the file = the agent's system prompt.
 */
export function loadAgents(agentsDir: string): {
  agents: Map<string, AgentDef>
  failed: string[]
} {
  const agents = new Map<string, AgentDef>()
  const failed: string[] = []

  if (!fs.existsSync(agentsDir)) return { agents, failed }

  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue
    const full = path.join(agentsDir, file)
    try {
      const def = parseAgent(fs.readFileSync(full, 'utf8'), file)
      agents.set(def.name, def)
    } catch (err) {
      failed.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { agents, failed }
}

export function parseAgent(content: string, sourceName: string): AgentDef {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  if (!m) throw new Error('missing frontmatter block (--- ... ---)')
  const front = m[1]!
  const systemPrompt = m[2]!.trim()
  if (!systemPrompt) throw new Error('empty system prompt (body after frontmatter)')

  const fm = new Map<string, string>()
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) fm.set(key, value)
  }

  const name = fm.get('name') ?? sourceName.replace(/\.md$/, '')
  const description = fm.get('description') ?? ''
  if (!description) throw new Error(`agent ${name}: 'description' is required (used for delegation)`)
  const maxTurnsRaw = fm.get('maxTurns')
  const maxTurns = maxTurnsRaw ? Number(maxTurnsRaw) : undefined
  if (maxTurnsRaw && (!Number.isFinite(maxTurns) || maxTurns! <= 0)) {
    throw new Error(`agent ${name}: invalid maxTurns '${maxTurnsRaw}'`)
  }

  return {
    name,
    emoji: fm.get('emoji') ?? '🤖',
    description,
    tools: parseTools(fm.get('tools')),
    model: fm.get('model') || undefined,
    maxTurns: maxTurns ?? 8,
    systemPrompt,
  }
}

function parseTools(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return list.length > 0 ? list : undefined
}
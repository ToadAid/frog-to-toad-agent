import fs from 'node:fs'
import { codexTokenStatus } from './codexAuth.js'

/**
 * Brain setup helpers (§12.6 follow-up): the `desk login` menu becomes a
 * brain-selection wizard — codex (keyfile OAuth), zai / openai (API-key
 * lanes), ollama (local, no key). Only NON-SECRET switches are ever written
 * to .env by this module; an API key is always pasted by the principal into
 * .env by hand (same discipline as the keyfile: secrets never flow through
 * wizard code, chat, or logs).
 */

export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'

export type BrainChoice = 'codex' | 'zai' | 'openai' | 'ollama'

export function parseMenuChoice(raw: string): BrainChoice | undefined {
  switch (raw.trim()) {
    case '1': return 'codex'
    case '2': return 'zai'
    case '3': return 'ollama'
    case '4': return 'openai'
    default: return undefined
  }
}

/**
 * Idempotent KEY=VALUE upsert into the desk .env: replace an existing KEY=
 * line in place, else append. Values are config switches here — never
 * secrets — and are still written without logging. Returns the keys touched.
 */
export function upsertEnvFile(envPath: string, entries: Record<string, string>): { changed: string[]; created: boolean } {
  let lines: string[]
  let created = false
  try {
    lines = fs.readFileSync(envPath, 'utf8').split('\n')
  } catch {
    lines = []
    created = true
  }

  const changed: string[] = []
  for (const [key, value] of Object.entries(entries)) {
    const re = new RegExp(`^#?\\s*${key}\\s*=.*$`)
    const idx = lines.findIndex((l) => re.test(l))
    const line = `${key}=${value}`
    if (idx >= 0) {
      if (lines[idx] !== line) {
        lines[idx] = line
        changed.push(key)
      }
    } else {
      lines.push(line)
      changed.push(key)
    }
  }

  fs.writeFileSync(envPath, lines.join('\n').replace(/\n{3,}$/, '\n\n'), 'utf8')
  return { changed, created }
}

/** Upsert into .env while keeping commented-out template lines intact — a
 * commented `#BRAIN=` line must NOT satisfy the search when we set a value. */
export function envValueOf(envPath: string, key: string): string | undefined {
  try {
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm').exec(fs.readFileSync(envPath, 'utf8'))
    return m ? m[1]!.trim() : undefined
  } catch {
    return undefined
  }
}

export type OllamaProbe = {
  reachable: boolean
  models: string[]
  error?: string
}

/** Probe the local Ollama endpoint — the multi-platform zero-key lane. */
export async function probeOllama(
  baseUrl: string = OLLAMA_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaProbe> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(4_000) })
    if (!res.ok) return { reachable: false, models: [], error: `HTTP ${res.status}` }
    const raw = (await res.json()) as { data?: Array<{ id?: string }> }
    return { reachable: true, models: (raw.data ?? []).map((m) => m.id ?? '').filter(Boolean) }
  } catch (e) {
    return { reachable: false, models: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The brain-selection flow itself (`desk login` on a TTY, and step 3 of the
 * onboarding wizard). IO is injected so tests script it; the printed copy is
 * byte-identical to the original `desk login` menu.
 */
export type BrainSetupDeps = {
  print: (s?: string) => void
  ask: (q: string) => Promise<string>
  confirm: (q: string, dflt?: boolean) => Promise<boolean>
  envPath: string
  runCodexLogin: () => Promise<string>
  fetchImpl?: typeof fetch
}

export type BrainMenuResult = { picked: BrainChoice; envChanged: string[]; aborted?: boolean }

export async function runBrainSetupMenu(deps: BrainSetupDeps): Promise<BrainMenuResult> {
  const { print, ask, confirm, envPath } = deps
  const fetchImpl = deps.fetchImpl ?? fetch

  const currentBrain = (envValueOf(envPath, 'BRAIN') ?? 'glm').toLowerCase()
  print(`[desk] brain setup — current: ${currentBrain}`)
  print('  1) Codex   — ChatGPT web-login (no API key; the keyfile lane)')
  print('  2) Z.ai    — GLM via API key (paste LLM_API_KEY into .env by hand)')
  print('  3) Ollama  — local models, no key, no internet')
  print('  4) OpenAI  — API key (paste LLM_API_KEY into .env by hand)')
  const answer = await ask('Brain? [1-4] ')
  const choice = parseMenuChoice(answer)
  if (choice === undefined) {
    print('[desk] no valid pick — doing nothing.')
    return { picked: 'codex', envChanged: [], aborted: true }
  }

  if (choice === 'codex') {
    if (codexTokenStatus().valid) {
      print('[desk] codex keyfile already valid (refresh works) — re-logging in anyway.')
    }
    const keyfile = await deps.runCodexLogin()
    print(`[desk] codex brain forged: ${keyfile} (chmod 600, gitignored — never chat it)`)
    if (await confirm('Set BRAIN=codex in .env now?', true)) {
      const { changed } = upsertEnvFile(envPath, { BRAIN: 'codex' })
      print(`[desk] .env updated (${changed.join(', ')}) — npm run desk restart to switch.`)
      return { picked: choice, envChanged: changed }
    }
    print('[desk] set BRAIN=codex in .env and `npm run desk restart` to switch.')
    return { picked: choice, envChanged: [] }
  }

  if (choice === 'ollama') {
    print('[desk] probing local Ollama (http://127.0.0.1:11434/v1)…')
    const probe = await probeOllama(OLLAMA_BASE_URL, fetchImpl)
    if (!probe.reachable) {
      print(`[desk] ollama not reachable (${probe.error}) — install from https://ollama.com and run: ollama serve`)
      return { picked: choice, envChanged: [] }
    }
    if (probe.models.length === 0) {
      print('[desk] reachable, but no models pulled yet — e.g.: ollama pull glm-5.3-flash:cloud')
    } else {
      print(`[desk] models available: ${probe.models.slice(0, 12).join(', ')}${probe.models.length > 12 ? ' …' : ''}`)
    }
    const entries: Record<string, string> = { LLM_PROVIDER: 'ollama', BRAIN: 'glm' }
    const glm = probe.models.find((m) => /glm/i.test(m)) ?? probe.models[0]
    if (glm !== undefined) entries['LLM_MODEL'] = glm
    if (await confirm('Set LLM_PROVIDER=ollama in .env?', true)) {
      const { changed } = upsertEnvFile(envPath, entries)
      print(`[desk] .env updated (${changed.join(', ')}) — npm run desk restart to switch.`)
      return { picked: choice, envChanged: changed }
    }
    return { picked: choice, envChanged: [] }
  }

  // Key lanes (zai / openai): the switches are written; the key itself is
  // pasted by the principal into .env — wizard code never touches secrets.
  if (await confirm(`Set LLM_PROVIDER=${choice} in .env?`, true)) {
    const { changed } = upsertEnvFile(envPath, { LLM_PROVIDER: choice, BRAIN: 'glm' })
    print(`[desk] .env updated (${changed.join(', ')}).`)
  }
  print('[desk] now paste your key into .env by hand:  LLM_API_KEY=…')
  print('       (keys never pass through wizard code, chat, or logs)')
  print('[desk] verify with:  npm run smoke:llm   then: npm run desk restart')
  return { picked: choice, envChanged: [] }
}
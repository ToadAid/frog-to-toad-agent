import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OLLAMA_BASE_URL,
  envValueOf,
  parseMenuChoice,
  probeOllama,
  upsertEnvFile,
} from '../src/llm/brainSetup.js'

// Self-contained tmpdirs — no desk state, no network (fetch is mocked).
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmpEnv(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-setup-'))
  dirs.push(dir)
  const file = path.join(dir, '.env')
  if (content !== undefined) fs.writeFileSync(file, content, 'utf8')
  return file
}

describe('parseMenuChoice', () => {
  it('maps menu digits to brains', () => {
    expect(parseMenuChoice('1')).toBe('codex')
    expect(parseMenuChoice('2')).toBe('zai')
    expect(parseMenuChoice('3')).toBe('ollama')
    expect(parseMenuChoice('4')).toBe('openai')
  })

  it('tolerates whitespace and rejects junk', () => {
    expect(parseMenuChoice(' 3 ')).toBe('ollama')
    expect(parseMenuChoice('')).toBeUndefined()
    expect(parseMenuChoice('codex')).toBeUndefined()
    expect(parseMenuChoice('9')).toBeUndefined()
  })
})

describe('upsertEnvFile', () => {
  it('creates a fresh .env when none exists', () => {
    const file = tmpEnv()
    const { changed, created } = upsertEnvFile(file, { BRAIN: 'codex' })
    expect(created).toBe(true)
    expect(changed).toEqual(['BRAIN'])
    expect(fs.readFileSync(file, 'utf8')).toContain('BRAIN=codex')
  })

  it('appends new keys to an existing file and keeps other lines intact', () => {
    const file = tmpEnv('# desk env\nTELEGRAM_BOT_TOKEN=kept\n')
    const { changed, created } = upsertEnvFile(file, { LLM_PROVIDER: 'ollama' })
    expect(created).toBe(false)
    expect(changed).toEqual(['LLM_PROVIDER'])
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('TELEGRAM_BOT_TOKEN=kept')
    expect(text).toContain('LLM_PROVIDER=ollama')
  })

  it('replaces an existing key in place, preserving line order', () => {
    const file = tmpEnv('BRAIN=glm\nLLM_PROVIDER=zai\n')
    upsertEnvFile(file, { BRAIN: 'codex' })
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    expect(lines[0]).toBe('BRAIN=codex')
    expect(lines[1]).toBe('LLM_PROVIDER=zai')
  })

  it('is idempotent — same value touches nothing', () => {
    const file = tmpEnv('BRAIN=codex\n')
    const { changed } = upsertEnvFile(file, { BRAIN: 'codex' })
    expect(changed).toEqual([])
  })

  it('uncomments a commented template line instead of appending a duplicate', () => {
    const file = tmpEnv('#BRAIN=glm\n#THREAD_MESSAGES=80\n')
    upsertEnvFile(file, { BRAIN: 'codex' })
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('BRAIN=codex')
    expect(text).not.toContain('#BRAIN=')
    expect(text).toContain('#THREAD_MESSAGES=80') // unrelated comments untouched
  })
})

describe('envValueOf', () => {
  it('reads uncommented values only', () => {
    const file = tmpEnv('#BRAIN=codex\nBRAIN=glm\n')
    expect(envValueOf(file, 'BRAIN')).toBe('glm')
  })

  it('returns undefined for missing key or missing file', () => {
    expect(envValueOf(tmpEnv('A=1\n'), 'BRAIN')).toBeUndefined()
    expect(envValueOf(path.join(os.tmpdir(), 'does-not-exist-env'), 'BRAIN')).toBeUndefined()
  })
})

describe('probeOllama', () => {
  const okFetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'glm4:9b' }] }), { status: 200 })) as unknown as typeof fetch

  it('lists models on a healthy endpoint', async () => {
    const probe = await probeOllama(OLLAMA_BASE_URL, okFetch)
    expect(probe).toEqual({ reachable: true, models: ['qwen3:8b', 'glm4:9b'] })
  })

  it('reports HTTP errors as unreachable', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const probe = await probeOllama(OLLAMA_BASE_URL, bad)
    expect(probe.reachable).toBe(false)
    expect(probe.error).toContain('500')
  })

  it('survives a dead endpoint (connection refused)', async () => {
    const dead = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
    }) as unknown as typeof fetch
    const probe = await probeOllama(OLLAMA_BASE_URL, dead)
    expect(probe).toEqual({ reachable: false, models: [], error: 'connect ECONNREFUSED 127.0.0.1:11434' })
  })
})
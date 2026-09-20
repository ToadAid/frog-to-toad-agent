import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOnboarding } from '../src/onboard/wizard.js'
import type { OnboardIo, ExecResult } from '../src/onboard/types.js'

// Orchestration tests: scripted IO queues, injected fetch/exec, tmpdirs —
// no network, no real agent log, no real systemctl, no browser. The wizard's
// real-time loops are bounded by deps.bootTimeoutMs / deps.discoveryTimeoutMs.
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-wiz-'))
  dirs.push(d)
  return d
}

const TOKEN = '111222333:AAWizardToken'
const CHAT_ID = 4242

type Scripted = {
  io: OnboardIo
  prints: string[]
  envText: () => string
  unitText: () => string | undefined
}

/** One smart fetch: getMe ok, getUpdates returns the admin message (or empty),
 * the Ollama endpoint lists glm. Everything else 200 {}. */
function smartFetch(updates: unknown[] = [{ update_id: 5, message: { chat: { id: CHAT_ID, first_name: 'Example User' }, from: { id: CHAT_ID, first_name: 'Example User' } } }]): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url)
    if (u.includes('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'wizard_bot' } }), { status: 200 })
    if (u.includes('/getUpdates')) return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 })
    if (u.includes('11434')) return new Response(JSON.stringify({ data: [{ id: 'glm-5.3-flash:cloud' }] }), { status: 200 })
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
  }) as unknown as typeof fetch
}

function scriptedIo(opts: {
  askAnswers?: string[]
  hiddenAnswers?: string[]
  confirmAnswers?: boolean[]
  logTail?: string
  deskActive?: boolean
  updates?: unknown[]
} = {}): Scripted {
  const dir = tmpDir()
  const prints: string[] = []
  const io: OnboardIo = {
    repoDir: dir,
    envPath: path.join(dir, '.env'),
    homeDir: dir,
    unitPath: path.join(dir, 'systemd', 'user', 'frog-to-toad-agent.service'),
    unitTemplatePath: path.resolve('deploy/frog-to-toad-agent.service'),
    logFile: path.join(dir, 'frog-to-toad-agent.log'),
    isTty: true,
    platform: 'linux',
    fetchImpl: smartFetch(opts.updates),
    exec: async (cmd, args): Promise<ExecResult> => {
      // systemctl --user <verb> … → verb is args[1]
      if (cmd === 'systemctl' && args[1] === 'is-active') return { status: opts.deskActive ? 0 : 3, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    readLogTail: () => opts.logTail ?? '',
    print: (s) => prints.push(s ?? ''),
    ask: async () => opts.askAnswers?.shift() ?? '',
    askHidden: async () => opts.hiddenAnswers?.shift() ?? '',
    confirm: async () => opts.confirmAnswers?.shift() ?? false,
    sleep: async () => undefined,
    runCodexLogin: async () => path.join(dir, 'codex-auth.json'),
  }
  return {
    io,
    prints,
    envText: () => fs.readFileSync(io.envPath, 'utf8'),
    unitText: () => {
      try { return fs.readFileSync(io.unitPath, 'utf8') } catch { return undefined }
    },
  }
}

const deps = (overrides: Partial<{ doctorOk: boolean; doctorDetail: string; bootTimeoutMs: number }> = {}) => ({
  runDoctorFn: async () => ({ ok: overrides.doctorOk ?? true, detail: overrides.doctorDetail ?? 'doctor: healthy' }),
  bootTimeoutMs: overrides.bootTimeoutMs ?? 40,
  discoveryTimeoutMs: 60,
})

const EMPTY_UPDATES: unknown[] = []

describe('runOnboarding', () => {
  it('happy path on a fresh dir: token → chat id → ollama → .env → unit → boot → doctor → ping → exit 0', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['3'], // brain menu → ollama
      confirmAnswers: [true, true, false], // use chat id / ollama / full doctor
      logTail: 'frog-to-toad-agent is live.',
    })
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(0)
    const env = s.envText()
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${TOKEN}`)
    expect(env).toContain(`TELEGRAM_ADMIN_CHAT_ID=${CHAT_ID}`)
    expect(env).toContain(`TELEGRAM_PRINCIPAL_USER_ID=${CHAT_ID}`)
    expect(env).toContain('DRY_RUN=true') // forced on a fresh .env
    expect(env).toContain('LLM_PROVIDER=ollama')
    expect(env).toContain('LLM_MODEL=glm-5.3-flash:cloud')
    expect(env).toContain('BRAIN=glm')
    expect(s.unitText()).toBeTruthy()
    expect(s.prints.join('\n')).toContain('ping delivered')
    expect(s.prints.join('\n')).toContain('dry-run first')
  })

  it('invalid brain pick → exit 1 at the brain step (token/chat not yet written)', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['9'], // brain menu → invalid → abort
      confirmAnswers: [true], // use discovered chat id
    })
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(1)
    expect(fs.existsSync(s.io.envPath)).toBe(false)
  })

  it('empty hidden token twice → abort before any .env write', async () => {
    const s = scriptedIo({ hiddenAnswers: ['', ''] })
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(1)
    expect(fs.existsSync(s.io.envPath)).toBe(false)
  })

  it('discovery dead → falls back to manual entry; Enter keeps the current token', async () => {
    const s = scriptedIo({
      hiddenAnswers: [], // .env seeded below → keep-token path (ask, not hidden)
      askAnswers: ['', '999', '999', '3'], // keep token; manual chat + principal ids; brain ollama
      confirmAnswers: [true, false], // ollama yes; full doctor no
      updates: EMPTY_UPDATES,
      logTail: 'frog-to-toad-agent is live.',
    })
    fs.writeFileSync(s.io.envPath, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ADMIN_CHAT_ID=42\nDRY_RUN=true\n`, 'utf8')
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(0)
    const env = s.envText()
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${TOKEN}`) // Enter kept it
    expect(env).toContain('TELEGRAM_ADMIN_CHAT_ID=999')
    expect(env).toContain('DRY_RUN=true') // existing value preserved
  })

  it('desk already polling → skips getUpdates, manual chat id only', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['555', '555', '3'], // manual chat + principal ids; ollama
      confirmAnswers: [true, false], // ollama yes; full doctor no
      deskActive: true,
      logTail: 'frog-to-toad-agent is live.',
    })
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(0)
    expect(s.envText()).toContain('TELEGRAM_ADMIN_CHAT_ID=555')
    expect(s.prints.join('\n')).toContain('private') // the manual-entry tip
  })

  it('unit declined → boot skipped, ping still sent, exit 0', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['4242', '4242', '3'], // manual chat + principal ids; ollama
      confirmAnswers: [true, false, false], // ollama yes; overwrite unit NO; full doctor no
      updates: EMPTY_UPDATES,
      logTail: '',
    })
    fs.mkdirSync(path.dirname(s.io.unitPath), { recursive: true })
    fs.writeFileSync(s.io.unitPath, '# hand-tuned\n')
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(0)
    expect(s.prints.join('\n')).toContain('skipped')
    expect(s.prints.join('\n')).toContain('ping delivered')
  })

  it('boot watch timeout → exit 1 with a journalctl hint', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['4242', '4242', '3'],
      confirmAnswers: [true, false], // ollama yes; full doctor no
      updates: EMPTY_UPDATES,
      logTail: '', // never a boot marker
    })
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(1)
    expect(s.prints.join('\n')).toContain('journalctl')
  })

  it('boot fatal marker → exit 1 with the last log lines', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['4242', '4242', '3'],
      confirmAnswers: [true, false],
      updates: EMPTY_UPDATES,
      logTail: 'ERR fatal: Telegram polling died',
    })
    const exit = await runOnboarding(s.io, deps())
    expect(exit).toBe(1)
    expect(s.prints.join('\n')).toContain('boot failed')
  })

  it('doctor.json fresh → read back, no fallback run', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['4242', '4242', '3'],
      confirmAnswers: [true, false],
      updates: EMPTY_UPDATES,
      logTail: 'frog-to-toad-agent is live.',
    })
    fs.mkdirSync(path.join(s.io.repoDir, 'data', 'state'), { recursive: true })
    fs.writeFileSync(path.join(s.io.repoDir, 'data', 'state', 'doctor.json'), JSON.stringify({ lastRunTs: Date.now(), cheapOk: true }), 'utf8')
    let fallbackCalls = 0
    const exit = await runOnboarding(s.io, {
      runDoctorFn: async () => { fallbackCalls++; return { ok: true, detail: 'fallback' } },
      bootTimeoutMs: 40,
      discoveryTimeoutMs: 60,
    })
    expect(exit).toBe(0)
    expect(fallbackCalls).toBe(0)
    expect(s.prints.join('\n')).toContain('healthy')
  })

  it('doctor.json missing → in-wizard fallback runs (result reported, not fatal)', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['4242', '4242', '3'],
      confirmAnswers: [true, false],
      updates: EMPTY_UPDATES,
      logTail: 'frog-to-toad-agent is live.',
    })
    let fallbackCalls = 0
    const exit = await runOnboarding(s.io, {
      runDoctorFn: async () => { fallbackCalls++; return { ok: false, detail: 'doctor: UNHEALTHY brain stage' } },
      bootTimeoutMs: 40,
      discoveryTimeoutMs: 60,
    })
    expect(exit).toBe(0)
    expect(fallbackCalls).toBe(1)
    expect(s.prints.join('\n')).toContain('UNHEALTHY')
  })

  it('SECRET HYGIENE: the token never appears in any printed line', async () => {
    const s = scriptedIo({
      hiddenAnswers: [TOKEN],
      askAnswers: ['4242', '4242', '3'],
      confirmAnswers: [true, false],
      updates: EMPTY_UPDATES,
      logTail: 'frog-to-toad-agent is live.',
    })
    await runOnboarding(s.io, deps())
    expect(s.prints.join('\n')).not.toContain(TOKEN)
  })
})

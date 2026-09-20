import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { askHidden } from '../src/onboard/prompt.js'
import { buildChecklist, assessChecklist, maskSecret, renderChecklist, missingRequired } from '../src/onboard/checklist.js'
import { probeBotToken, discoverAdminChatId, sendOnboardingPing, sanitizeToken } from '../src/onboard/telegram.js'
import { nodeBinDir, renderUnitTemplate, unitsDiffer, unitPathFor, installUnit } from '../src/onboard/unit.js'
import type { OnboardIo, ExecResult } from '../src/onboard/types.js'

// Self-contained tmpdirs, injected fetch/exec — no network, no /tmp, no subprocess.
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-'))
  dirs.push(d)
  return d
}

const TOKEN = '123456:ABC-fake-token'

function fakeIo(overrides: Partial<OnboardIo> = {}): OnboardIo {
  const dir = tmpDir()
  return {
    repoDir: dir,
    envPath: path.join(dir, '.env'),
    homeDir: dir,
    unitPath: path.join(dir, 'systemd', 'user', 'frog-to-toad-agent.service'),
    unitTemplatePath: path.resolve('deploy/frog-to-toad-agent.service'),
    logFile: path.join(dir, 'desk.log'),
    isTty: false,
    platform: 'linux',
    fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    exec: async () => ({ status: 0, stdout: '', stderr: '' }),
    readLogTail: () => '',
    print: () => undefined,
    ask: async () => '',
    askHidden: async () => '',
    confirm: async () => false,
    sleep: async () => undefined,
    runCodexLogin: async () => path.join(dir, 'codex-auth.json'),
    ...overrides,
  }
}

// ── checklist ────────────────────────────────────────────────────────────────

describe('maskSecret', () => {
  it('masks like describeConfig: first4…last2', () => {
    expect(maskSecret('1234567890:ABCDEF')).toBe('1234…EF')
    expect(maskSecret(undefined)).toBe('(missing)')
    expect(maskSecret('')).toBe('(missing)')
    expect(maskSecret('short')).toBe('••••')
  })
})

describe('checklist', () => {
  it('renders statuses with glyphs and required-missing as [!]', async () => {
    const io = fakeIo()
    fs.writeFileSync(io.envPath, 'TELEGRAM_BOT_TOKEN=1234567890:ABCDEF\nTELEGRAM_ADMIN_CHAT_ID=42\nTELEGRAM_PRINCIPAL_USER_ID=42\nDRY_RUN=true\n', 'utf8')
    const items = await assessChecklist(buildChecklist(io), io)
    const text = renderChecklist(items)
    expect(text).toContain('✓] Telegram bot token       1234…EF')
    expect(text).toContain('✓] Telegram admin chat id   42')
    expect(text).toContain('✓] Telegram principal user id 42')
    expect(text).toContain('✓] Dry-run safety')
    expect(text).toContain('i] Wallet lane')
    expect(missingRequired(items)).not.toContain('Telegram bot token')
  })

  it('treats a commented template line as missing (reads via envValueOf)', async () => {
    const io = fakeIo()
    fs.writeFileSync(io.envPath, '#TELEGRAM_BOT_TOKEN=\n', 'utf8')
    const items = await assessChecklist(buildChecklist(io), io)
    const token = items.find((i) => i.key === 'TELEGRAM_BOT_TOKEN')!
    expect(token.result.status).toBe('missing')
    expect(missingRequired(items)).toContain('Telegram bot token')
  })

  it('node probe reflects the running node', async () => {
    const io = fakeIo()
    const items = await assessChecklist(buildChecklist(io), io)
    const node = items.find((i) => i.key === 'node')!
    expect(node.result.status).toBe('ok')
    expect(node.result.detail).toMatch(/^v\d/)
  })

  it('systemctl absence is a warn, not a missing', async () => {
    const io = fakeIo({
      exec: async () => ({ status: 127, stdout: '', stderr: 'command not found' }),
    })
    const items = await assessChecklist(buildChecklist(io), io)
    expect(items.find((i) => i.key === 'systemd')!.result.status).toBe('warn')
  })

  it('a throwing probe degrades to warn (never blocks)', async () => {
    const io = fakeIo({
      exec: async () => { throw new Error('boom') },
    })
    const items = await assessChecklist(buildChecklist(io), io)
    expect(items.find((i) => i.key === 'systemd')!.result.status).toBe('warn')
  })

  it('dry-run=false with no MCP_COMMAND flags the wallet lane', async () => {
    const io = fakeIo()
    fs.writeFileSync(io.envPath, 'DRY_RUN=false\n', 'utf8')
    const items = await assessChecklist(buildChecklist(io), io)
    const wallet = items.find((i) => i.key === 'wallet')!
    expect(wallet.result.status).toBe('missing')
    expect(wallet.result.detail).toContain('MCP_COMMAND')
  })
})

// ── telegram probes ──────────────────────────────────────────────────────────

describe('sanitizeToken', () => {
  it('strips the token from accidental URL echoes', () => {
    expect(sanitizeToken(TOKEN, `get bot${TOKEN}/getMe failed: ${TOKEN}`)).not.toContain(TOKEN)
  })
})

describe('probeBotToken', () => {
  it('ok on 200 with username', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, result: { username: 'tommy_desk_bot' } }), { status: 200 })) as unknown as typeof fetch
    const probe = await probeBotToken(TOKEN, fetchImpl)
    expect(probe).toEqual({ ok: true, username: 'tommy_desk_bot' })
  })

  it('401 → invalid token; 404 → malformed', async () => {
    const f401 = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch
    expect((await probeBotToken(TOKEN, f401)).error).toContain('invalid token')
    const f404 = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch
    expect((await probeBotToken(TOKEN, f404)).error).toContain('malformed')
  })

  it('network failure is returned (not thrown) and never leaks the token', async () => {
    const dead = (async () => {
      throw new Error(`get "https://api.telegram.org/bot${TOKEN}/getMe": connect ECONNREFUSED`)
    }) as unknown as typeof fetch
    const probe = await probeBotToken(TOKEN, dead)
    expect(probe.ok).toBe(false)
    expect(probe.error).not.toContain(TOKEN)
  })
})

describe('discoverAdminChatId', () => {
  const messageUpdate = (chatId: number, name = 'Example User') => ({
    update_id: 7,
    message: { chat: { id: chatId, first_name: name }, from: { id: chatId, first_name: name } },
  })

  it('extracts chat id from update.message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, result: [messageUpdate(123456789)] }), { status: 200 })) as unknown as typeof fetch
    const r = await discoverAdminChatId(TOKEN, { timeoutMs: 5_000 }, fetchImpl)
    expect(r.chatId).toBe(123456789)
    expect(r.principalUserId).toBe(123456789)
    expect(r.name).toBe('Example User')
  })

  it('ignores non-message updates and keeps polling until a message arrives', async () => {
    let call = 0
    const responses = [
      { ok: true, result: [{ update_id: 1, channel_post: { chat: { id: -100 } } }] },
      { ok: true, result: [{ update_id: 2, edited_message: { chat: { id: 5 } } }] },
      { ok: true, result: [{ update_id: 3, callback_query: { id: 'x' } }] },
      { ok: true, result: [messageUpdate(99, 'Example Two')] },
    ]
    const fetchImpl = (async () => {
      const body = responses[Math.min(call++, responses.length - 1)]
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const r = await discoverAdminChatId(TOKEN, { timeoutMs: 10_000 }, fetchImpl)
    expect(r.chatId).toBe(99)
  })

  it('409 → conflict error, no retry', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response('Conflict', { status: 409 })
    }) as unknown as typeof fetch
    const r = await discoverAdminChatId(TOKEN, { timeoutMs: 10_000 }, fetchImpl)
    expect(r).toEqual({ error: 'conflict' })
    expect(calls).toBe(1)
  })

  it('network error never leaks the token', async () => {
    const dead = (async () => {
      throw new Error(`GET bot${TOKEN}/getUpdates failed`)
    }) as unknown as typeof fetch
    const r = await discoverAdminChatId(TOKEN, { timeoutMs: 5_000 }, dead)
    expect(r.error).not.toContain(TOKEN)
  })
})

describe('sendOnboardingPing', () => {
  it('ok on 200', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    expect(await sendOnboardingPing(TOKEN, 42, 'hi', fetchImpl)).toEqual({ ok: true })
  })

  it('403 error without the token in it', async () => {
    const fetchImpl = (async () => {
      throw new Error(`bot${TOKEN}/sendMessage blocked`)
    }) as unknown as typeof fetch
    const r = await sendOnboardingPing(TOKEN, 42, 'hi', fetchImpl)
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain(TOKEN)
  })
})

// ── askHidden ────────────────────────────────────────────────────────────────

type FakeStdin = {
  isTTY: boolean
  setRawMode?: (m: boolean) => unknown
  on: (ev: string, fn: (ch: Buffer) => void) => void
  removeListener: (ev: string, fn: (ch: Buffer) => void) => void
}

function fakeStdin(opts: { isTty?: boolean } = {}): FakeStdin & { emit: (ch: string) => void; rawModes: boolean[] } {
  const listeners: Array<(ch: Buffer) => void> = []
  const rawModes: boolean[] = []
  return {
    isTTY: opts.isTty ?? true,
    setRawMode: (m) => { rawModes.push(m) },
    on: (_ev, fn) => listeners.push(fn),
    removeListener: (_ev, fn) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    emit: (ch) => listeners.forEach((fn) => fn(Buffer.from(ch))),
    rawModes,
  }
}

async function hiddenWithInput(input: string[]): Promise<{ value: string; out: string[]; stdin: ReturnType<typeof fakeStdin> }> {
  const stdin = fakeStdin()
  const out: string[] = []
  const stdout = { write: (s: string) => { out.push(s) } } as unknown as NodeJS.WritableStream
  const promise = askHidden('tok: ', { stdin: stdin as unknown as NonNullable<Parameters<typeof askHidden>[1]>['stdin'], stdout })
  // deliver chars after the listener is attached (microtask ordering)
  await new Promise((r) => setTimeout(r, 0))
  for (const ch of input) stdin.emit(ch)
  return { value: await promise, out, stdin }
}

describe('askHidden', () => {
  it('collects chars and shows only bullets', async () => {
    const { value, out } = await hiddenWithInput(['a', 'b', '\r'])
    expect(value).toBe('ab')
    const visible = out.join('')
    expect(visible).toContain('•')
    expect(visible).not.toContain('a')
    expect(visible).not.toContain('b')
  })

  it('backspace erases', async () => {
    const { value } = await hiddenWithInput(['a', 'b', '\x7f', 'c', '\n'])
    expect(value).toBe('ac')
  })

  it('non-TTY stdin fails loud (never accepts piped secrets)', async () => {
    await expect(
      askHidden('tok: ', { stdin: { isTTY: false } as unknown as NodeJS.ReadableStream }),
    ).rejects.toThrow('TTY')
  })
})

// ── unit template ────────────────────────────────────────────────────────────

describe('unit helpers', () => {
  it('nodeBinDir derives from execPath', () => {
    expect(nodeBinDir('/opt/node/bin/node')).toBe('/opt/node/bin')
  })

  it('unitPathFor lands in ~/.config/systemd/user', () => {
    expect(unitPathFor('/home/example')).toBe('/home/example/.config/systemd/user/frog-to-toad-agent.service')
  })

  it('renderUnitTemplate resolves placeholders and keeps unknown ones loud', () => {
    const rendered = renderUnitTemplate('cd {{REPO_DIR}} && {{NODE_BIN_DIR}}/npm run dev @ {{HOME}} {{MYSTERY}}', {
      repoDir: '/srv/desk',
      nodeBinDir: '/opt/node/bin',
      homeDir: '/home/example',
    })
    expect(rendered).toContain('/srv/desk')
    expect(rendered).toContain('/opt/node/bin/npm run dev')
    expect(rendered).toContain('/home/example')
    expect(rendered).toContain('{{MYSTERY}}')
    expect(rendered).not.toContain('{{REPO_DIR}}')
  })

  it('FROG_TO_TOAD_DIR renders an env line; absent → clean line removal', () => {
    const t = '{{FROG_TO_TOAD_DIR_ENV}}\nExecStart=x'
    expect(renderUnitTemplate(t, { repoDir: 'r', nodeBinDir: 'n', homeDir: 'h', deskDir: '/data' })).toContain('Environment=FROG_TO_TOAD_DIR=/data')
    expect(renderUnitTemplate(t, { repoDir: 'r', nodeBinDir: 'n', homeDir: 'h' })).not.toContain('FROG_TO_TOAD_DIR')
  })

  it('unitsDiffer ignores trailing whitespace', () => {
    expect(unitsDiffer('a\n', 'a')).toBe(false)
    expect(unitsDiffer('a\n', 'b')).toBe(true)
  })
})

describe('installUnit', () => {
  const template = fs.readFileSync(path.resolve('deploy/frog-to-toad-agent.service'), 'utf8')
  function rendered(ctx: { repoDir?: string } = {}): string {
    return renderUnitTemplate(template, {
      repoDir: ctx.repoDir ?? '/nowhere',
      nodeBinDir: nodeBinDir(), // match installUnit's real execPath lookup
      homeDir: '/home/x',
      deskDir: process.env.FROG_TO_TOAD_DIR ?? process.env.TRADING_DESK_DIR,
    })
  }

  it('writes the unit then daemon-reload then enable, in order', async () => {
    const io = fakeIo()
    const calls: string[] = []
    io.exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`)
      return { status: 0, stdout: '', stderr: '' }
    }
    let confirmed = false
    io.confirm = async () => { confirmed = true; return true }
    const outcome = await installUnit(io)
    expect(outcome).toBe('installed')
    const text = fs.readFileSync(io.unitPath, 'utf8')
    expect(text).toContain(io.repoDir)
    expect(text).not.toContain('{{')
    expect(calls[0]).toContain('daemon-reload')
    expect(calls[1]).toContain('enable')
    expect(calls[2]).toContain('enable-linger')
    expect(confirmed).toBe(false) // no existing unit → no clobber prompt
  })

  it('identical existing unit → kept, zero exec', async () => {
    const io = fakeIo()
    fs.mkdirSync(path.dirname(io.unitPath), { recursive: true })
    fs.writeFileSync(io.unitPath, rendered({ repoDir: io.repoDir }))
    let execs = 0
    io.exec = async () => { execs++; return { status: 0, stdout: '', stderr: '' } }
    expect(await installUnit(io)).toBe('kept')
    expect(execs).toBe(0)
  })

  it('differing existing unit + decline → aborted, nothing written', async () => {
    const io = fakeIo()
    fs.mkdirSync(path.dirname(io.unitPath), { recursive: true })
    fs.writeFileSync(io.unitPath, '# hand-tuned unit\n')
    io.confirm = async () => false
    expect(await installUnit(io)).toBe('aborted')
    expect(fs.readFileSync(io.unitPath, 'utf8')).toBe('# hand-tuned unit\n')
  })

  it('differing existing unit + confirm → overwritten', async () => {
    const io = fakeIo()
    fs.mkdirSync(path.dirname(io.unitPath), { recursive: true })
    fs.writeFileSync(io.unitPath, '# hand-tuned unit\n')
    io.confirm = async () => true
    expect(await installUnit(io)).toBe('installed')
    expect(fs.readFileSync(io.unitPath, 'utf8')).toContain('[Service]')
  })

  it('linger failure is best-effort (still installed, hint printed)', async () => {
    const io = fakeIo()
    let sawHint = false
    io.exec = async (cmd) => (cmd === 'loginctl' ? { status: 1, stdout: '', stderr: 'polkit' } : { status: 0, stdout: '', stderr: '' })
    io.print = (s) => { if (s?.includes('enable-linger')) sawHint = true }
    expect(await installUnit(io)).toBe('installed')
    expect(sawHint).toBe(true)
  })

  it('daemon-reload failure → aborted with a hint', async () => {
    const io = fakeIo()
    let systemctlCalls = 0
    io.exec = async (cmd) => {
      if (cmd === 'systemctl') {
        systemctlCalls++
        if (systemctlCalls === 1) return { status: 1, stdout: '', stderr: 'not reachable' } // daemon-reload
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    expect(await installUnit(io)).toBe('aborted')
  })

  it('non-Linux → unsupported, no exec', async () => {
    const io = fakeIo({ platform: 'darwin' })
    let execs = 0
    io.exec = async () => { execs++; return { status: 0, stdout: '', stderr: '' } }
    expect(await installUnit(io)).toBe('unsupported')
    expect(execs).toBe(0)
  })
})

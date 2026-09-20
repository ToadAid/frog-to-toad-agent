import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import {
  jailResolve,
  looksBinary,
  sandboxRoot,
  sandboxOpsPath,
  workspaceReadTool,
  workspaceWriteTool,
  workspaceListToolDef,
} from '../src/tools/workspace.js'
import { commandAllowlist, isAllowed, splitCommand, scrubEnv, execRunTool, probeSandboxRuntime } from '../src/tools/exec.js'
import { workspaceSnapshotTool, workspaceDiffTool, diffLines } from '../src/tools/coding.js'
import { isPrivateIp, htmlToText } from '../src/tools/browser.js'
import { doctorStatePath } from '../src/doctor/doctor.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-hands-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

/** Write the doctor state file directly (runFullDoctor writes it via npx — too slow for unit tests). */
function writeState(state: Record<string, unknown>): void {
  const file = doctorStatePath(cfg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state))
}

/** A passing doctor state — hands open. */
function openGate(): void {
  writeState({ lastRunTs: Date.now(), cheapOk: true, lastTestGreenAt: Date.now() })
}

beforeEach(() => {
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true })
  delete process.env.COMMAND_ALLOWLIST
  openGate()
})

const ctx = (overrides: Partial<Parameters<typeof execRunTool.execute>[1]> = {}) =>
  ({
    cfg,
    agent: { name: 'test-agent' },
    runId: 't',
    chatId: 0,
    signal: new AbortController().signal,
    notify: async () => {},
    requestApproval: async () => 'deny' as const,
    callSubagent: async () => '',
    send: {},
    ...overrides,
  }) as Parameters<typeof execRunTool.execute>[1]

describe('12.0 — doctor gate', () => {
  it('hands gate is CLOSED without a doctor state (fail-closed)', () => {
    fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true })
    // handsGateOpen imported dynamically to avoid hoisting issues
    return import('../src/doctor/doctor.js').then(({ handsGateOpen }) => {
      expect(handsGateOpen(cfg)).toBe(false)
    })
  })

  it('hands gate opens on a fresh full-doctor green and closes when stale (> 7d)', async () => {
    const { handsGateOpen, TEST_GREEN_MAX_AGE_MS } = await import('../src/doctor/doctor.js')
    expect(handsGateOpen(cfg)).toBe(true)
    writeState({ lastRunTs: Date.now(), cheapOk: true, lastTestGreenAt: Date.now() - TEST_GREEN_MAX_AGE_MS - 1 })
    expect(handsGateOpen(cfg)).toBe(false)
    // cheap-stage failure also closes it even with a green test run
    writeState({ lastRunTs: Date.now(), cheapOk: false, lastTestGreenAt: Date.now() })
    expect(handsGateOpen(cfg)).toBe(false)
  })

  it('env-sanity stage flags wallet secrets in the desk .env', async () => {
    const { runDoctor } = await import('../src/doctor/doctor.js')
    fs.writeFileSync(path.join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=abc\nCDP_API_PRIVATE_KEY=0xdeadbeef\n')
    const report = await runDoctor(cfg)
    const env = report.stages.find((s) => s.name === 'env')!
    expect(env.ok).toBe(false)
    expect(env.detail).toContain('CDP_API_PRIVATE_KEY')
  })

  it('env-sanity tolerates legitimate LLM/Telegram keys', async () => {
    const { runDoctor } = await import('../src/doctor/doctor.js')
    fs.writeFileSync(path.join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=abc\nLLM_API_KEY=sk-test123\n')
    const report = await runDoctor(cfg)
    expect(report.stages.find((s) => s.name === 'env')!.ok).toBe(true)
  })

  it('workspace/exec/browser refuse when the gate is closed', async () => {
    fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true }) // no doctor state
    const read = await workspaceReadTool.execute({ path: 'x.txt' }, ctx())
    expect(read.text).toContain('hands are gated')
    const write = await workspaceWriteTool.execute({ path: 'x.txt', content: 'hi' }, ctx())
    expect(write.text).toContain('hands are gated')
    const exec = await execRunTool.execute({ command: 'npm test' }, ctx())
    expect(exec.text).toContain('hands are gated')
    const snap = await workspaceSnapshotTool.execute({}, ctx())
    expect(snap.text).toContain('hands are gated')
  })
})

describe('12.1 — workspace jail', () => {
  it('jailResolve keeps normal paths inside and refuses escapes', () => {
    expect(jailResolve(cfg, 'notes/btc.md')).toBe(path.join(cfg.paths.dataDir, 'sandbox', 'notes', 'btc.md'))
    expect(() => jailResolve(cfg, '../outside.txt')).toThrow(/jail/)
    expect(() => jailResolve(cfg, '/etc/passwd')).toThrow(/jail/)
    expect(() => jailResolve(cfg, '../../etc/passwd')).toThrow(/jail/)
  })

  it('symlink escape is refused', () => {
    const root = cfg.paths.dataDir
    fs.mkdirSync(path.join(root, 'sandbox'), { recursive: true })
    fs.symlinkSync('/etc', path.join(root, 'sandbox', 'evil'))
    expect(() => jailResolve(cfg, 'evil/passwd')).toThrow(/symlink/)
  })

  it('binary sniff: null bytes or heavy control chars refused, utf8 text passes', () => {
    expect(looksBinary(Buffer.from('hello world\nplain text'))).toBe(false)
    expect(looksBinary(Buffer.concat([Buffer.from('ok'), Buffer.from([0, 0, 1, 2, 3])]))).toBe(true)
    expect(looksBinary(Buffer.from('café — ünïcode ✅ ok'))).toBe(false)
  })

  it('write creates dirs, is atomic, keeps a .bak, and journals the op', async () => {
    const w1 = await workspaceWriteTool.execute({ path: 'sub/file.txt', content: 'v1' }, ctx())
    expect(w1.text).toContain('wrote sandbox:sub/file.txt')
    await workspaceWriteTool.execute({ path: 'sub/file.txt', content: 'v2' }, ctx())
    expect(fs.readFileSync(path.join(cfg.paths.dataDir, 'sandbox', 'sub', 'file.txt'), 'utf8')).toBe('v2')
    expect(fs.readFileSync(path.join(cfg.paths.dataDir, 'sandbox', 'sub', 'file.txt.bak'), 'utf8')).toBe('v1')
    const ops = fs.readFileSync(sandboxOpsPath(cfg), 'utf8').trim().split('\n')
    expect(ops.length).toBe(2)
    expect(JSON.parse(ops[1]!).op).toBe('write')
  })

  it('enforces the repo mirror as read-only, including dot-segment aliases', async () => {
    const direct = await workspaceWriteTool.execute({ path: 'repo/src/index.ts', content: 'nope' }, ctx())
    expect(direct.text).toContain('read-only repo mirror')

    const alias = await workspaceWriteTool.execute({
      path: 'scratch/../repo/src/index.ts',
      content: 'still nope',
    }, ctx())
    expect(alias.text).toContain('read-only repo mirror')
  })

  it('read returns text and refuses missing files / binaries / over-cap sizes', async () => {
    fs.mkdirSync(path.join(cfg.paths.dataDir, 'sandbox'), { recursive: true })
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'sandbox', 'ok.txt'), 'readable text')
    const ok = await workspaceReadTool.execute({ path: 'ok.txt' }, ctx())
    expect(ok.text).toBe('readable text')
    const missing = await workspaceReadTool.execute({ path: 'nope.txt' }, ctx())
    expect(missing.text).toContain('cannot read')
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'sandbox', 'bin.txt'), Buffer.from([0, 1, 2, 3]))
    const bin = await workspaceReadTool.execute({ path: 'bin.txt' }, ctx())
    expect(bin.text).toContain('binary')
    fs.writeFileSync(path.join(cfg.paths.dataDir, 'sandbox', 'big.txt'), 'x'.repeat(65 * 1024))
    const big = await workspaceReadTool.execute({ path: 'big.txt' }, ctx())
    expect(big.text).toContain('read cap')
  })

  it('workspace_list shows files and hides the journals', async () => {
    await workspaceWriteTool.execute({ path: 'a.txt', content: 'x' }, ctx())
    const list = await workspaceListToolDef.execute({}, ctx())
    expect(list.text).toContain('a.txt')
    expect(list.text).not.toContain('.ops.jsonl')
  })
})

describe('12.3 — safe exec', () => {
  const sandboxRuntime = probeSandboxRuntime()
  it('allowlist parsing + matching is word-boundary exact', () => {
    expect(isAllowed('npm test', ['npm test'])).toBe(true)
    expect(isAllowed('npm testxyz', ['npm test'])).toBe(false)
    expect(isAllowed('npm run check', ['npm run check'])).toBe(true)
    expect(isAllowed('node scripts/x.ts', ['node scripts/'])).toBe(true)
    expect(isAllowed('node scripts', ['node scripts/'])).toBe(false)
    expect(isAllowed('rm -rf /', ['npm test'])).toBe(false)
    expect(commandAllowlist({ COMMAND_ALLOWLIST: 'npm test, node scripts/' })).toEqual(['npm test', 'node scripts/'])
  })

  it('splitCommand never produces a shell string — quote-aware tokenizing, no expansion', () => {
    expect(splitCommand('npm test')).toEqual({ executable: 'npm', args: ['test'] })
    expect(splitCommand('node  scripts/a.ts --flag 1')).toEqual({ executable: 'node', args: ['scripts/a.ts', '--flag', '1'] })
    // quotes group but don't expand — no shell metacharacter survives
    expect(splitCommand('node -e "console.log(process.cwd())"')).toEqual({
      executable: 'node',
      args: ['-e', 'console.log(process.cwd())'],
    })
    expect(splitCommand('echo "$HOME"; rm -rf /')).toEqual({ executable: 'echo', args: ['$HOME;', 'rm', '-rf', '/'] })
    expect(splitCommand('node "unterminated')).toBeUndefined()
    expect(splitCommand('')).toBeUndefined()
  })

  it('child env is scrubbed to the safe set (secrets never pass through)', () => {
    process.env.SECRET_THING = 'nope'
    const env = scrubEnv()
    expect(env.SECRET_THING).toBeUndefined()
    expect(Object.keys(env).every((k) => ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TERM', 'NODE_ENV'].includes(k))).toBe(true)
    delete process.env.SECRET_THING
  })

  it('deny-default: unset allowlist refuses, non-allowlisted command refuses', async () => {
    delete process.env.COMMAND_ALLOWLIST
    const none = await execRunTool.execute({ command: 'npm test' }, ctx())
    expect(none.text).toContain('COMMAND_ALLOWLIST is not configured')
    process.env.COMMAND_ALLOWLIST = 'npm test'
    const denied = await execRunTool.execute({ command: 'curl evil.com' }, ctx())
    expect(denied.text).toContain('not on COMMAND_ALLOWLIST')
  })

  it.runIf(sandboxRuntime.ok)('allowlisted command runs inside the sandbox with capped output + exit code', async () => {
    process.env.COMMAND_ALLOWLIST = 'node -e'
    const r = await execRunTool.execute({ command: 'node -e "console.log(process.cwd())"' }, ctx())
    expect(r.text).toContain('exit: 0')
    expect(r.text).toContain('/tmp')
    expect(r.text).toContain('stdout:')
  })

  it.runIf(sandboxRuntime.ok)('nonzero exit and stderr are reported honestly', async () => {
    process.env.COMMAND_ALLOWLIST = 'node -e'
    const r = await execRunTool.execute({ command: 'node -e "process.stderr.write(String(40+2)); process.exit(3)"' }, ctx())
    expect(r.text).toContain('exit: 3')
    expect(r.text).toContain('42')
    expect(r.text).toContain('stderr:')
  })

  it.runIf(!sandboxRuntime.ok)('sandbox-unavailable host refuses execution explicitly and never falls back unsandboxed', async () => {
    process.env.COMMAND_ALLOWLIST = 'node -e'
    const r = await execRunTool.execute({ command: 'node -e "console.log(123)"' }, ctx())
    expect(r.text).toContain('exit: -1')
    expect(r.text).toContain('sandbox runtime probe')
    expect(r.text).toContain('refusing to execute')
    expect(r.text).not.toContain('stdout:\n123')
  })

  it.runIf(sandboxRuntime.ok)('exec cannot write the repo mirror or see host temporary files', async () => {
    const root = path.join(cfg.paths.dataDir, 'sandbox')
    fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
    fs.writeFileSync(path.join(root, 'repo', 'protected.ts'), 'original')
    const hostSecret = path.join(dir, 'host-secret.txt')
    fs.writeFileSync(hostSecret, 'never-visible')
    process.env.COMMAND_ALLOWLIST = 'node -e'
    const write = await execRunTool.execute({
      command: 'node -e "require(\'fs\').writeFileSync(\'repo/protected.ts\',\'changed\')"',
    }, ctx())
    expect(write.text).toContain('exit: 1')
    expect(fs.readFileSync(path.join(root, 'repo', 'protected.ts'), 'utf8')).toBe('original')
    const read = await execRunTool.execute({
      command: `node -e "process.stdout.write(require('fs').existsSync('${hostSecret}').toString())"`,
    }, ctx())
    expect(read.text).toContain('false')
    expect(read.text).not.toContain('never-visible')
  })
})

describe('12.4 — coding flow', () => {
  it('diffLines produces a minimal LCS diff with counts', () => {
    const d = diffLines('a\nb\nc', 'a\nX\nc')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.hunks).toContain('- b')
    expect(d.hunks).toContain('+ X')
  })

  it('snapshot → edit → diff shows the change; unchanged files stay silent', async () => {
    await workspaceWriteTool.execute({ path: 'code.js', content: 'const a = 1\n' }, ctx())
    const snap = await workspaceSnapshotTool.execute({}, ctx())
    expect(snap.text).toContain('baseline frozen')
    await workspaceWriteTool.execute({ path: 'code.js', content: 'const a = 2\n' }, ctx())
    await workspaceWriteTool.execute({ path: 'new.js', content: 'brand new\n' }, ctx())
    const diff = await workspaceDiffTool.execute({}, ctx())
    expect(diff.text).toContain('CHANGED: code.js')
    expect(diff.text).toContain('- const a = 1')
    expect(diff.text).toContain('+ const a = 2')
    expect(diff.text).toContain('NEW: new.js')
    const clean = await workspaceDiffTool.execute({ file: 'nonexistent.txt' }, ctx())
    expect(clean.text).toContain('no changes vs baseline')
  })

  it('workspace_diff refuses traversal outside both jails', async () => {
    await workspaceSnapshotTool.execute({}, ctx())
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=do-not-read')
    const result = await workspaceDiffTool.execute({ file: '../../.env' }, ctx())
    expect(result.text).toContain('jail')
    expect(result.text).not.toContain('do-not-read')
  })

  it('a fresh snapshot removes deleted files from an older baseline', async () => {
    await workspaceWriteTool.execute({ path: 'old.txt', content: 'old' }, ctx())
    await workspaceSnapshotTool.execute({}, ctx())
    fs.rmSync(path.join(cfg.paths.dataDir, 'sandbox', 'old.txt'))
    await workspaceSnapshotTool.execute({}, ctx())
    expect(fs.existsSync(path.join(cfg.paths.dataDir, 'sandbox-baseline', 'old.txt'))).toBe(false)
  })

  it('diff before any snapshot is an honest error', async () => {
    const r = await workspaceDiffTool.execute({}, ctx())
    expect(r.text).toContain('no baseline yet')
  })
})

describe('12.5 — browser guards', () => {
  it('private ranges are all refused (SSRF)', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.1.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip)).toBe(true)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) {
      expect(isPrivateIp(ip)).toBe(false)
    }
  })

  it('htmlToText strips scripts/styles and keeps title, text, links', () => {
    const out = htmlToText(
      '<html><head><title>Hi</title><style>body{}</style></head><body><script>alert(1)</script><p>Hello &amp; world</p><a href="/x">Link one</a><a href="/y">Two</a></body></html>',
    )
    expect(out.title).toBe('Hi')
    expect(out.text).toContain('Hello & world')
    expect(out.text).not.toContain('alert(1)')
    expect(out.text).not.toContain('body{}')
    expect(out.links[0]).toContain('Link one')
    expect(out.links[0]).toContain('/x')
  })

  it('numeric entities decode', () => {
    const { text } = htmlToText('<p>&#65;&#66;</p>')
    expect(text).toContain('AB')
  })
})
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAgents } from '../src/agents/loader.js'
import {
  codegraphChildEnv,
  exploreRepoCode,
  inspectRepoEyes,
  readCodegraphVersionPin,
  repoRelation,
  verifyCodegraphVersion,
  type RepoEyesDeps,
} from '../src/repoEyes.js'
import { createToolRegistry } from '../src/tools/index.js'
import { repoCodeExploreTool, repoEyesStatusTool } from '../src/tools/repoEyes.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function fixture(): { local: string; remote: string } {
  const root = temp('repo-eyes-git-')
  const remote = path.join(root, 'origin.git')
  const local = path.join(root, 'local')
  fs.mkdirSync(local)
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(local, 'init', '--initial-branch=main')
  git(local, 'config', 'user.name', 'Repo Eyes Test')
  git(local, 'config', 'user.email', 'repo-eyes@example.invalid')
  fs.writeFileSync(path.join(local, 'record.txt'), 'base\n')
  git(local, 'add', 'record.txt')
  git(local, 'commit', '-m', 'base')
  git(local, 'remote', 'add', 'origin', remote)
  git(local, 'push', '-u', 'origin', 'main')
  return { local, remote }
}

function commit(cwd: string, text: string): void {
  fs.appendFileSync(path.join(cwd, 'record.txt'), `${text}\n`)
  git(cwd, 'add', 'record.txt')
  git(cwd, 'commit', '-m', text)
}

function clone(remote: string): string {
  const peer = path.join(path.dirname(remote), `peer-${Math.random().toString(16).slice(2)}`)
  git(path.dirname(remote), 'clone', remote, peer)
  git(peer, 'config', 'user.name', 'Repo Eyes Peer')
  git(peer, 'config', 'user.email', 'repo-eyes-peer@example.invalid')
  return peer
}

function fakeDeps(version = '1.6.0', initialized = true): RepoEyesDeps {
  return {
    exists: (target) => target.endsWith('.codegraph') || target.includes('.tools/codegraph/current'),
    run: (command, args, cwd) => {
      if (command === 'git') {
        const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
      }
      if (args[0] === '--version') return { status: 0, stdout: `${version}\n`, stderr: '' }
      if (args[0] === 'status') {
        return { status: 0, stdout: JSON.stringify({ initialized, lastIndexed: '2026-09-10T12:00:00.000Z' }), stderr: '' }
      }
      if (args[0] === 'explore') return { status: 0, stdout: 'read-only graph result', stderr: '' }
      return { status: 1, stdout: '', stderr: 'unexpected command' }
    },
  }
}

describe('CodeGraph repo eyes provisioning and authority boundary', () => {
  it('forces telemetry and update checks off regardless of ambient values', () => {
    const env = codegraphChildEnv({
      PATH: '/usr/bin',
      CODEGRAPH_TELEMETRY: '1',
      DO_NOT_TRACK: '0',
      CODEGRAPH_NO_UPDATE_CHECK: '0',
      GITHUB_TOKEN: 'must-not-pass',
    })
    expect(env).toMatchObject({
      DO_NOT_TRACK: '1',
      CODEGRAPH_TELEMETRY: '0',
      CODEGRAPH_NO_UPDATE_CHECK: '1',
    })
    expect(env['GITHUB_TOKEN']).toBeUndefined()
  })

  it('applies the local-only environment to runtime and bootstrap CodeGraph launches', () => {
    const root = temp('repo-eyes-locality-')
    const binary = path.join(root, 'codegraph')
    fs.writeFileSync(binary, [
      '#!/usr/bin/env sh',
      'if [ "$DO_NOT_TRACK" = "1" ] && [ "$CODEGRAPH_TELEMETRY" = "0" ] && [ "$CODEGRAPH_NO_UPDATE_CHECK" = "1" ]; then',
      '  printf "1.6.0\\n"',
      'else',
      '  printf "0.0.0\\n"',
      'fi',
    ].join('\n'), { mode: 0o700 })

    expect(verifyCodegraphVersion(binary, '1.6.0', process.cwd())).toMatchObject({ ok: true, observed: '1.6.0' })
    const bootstrap = fs.readFileSync('scripts/codegraph.ts', 'utf8')
    expect(bootstrap).toContain("runRepoEyesChild(command, args, cwd, 'inherit')")
    expect(bootstrap).not.toContain('spawnSync(')
  })

  it('pins the reviewed CodeGraph version in the canonical lock', () => {
    expect(readCodegraphVersionPin(process.cwd())).toBe('1.6.0')
    const lock = JSON.parse(fs.readFileSync('codegraph.lock.json', 'utf8')) as { artifacts: Record<string, { sha256: string }> }
    expect(Object.keys(lock.artifacts).sort()).toEqual(['linux-arm64', 'linux-x64'])
    expect(Object.values(lock.artifacts).every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256))).toBe(true)
  })

  it('refuses an unexpected installed version', () => {
    const result = verifyCodegraphVersion('fake-codegraph', '1.6.0', process.cwd(), fakeDeps('1.5.0'))
    expect(result).toMatchObject({ ok: false, observed: '1.5.0' })
    expect(result.detail).toContain('expected CodeGraph 1.6.0')
  })

  it('reports READY only after exact-version binary and initialized graph checks pass', () => {
    const status = inspectRepoEyes(process.cwd(), { command: 'fake-codegraph', deps: fakeDeps() })
    expect(status).toMatchObject({ graphState: 'READY', observedCodegraphVersion: '1.6.0', graphForHead: null, authorityGranted: false })
  })

  it('reports UNAVAILABLE when the binary cannot run', () => {
    const deps = fakeDeps()
    deps.run = (command, args, cwd) => command === 'git'
      ? fakeDeps().run(command, args, cwd)
      : { status: null, stdout: '', stderr: 'ENOENT' }
    expect(inspectRepoEyes(process.cwd(), { command: '/missing/codegraph', deps }).graphState).toBe('UNAVAILABLE')
  })

  it('reports UNINITIALIZED without local generated graph state', () => {
    const deps = fakeDeps()
    deps.exists = () => false
    expect(inspectRepoEyes(process.cwd(), { command: 'fake-codegraph', deps }).graphState).toBe('UNINITIALIZED')
  })

  it('reports all deterministic Git ancestry relations', () => {
    const exact = fixture()
    expect(repoRelation(exact.local).relation).toBe('EXACT')

    const behind = fixture()
    const behindPeer = clone(behind.remote)
    commit(behindPeer, 'remote')
    git(behindPeer, 'push', 'origin', 'main')
    git(behind.local, 'fetch', 'origin', 'main')
    expect(repoRelation(behind.local).relation).toBe('LOCAL_BEHIND_ORIGIN')

    const ahead = fixture()
    commit(ahead.local, 'local')
    expect(repoRelation(ahead.local).relation).toBe('LOCAL_AHEAD_OF_ORIGIN')

    const diverged = fixture()
    const divergedPeer = clone(diverged.remote)
    commit(divergedPeer, 'remote')
    git(divergedPeer, 'push', 'origin', 'main')
    commit(diverged.local, 'local')
    git(diverged.local, 'fetch', 'origin', 'main')
    expect(repoRelation(diverged.local).relation).toBe('DIVERGED')

    const unavailable = fixture()
    git(unavailable.local, 'update-ref', '-d', 'refs/remotes/origin/main')
    expect(repoRelation(unavailable.local).relation).toBe('ORIGIN_UNAVAILABLE')
  })

  it('keeps generated graph and bundled runtime state ignored and untracked', () => {
    const ignored = spawnSync('git', ['check-ignore', '.codegraph/index.db', '.tools/codegraph/current/bin/codegraph'], { encoding: 'utf8' })
    expect(ignored.status).toBe(0)
    expect(ignored.stdout).toContain('.codegraph/index.db')
    expect(spawnSync('git', ['ls-files', '.codegraph', '.tools/codegraph'], { encoding: 'utf8' }).stdout.trim()).toBe('')
  })

  it('registers both adapter capabilities as read-only and authority-free', async () => {
    expect(repoEyesStatusTool.danger).toBe('readonly')
    expect(repoCodeExploreTool.danger).toBe('readonly')
    const result = exploreRepoCode(process.cwd(), 'swap execution call path', { command: 'fake-codegraph', deps: fakeDeps() })
    expect(result).toEqual({ ok: true, text: 'read-only graph result' })
  })

  it('keeps repo path and executable selection code-owned', () => {
    expect(repoEyesStatusTool.input.safeParse({ repoRoot: '/tmp/other' }).success).toBe(false)
    expect(repoCodeExploreTool.input.safeParse({ query: 'calls to swap', command: '/tmp/other' }).success).toBe(false)
  })

  it('grants repo eyes only to orchestrator and researcher, never executor', () => {
    const loaded = loadAgents(path.resolve('agents'))
    expect(loaded.failed).toEqual([])
    const registry = createToolRegistry(false)
    for (const name of ['repo_eyes_status', 'repo_code_explore']) {
      expect(registry.get(name)?.danger).toBe('readonly')
      expect(registry.forAgent(loaded.agents.get('orchestrator')!).map((tool) => tool.name)).toContain(name)
      expect(registry.forAgent(loaded.agents.get('researcher')!).map((tool) => tool.name)).toContain(name)
      expect(registry.forAgent(loaded.agents.get('executor')!).map((tool) => tool.name)).not.toContain(name)
    }
  })

  it('leaves trading tools registered when CodeGraph is unavailable', () => {
    const registry = createToolRegistry(false)
    expect(registry.get('swap_execute')?.danger).toBe('trade')
    expect(registry.get('repo_eyes_status')?.danger).toBe('readonly')
  })

  it('keeps fresh-install CodeGraph failure fail-soft and out of runtime configuration', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    const bootstrap = fs.readFileSync('scripts/codegraph.ts', 'utf8')
    expect(pkg.scripts['codegraph:bootstrap']).toBe('tsx scripts/codegraph.ts bootstrap')
    expect(pkg.scripts['start']).not.toMatch(/codegraph/i)
    expect(pkg.scripts['dev']).not.toMatch(/codegraph/i)
    expect(bootstrap).not.toMatch(/wallet|signer|approval|DRY_RUN|LIVE/)
    expect(bootstrap).not.toMatch(/["']\.env["']/)
  })

  it('cannot project repository observations into approval or execution authority', () => {
    expect(repoEyesStatusTool.approvalRequest).toBeUndefined()
    expect(repoCodeExploreTool.approvalRequest).toBeUndefined()
    expect(repoEyesStatusTool.danger).not.toBe('trade')
    expect(repoCodeExploreTool.danger).not.toBe('write')
  })
})

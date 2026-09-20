import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export type RepoRelation = 'EXACT' | 'LOCAL_BEHIND_ORIGIN' | 'LOCAL_AHEAD_OF_ORIGIN' | 'DIVERGED' | 'ORIGIN_UNAVAILABLE'
export type CodegraphState = 'READY' | 'UNAVAILABLE' | 'UNINITIALIZED' | 'ERROR'

export type RepoEyesStatus = {
  repoRoot: string
  repoHead: string
  repoTree: string
  originMain?: string
  relation: RepoRelation
  expectedCodegraphVersion: string
  observedCodegraphVersion?: string
  graphState: CodegraphState
  graphLastIndexed?: string
  graphForHead: null
  detail?: string
  authorityGranted: false
}

export type CommandResult = { status: number | null; stdout: string; stderr: string }
export type RepoEyesDeps = {
  exists: (target: string) => boolean
  run: (command: string, args: string[], cwd: string) => CommandResult
}

type CodegraphLock = { version: string }

/** Scrubbed, process-local environment for every Frog-to-Toad CodeGraph child.
 * Locality controls are code-owned and deliberately override ambient values. */
export function codegraphChildEnv(ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: ambient['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: ambient['HOME'],
    LANG: ambient['LANG'] ?? 'C.UTF-8',
    TMPDIR: ambient['TMPDIR'] ?? '/tmp',
    DO_NOT_TRACK: '1',
    CODEGRAPH_TELEMETRY: '0',
    CODEGRAPH_NO_UPDATE_CHECK: '1',
  }
}

export function runRepoEyesChild(
  command: string,
  args: string[],
  cwd: string,
  stdio: 'pipe' | 'inherit' = 'pipe',
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: codegraphChildEnv(),
    stdio,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' }
}

const defaultDeps: RepoEyesDeps = {
  exists: fs.existsSync,
  run: runRepoEyesChild,
}

export function readCodegraphVersionPin(repoRoot: string): string {
  const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'codegraph.lock.json'), 'utf8')) as CodegraphLock
  if (!/^\d+\.\d+\.\d+$/.test(parsed.version)) throw new Error('invalid CodeGraph version pin')
  return parsed.version
}

export function resolveCodegraphCommand(repoRoot: string, exists: (target: string) => boolean = fs.existsSync): string {
  const local = path.join(repoRoot, '.tools', 'codegraph', 'current', 'bin', 'codegraph')
  return exists(local) ? local : 'codegraph'
}

export function verifyCodegraphVersion(
  command: string,
  expected: string,
  repoRoot: string,
  deps: RepoEyesDeps = defaultDeps,
): { ok: boolean; observed?: string; detail?: string } {
  const result = deps.run(command, ['--version'], repoRoot)
  if (result.status !== 0) return { ok: false, detail: result.stderr.trim() || 'CodeGraph executable unavailable' }
  const observed = result.stdout.trim().replace(/^v/, '')
  if (observed !== expected) return { ok: false, observed, detail: `expected CodeGraph ${expected}, observed ${observed || 'unknown'}` }
  return { ok: true, observed }
}

function git(repoRoot: string, args: string[], deps: RepoEyesDeps): string | undefined {
  const result = deps.run('git', args, repoRoot)
  return result.status === 0 ? result.stdout.trim() : undefined
}

export function repoRelation(repoRoot: string, deps: RepoEyesDeps = defaultDeps): {
  repoHead: string
  repoTree: string
  originMain?: string
  relation: RepoRelation
} {
  const repoHead = git(repoRoot, ['rev-parse', 'HEAD'], deps)
  const repoTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}'], deps)
  if (!repoHead || !repoTree) throw new Error('repo-eyes requires a valid Git checkout')
  const originMain = git(repoRoot, ['rev-parse', '--verify', 'refs/remotes/origin/main'], deps)
  if (!originMain) return { repoHead, repoTree, relation: 'ORIGIN_UNAVAILABLE' }
  if (repoHead === originMain) return { repoHead, repoTree, originMain, relation: 'EXACT' }
  if (deps.run('git', ['merge-base', '--is-ancestor', repoHead, originMain], repoRoot).status === 0) {
    return { repoHead, repoTree, originMain, relation: 'LOCAL_BEHIND_ORIGIN' }
  }
  const localAhead = deps.run('git', ['merge-base', '--is-ancestor', originMain, repoHead], repoRoot).status === 0
  return { repoHead, repoTree, originMain, relation: localAhead ? 'LOCAL_AHEAD_OF_ORIGIN' : 'DIVERGED' }
}

export function inspectRepoEyes(
  repoRoot: string,
  options: { command?: string; deps?: RepoEyesDeps } = {},
): RepoEyesStatus {
  const root = path.resolve(repoRoot)
  const deps = options.deps ?? defaultDeps
  const expectedCodegraphVersion = readCodegraphVersionPin(root)
  const relation = repoRelation(root, deps)
  const command = options.command ?? resolveCodegraphCommand(root, deps.exists)
  const version = verifyCodegraphVersion(command, expectedCodegraphVersion, root, deps)
  const base = { repoRoot: root, ...relation, expectedCodegraphVersion, graphForHead: null, authorityGranted: false as const }
  if (!version.ok) {
    return {
      ...base,
      ...(version.observed ? { observedCodegraphVersion: version.observed } : {}),
      graphState: version.observed === undefined ? 'UNAVAILABLE' : 'ERROR',
      detail: version.detail,
    }
  }
  if (!deps.exists(path.join(root, '.codegraph'))) {
    return { ...base, observedCodegraphVersion: version.observed, graphState: 'UNINITIALIZED' }
  }
  const status = deps.run(command, ['status', '--json', root], root)
  if (status.status !== 0) {
    return { ...base, observedCodegraphVersion: version.observed, graphState: 'ERROR', detail: status.stderr.trim() || 'CodeGraph status failed' }
  }
  try {
    const parsed = JSON.parse(status.stdout) as { initialized?: unknown; lastIndexed?: unknown }
    if (parsed.initialized !== true) {
      return { ...base, observedCodegraphVersion: version.observed, graphState: 'UNINITIALIZED' }
    }
    return {
      ...base,
      observedCodegraphVersion: version.observed,
      graphState: 'READY',
      ...(typeof parsed.lastIndexed === 'string' ? { graphLastIndexed: parsed.lastIndexed } : {}),
    }
  } catch {
    return { ...base, observedCodegraphVersion: version.observed, graphState: 'ERROR', detail: 'CodeGraph status returned malformed JSON' }
  }
}

export function exploreRepoCode(
  repoRoot: string,
  query: string,
  options: { command?: string; deps?: RepoEyesDeps } = {},
): { ok: true; text: string } | { ok: false; text: string } {
  const root = path.resolve(repoRoot)
  const deps = options.deps ?? defaultDeps
  const status = inspectRepoEyes(root, { command: options.command, deps })
  if (status.graphState !== 'READY') {
    return { ok: false, text: `CodeGraph repo eyes ${status.graphState}: ${status.detail ?? 'run the pinned bootstrap/init command'}` }
  }
  const command = options.command ?? resolveCodegraphCommand(root, deps.exists)
  const result = deps.run(command, ['explore', '--path', root, query], root)
  if (result.status !== 0) return { ok: false, text: `CodeGraph explore failed: ${result.stderr.trim() || 'unknown local error'}` }
  return { ok: true, text: result.stdout.trim() }
}

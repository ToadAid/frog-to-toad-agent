import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from './registry.js'
import type { Config } from '../config.js'
import { handsGateOpen } from '../doctor/doctor.js'
import { appendJsonl } from '../store/jsonl.js'
import { sandboxRoot } from './workspace.js'
import { log } from '../log.js'

/**
 * Safe exec (Phase 12.3) — the frog can RUN commands, but only the ones the
 * principal named. Deny-default `COMMAND_ALLOWLIST` (same shape/spirit as
 * MCP_ALLOWED_TOOLS): an empty list refuses everything. The spawn is NOT a
 * shell (executable + args split — the MCP_COMMAND lesson), cwd is jailed to
 * the sandbox, the child env is scrubbed to a minimal safe set (no secrets
 * pass through), output is tailed not firehosed, and every invocation is
 * journaled with its exit code.
 */

export const OUTPUT_TAIL_BYTES = 8000
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000

/** Env vars the child is allowed to see — everything else is scrubbed. */
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TERM', 'NODE_ENV'] as const

export function commandAllowlist(cfgLike?: { COMMAND_ALLOWLIST?: string }): string[] {
  const raw = cfgLike?.COMMAND_ALLOWLIST ?? process.env.COMMAND_ALLOWLIST ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * Match an invoked command against the deny-default allowlist. An entry
 * matches when the command equals it or extends it word-boundary style:
 *   entry `npm test`   matches `npm test` but not `npm testxyz`
 *   entry `node scripts/` matches `node scripts/foo.ts`
 */
export function isAllowed(command: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (command === entry || command.startsWith(entry + ' ') || (entry.endsWith('/') && command.startsWith(entry))) {
      return true
    }
  }
  return false
}

/**
 * Tokenize a command string into executable + args (no shell, ever). Quote-aware:
 * `node -e "console.log(1)"` → ['node', '-e', 'console.log(1)']. No expansion of
 * $vars or backticks — quotes are grouping only, so there is nothing to inject.
 */
export function splitCommand(command: string): { executable: string; args: string[] } | undefined {
  const parts: string[] = []
  let cur = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started || cur !== '') parts.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (quote) return undefined // unterminated quote — refuse rather than guess
  if (started || cur !== '') parts.push(cur)
  if (parts.length === 0) return undefined
  return { executable: parts[0]!, args: parts.slice(1) }
}

export function scrubEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) out[key] = process.env[key]
  }
  return out
}


export type SandboxRuntimeProbe = {
  ok: boolean
  detail: string
}

/**
 * Prove that the host can provide the SAME hard namespace boundary exec_run
 * requires. Merely finding /usr/bin/bwrap is not enough: some containerized
 * CI hosts install Bubblewrap but forbid the required namespace operations.
 *
 * Failure is a capability result, never permission to fall back unsandboxed.
 */
export function probeSandboxRuntime(): SandboxRuntimeProbe {
  const bwrap = '/usr/bin/bwrap'
  if (!fs.existsSync(bwrap)) {
    return { ok: false, detail: 'sandbox runtime /usr/bin/bwrap is unavailable' }
  }

  const result = spawnSync(
    bwrap,
    [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--',
      '/bin/true',
    ],
    {
      env: scrubEnv(),
      encoding: 'utf8',
      timeout: 5_000,
    },
  )

  if (result.error) {
    return { ok: false, detail: `sandbox runtime probe failed: ${result.error.message}` }
  }
  if (result.status !== 0) {
    const observed = (result.stderr || result.stdout || `exit ${String(result.status)}`).trim()
    return { ok: false, detail: `sandbox runtime probe refused: ${observed}` }
  }
  return { ok: true, detail: 'sandbox runtime available' }
}

function runChild(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const bwrap = '/usr/bin/bwrap'
    const sandbox = probeSandboxRuntime()
    if (!sandbox.ok) {
      resolve({
        code: -1,
        stdout: '',
        stderr: `${sandbox.detail}; refusing to execute`,
        timedOut: false,
      })
      return
    }
    const repo = path.join(cwd, 'repo')
    const sandboxArgs = [
      '--die-with-parent', '--new-session', '--unshare-all',
      '--ro-bind', '/', '/',
      '--tmpfs', '/home',
      '--proc', '/proc', '--dev', '/dev',
      '--bind', cwd, '/tmp',
      ...(fs.existsSync(repo) ? ['--ro-bind', repo, '/tmp/repo'] : []),
      '--chdir', '/tmp',
      '--setenv', 'HOME', '/tmp',
      '--', executable, ...args,
    ]
    const child = spawn(bwrap, sandboxArgs, { cwd, env: scrubEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const onAbort = () => {
      timedOut = false
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => {
      stdout = (stdout + String(d)).slice(-16_000)
    })
    child.stderr.on('data', (d) => {
      stderr = (stderr + String(d)).slice(-16_000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      stderr += `spawn error: ${e.message}`
      resolve({ code: -1, stdout, stderr, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

export const execRunTool = defineTool({
  name: 'exec_run',
  description:
    'Run an ALLOWLISTED command inside your sandbox workspace (data/sandbox/). Deny-default: only commands the ' +
    'principal named in COMMAND_ALLOWLIST may run (e.g. "npm test", "npm run check"). No shell — the command is ' +
    'split into executable + args. Output is capped. Every run is journaled with its exit code.',
  danger: 'write',
  input: z.object({
    command: z.string().describe('the full command line, e.g. "npm test" or "node scripts/analyze.ts"'),
    timeoutSec: z.number().int().positive().max(600).optional().describe('hard timeout (default 120s, max 600s)'),
  }),
  execute: async (input, ctx) => {
    if (!handsGateOpen(ctx.cfg)) {
      return { text: '[error] hands are gated: doctor is unhealthy or has never run a full check (npm run doctor). Exec is refused.' }
    }
    const allowlist = commandAllowlist()
    if (allowlist.length === 0) {
      return { text: '[error] COMMAND_ALLOWLIST is not configured — the principal has not named any commands. Deny-default: refusing.' }
    }
    if (!isAllowed(input.command, allowlist)) {
      log.warn(`exec refused (not allowlisted): ${input.command}`)
      journalOp(ctx, input.command, -1, 'refused')
      return {
        text:
          `[error] '${input.command}' is not on COMMAND_ALLOWLIST — deny-default.\n` +
          `Allowlisted commands: ${allowlist.join(' · ')}`,
      }
    }
    const parts = splitCommand(input.command)
    if (!parts) return { text: '[error] empty command' }
    // Defense in depth: even an allowlisted absolute path pointing outside the
    // sandbox can't be tricked into running as a shell — spawn takes argv directly.
    const timeoutMs = (input.timeoutSec ?? DEFAULT_EXEC_TIMEOUT_MS / 1000) * 1000
    const cwd = sandboxRoot(ctx.cfg)
    fs.mkdirSync(cwd, { recursive: true }) // spawn ENOENTs on a missing cwd — self-heal
    const result = await runChild(parts.executable, parts.args, cwd, timeoutMs, ctx.signal)
    const exit = result.timedOut ? 'timeout' : String(result.code)
    journalOp(ctx, input.command, result.timedOut ? -1 : result.code, result.timedOut ? 'timeout' : 'ran')
    const tail = (s: string, label: string) => {
      const text = s.trim()
      if (text === '') return []
      const capped = text.length > 8000 ? `[… ${label} truncated, last 8000 chars]\n` + text.slice(-8000) : text
      return [`${label}:`, capped]
    }
    return {
      text:
        `⚙️ ${input.command}\nexit: ${exit}\n` +
        [...tail(result.stdout, 'stdout'), ...tail(result.stderr, 'stderr')].join('\n'),
    }
  },
})

function journalOp(ctx: { cfg: Config; agent: { name: string } }, command: string, exitCode: number, status: string): void {
  try {
    appendJsonl(path.join(sandboxRoot(ctx.cfg), '.exec.jsonl'), {
      ts: Date.now(),
      command,
      exitCode,
      status,
      agent: ctx.agent.name,
    })
  } catch (e) {
    log.warn(`exec journal failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

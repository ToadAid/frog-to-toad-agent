import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import type { ExecResult, OnboardIo } from './types.js'

/**
 * The real IO layer for the onboarding wizard. `askHidden` reads a secret
 * with raw-mode char capture (bullet per char, never echoed) and FAILS LOUD
 * on a non-TTY stdin — secrets are never accepted from a pipe.
 */

const SECRETS_NEED_A_TTY =
  'secrets must be typed in a real terminal (TTY) — rerun `npm run onboard`; never pipe them'

type HiddenDeps = {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (m: boolean) => unknown }
  stdout?: NodeJS.WritableStream
}

/** Raw-mode hidden reader: Enter submits, Backspace erases, Ctrl-C aborts
 * (rejects with 'cancelled' — the wizard turns that into its abort path;
 * raw mode is restored in `finally` so a mid-read death never leaves the
 * terminal cooked). Only `•` bullets reach stdout, never the typed chars. */
export async function askHidden(query: string, deps: HiddenDeps = {}): Promise<string> {
  const stdin = (deps.stdin ?? process.stdin) as NonNullable<HiddenDeps['stdin']>
  const stdout = deps.stdout ?? process.stdout
  if (stdin.isTTY !== true) throw new Error(SECRETS_NEED_A_TTY)

  stdout.write(`${query}`)
  let value = ''
  stdin.setRawMode?.(true)
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (ch: Buffer) => {
        const c = ch.toString('utf8')
        if (c === '\r' || c === '\n') { // Enter
          stdin.removeListener('data', onData)
          stdout.write('\n')
          resolve()
        } else if (c === '\x7f') { // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
        } else if (c === '\x03') { // Ctrl-C
          stdin.removeListener('data', onData)
          stdout.write('\n')
          reject(new Error('cancelled'))
        } else {
          value += c
          stdout.write('•')
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode?.(false)
  }
  return value
}

/** The real wiring — every field overridable for tests. */
export function createOnboardIo(overrides: Partial<OnboardIo> = {}): OnboardIo {
  const repoDir = process.cwd()
  const execImpl = async (cmd: string, args: string[], timeoutMs = 30_000): Promise<ExecResult> =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({
          status: err === null ? 0 : (err as NodeJS.ErrnoException & { code?: number }).code ?? 1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
    })
  const io: OnboardIo = {
    repoDir,
    envPath: path.join(repoDir, '.env'),
    homeDir: os.homedir(),
    unitPath: path.join(os.homedir(), '.config', 'systemd', 'user', 'frog-to-toad-agent.service'),
    unitTemplatePath: path.join(repoDir, 'deploy', 'frog-to-toad-agent.service'),
    logFile: '/tmp/frog-to-toad-agent.log',
    isTty: process.stdin.isTTY === true,
    platform: process.platform,
    fetchImpl: fetch,
    exec: execImpl,
    readLogTail: (n) => {
      try {
        return fs.readFileSync('/tmp/frog-to-toad-agent.log', 'utf8').trimEnd().split('\n').slice(-n).join('\n')
      } catch {
        return ''
      }
    },
    print: (s) => console.log(s),
    ask: async (q) => {
      const iface = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await iface.question(q)
      } finally {
        iface.close()
      }
    },
    askHidden,
    confirm: async (q, dflt = false) => {
      const iface = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = await iface.question(`${q} [${dflt ? 'Y/n' : 'y/N'}] `)
        if (answer.trim() === '') return dflt
        return /^(y|yes)$/i.test(answer.trim())
      } finally {
        iface.close()
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    runCodexLogin: async () => {
      const { runCodexLogin } = await import('../llm/codexLogin.js')
      return runCodexLogin()
    },
    ...overrides,
  }
  return io
}

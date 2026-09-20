/**
 * Desk lifecycle CLI — the systemd era's front door.
 *
 *   npm run desk status | start | stop | restart | logs [n] | follow | login
 *
 * Wraps the `frog-to-toad-agent` systemd --user unit (see
 * ~/.config/systemd/user/frog-to-toad-agent.service) so operators have one
 * replacement. Nothing here is a second source of truth — every command
 * delegates to systemctl, which owns the process, the restart policy and
 * boot ordering. `login` is the one non-systemd command: it forges the Codex
 * brain's ChatGPT OAuth keyfile (§12.6) — safe to run while the desk lives.
 */
import { spawnSync } from 'node:child_process'

const UNIT = 'frog-to-toad-agent.service'
const LOG_FILE = '/tmp/frog-to-toad-agent.log'

const USAGE = `desk — control Frog-to-Toad Agent (systemd --user unit "${UNIT}")

  npm run desk status     is the frog alive? (plus last log lines)
  npm run desk start      boot the desk
  npm run desk stop       stop it (clean SIGTERM)
  npm run desk restart    pick up code/config changes
  npm run desk logs [n]   last n lines (default 50) of the desk log
  npm run desk follow     tail -f the desk log (Ctrl-C to exit)
  npm run desk login      brain setup menu — Codex (ChatGPT web-login → OAuth
                          keyfile, safe while the desk runs), Z.ai / OpenAI
                          (API-key lanes), or Ollama (local probe). Non-TTY
                          runs the Codex login directly.
  npm run desk onboard    first-run wizard (§12.7): fresh box → talking frog —
                          token + chat id (masked input), brain menu, .env,
                          systemd unit, boot, doctor, handshake. Resume-safe.`

function systemctl(...args: string[]): number {
  const r = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' })
  if (r.error !== undefined) {
    console.error(`[desk] systemctl failed: ${r.error.message}`)
    return 1
  }
  return r.status ?? 1
}

function isRunning(): boolean {
  const r = spawnSync('systemctl', ['--user', 'is-active', '--quiet', UNIT])
  return r.status === 0
}

function status(): number {
  const code = systemctl('status', UNIT, '--no-pager', '-l')
  if (!isRunning()) return code
  console.log(`\n── last log lines (${LOG_FILE}) ──`)
  return tail(5)
}

function tail(n: number): number {
  const r = spawnSync('tail', ['-n', String(n), LOG_FILE], { stdio: 'inherit' })
  return r.status ?? 1
}

function main(): number {
  const [cmd, arg] = process.argv.slice(2)
  switch (cmd) {
    case 'status':
      return status()
    case 'start':
      return systemctl('start', UNIT)
    case 'stop':
      return systemctl('stop', UNIT)
    case 'restart':
      return systemctl('restart', UNIT)
    case 'logs': {
      const n = Number(arg ?? 50)
      return Number.isInteger(n) && n > 0 ? tail(n) : (console.error('[desk] logs takes a positive line count'), 1)
    }
    case 'follow': {
      const r = spawnSync('tail', ['-n', '20', '-f', LOG_FILE], { stdio: 'inherit' })
      return r.status ?? 1
    }
    default:
      console.log(USAGE)
      return cmd === undefined || cmd === 'help' ? 0 : 1
  }
}

// `login` and `onboard` are the async commands (loopback OAuth server +
// network + interactive menu); the systemctl paths stay sync and delegate.
async function mainAsync(): Promise<number> {
  const [cmd] = process.argv.slice(2)
  if (cmd !== 'login' && cmd !== 'onboard') return main()
  try {
    if (cmd === 'onboard') {
      // TTY gate FIRST — the wizard collects secrets and asks questions; a
      // piped/EOF run must fail loud before any step runs, never limp on
      // empty answers (askHidden also fails loud, but only when reached).
      if (process.stdin.isTTY !== true) {
        console.error('[desk] onboard needs an interactive terminal (it asks questions and reads secrets).')
        console.error('       Run it directly:  npm run onboard')
        return 1
      }
      const { createOnboardIo } = await import('../src/onboard/prompt.js')
      const { runOnboarding } = await import('../src/onboard/wizard.js')
      const io = createOnboardIo()
      return await runOnboarding(io)
    }

    const path = await import('node:path')
    const { runBrainSetupMenu } = await import('../src/llm/brainSetup.js')
    const { runCodexLogin } = await import('../src/llm/codexLogin.js')
    const rl = await import('node:readline/promises')

    // Deliberately NO loadConfig() here — setup must work on a fresh box with
    // no .env yet (onboarding order: brain setup can come before first boot).
    const envPath = path.join(process.cwd(), '.env')
    const iface = rl.createInterface({ input: process.stdin, output: process.stdout })
    try {
      if (process.stdin.isTTY !== true) {
        // scripted/non-TTY keeps the original plain codex login flow
        const keyfile = await runCodexLogin()
        console.log(`[desk] codex brain forged: ${keyfile} (chmod 600, gitignored — never chat it)`)
        console.log('[desk] set BRAIN=codex in .env and `npm run desk restart` to switch.')
        return 0
      }
      await runBrainSetupMenu({
        envPath,
        runCodexLogin,
        print: (s) => console.log(s),
        ask: (q) => iface.question(q),
        confirm: async (q, dflt = false) => {
          const answer = await iface.question(`${q} [${dflt ? 'Y/n' : 'y/N'}] `)
          if (answer.trim() === '') return dflt
          return /^(y|yes)$/i.test(answer.trim())
        },
      })
      return 0
    } finally {
      iface.close()
    }
  } catch (e) {
    console.error(`[desk] ${process.argv[2] ?? 'login'} failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

process.exit(await mainAsync())

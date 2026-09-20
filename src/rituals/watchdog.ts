import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { log } from '../log.js'
import { codexTokenStatus } from '../llm/codexAuth.js'

/**
 * Watchdog (NautilusTrader live-node steal, desk-sized): the desk can go
 * silent in ways nobody notices — brain endpoint dead, scheduler hung, cron
 * quietly not firing. The sentinel watches the MARKET; this watches the DESK.
 * Speaks only when something is actually wrong, to the admin chat.
 */

/** No ritual firing for this long = the scheduler is probably dead (sentinel alone runs every 2h). */
export const STALE_CRON_MS = 6 * 60 * 60 * 1000
/** Brain health probe timeout. */
export const BRAIN_PROBE_TIMEOUT_MS = 8_000

/** Wall-clock boot time — staleness is measured from the later of boot or last heartbeat. */
const BOOTED_AT = Date.now()

type WatchdogState = { lastCronFired?: number }

function stateFile(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'state', 'watchdog.json')
}

/** Persisted across restarts — a dead scheduler stays dead after a reboot too. */
export function readWatchdogState(cfg: Config): WatchdogState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(cfg), 'utf8')) as WatchdogState
  } catch {
    return {}
  }
}

export function noteCronFired(cfg: Config, at: number = Date.now()): void {
  try {
    const file = stateFile(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ lastCronFired: at } satisfies WatchdogState), 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    log.warn(`watchdog: failed to persist cron heartbeat: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export type WatchdogDeps = {
  now?: () => number
  /** Wall-clock process start (staleness grace floor). Tests inject a past boot. */
  bootedAt?: () => number
  /** Probe the brain's OpenAI-compatible endpoint. Default: GET {baseUrl}/models. */
  brainHealthy?: () => Promise<boolean>
  /** Alert sink (defaults to log.warn). */
  emit?: (alert: string) => void
}

export type WatchdogFinding = {
  check: 'brain' | 'cron_staleness'
  alert: string
}

export async function runWatchdog(cfg: Config, deps: WatchdogDeps = {}): Promise<WatchdogFinding[]> {
  const now = deps.now ?? Date.now
  const emit = deps.emit ?? ((alert: string) => log.warn(`[watchdog] ${alert}`))
  const brainHealthy =
    deps.brainHealthy ??
    (async () => {
      // codex lane: health is the LOCAL keyfile (no /models endpoint to probe —
      // the ChatGPT backend would 404 it). An expired-but-refreshable keyfile
      // is still healthy; the client refreshes silently at request time.
      if (cfg.brain === 'codex') {
        const status = codexTokenStatus()
        return status.valid
      }
      try {
        const res = await fetch(`${cfg.llm.baseUrl}/models`, {
          signal: AbortSignal.timeout(BRAIN_PROBE_TIMEOUT_MS),
        })
        return res.ok
      } catch {
        return false
      }
    })

  const findings: WatchdogFinding[] = []

  // 1. Brain reachability — an LLM outage means every run fails at turn one.
  if (!(await brainHealthy())) {
    findings.push({
      check: 'brain',
      alert: cfg.brain === 'codex'
        ? `🧠 WATCHDOG: codex brain keyfile missing or dead (${cfg.llm.model}) — run: npm run desk login.`
        : `🧠 WATCHDOG: brain unreachable at ${cfg.llm.baseUrl} (${cfg.llm.model}) — runs will fail until it answers.`,
    })
  }

  // 2. Ritual staleness — sentinel fires every 2h when healthy; a longer
  // silence (measured from the later of boot or last heartbeat, so a fresh
  // boot never alerts) means the scheduler itself is dead.
  const state = readWatchdogState(cfg)
  const lastBeat = Math.max(state.lastCronFired ?? 0, deps.bootedAt?.() ?? BOOTED_AT)
  const silentMs = now() - lastBeat
  if (silentMs > STALE_CRON_MS) {
    findings.push({
      check: 'cron_staleness',
      alert: `⏰ WATCHDOG: no scheduled ritual has fired in ${Math.round(silentMs / 3_600_000)}h — the scheduler may be dead or the clock jumped. Runs still answer chat, but the desk's eyes are closed.`,
    })
  }

  for (const f of findings) emit(f.alert)
  return findings
}
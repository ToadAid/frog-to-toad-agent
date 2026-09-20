import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Config } from '../config.js'
import { readLedger } from '../store/positions.js'
import { loadDeskState } from '../safety/deskState.js'
import { codexTokenStatus } from '../llm/codexAuth.js'

/**
 * `desk doctor` (Phase 12.0) — the stage-0 pre-flight gate that BLOCKS ALL
 * HANDS. Same pattern as Claude Code's permission gates: the gate ships
 * BEFORE the capability. Workspace/exec/browser tools only exist when the
 * doctor says the box is healthy — and they re-check at execute time
 * (defense in depth), so a stale or failed doctor closes the hands even
 * mid-run.
 *
 * Two modes:
 *  - cheap (boot): dirs writable, disk free, env sanity, state files parse,
 *    brain reachable, hands-gate state. Fast, no subprocesses.
 *  - full (`npm run doctor`): + tsc clean + test suite green. Only the full
 *    run opens the hands gate (`lastTestGreenAt`), and it goes stale after 7
 *    days — fail-closed.
 */

export type DoctorStage = { name: string; ok: boolean; detail: string }

export type DoctorReport = {
  ok: boolean
  stages: DoctorStage[]
  /** Set by the full run only. */
  full?: { tscOk: boolean; testsOk: boolean; ts: number }
}

export const TEST_GREEN_MAX_AGE_MS = 7 * 86_400_000
const DISK_MIN_BYTES = 500 * 1024 * 1024
const BRAIN_PROBE_TIMEOUT_MS = 8000

export function doctorStatePath(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'state', 'doctor.json')
}

/** The hands gate: workspace/exec/browser exist only when this returns true. */
export type HandsGateState = {
  lastRunTs?: number
  cheapOk?: boolean
  lastTestGreenAt?: number
  full?: { tscOk: boolean; testsOk: boolean; ts: number }
}

export function readDoctorState(cfg: Config): HandsGateState | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(doctorStatePath(cfg), 'utf8')) as HandsGateState
    return raw && typeof raw === 'object' ? raw : undefined
  } catch {
    return undefined
  }
}

function writeDoctorState(cfg: Config, state: HandsGateState): void {
  const file = doctorStatePath(cfg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

/** Fail-closed: no state, stale test-green, or a failed cheap stage → hands CLOSED. */
export function handsGateOpen(cfg: Config, now = Date.now()): boolean {
  const state = readDoctorState(cfg)
  if (!state || state.cheapOk !== true || state.lastTestGreenAt === undefined) return false
  if (now - state.lastTestGreenAt > TEST_GREEN_MAX_AGE_MS) return false
  return true
}

// ── Stages ───────────────────────────────────────────────────────────────────

function stageDirs(cfg: Config): DoctorStage {
  try {
    fs.mkdirSync(path.join(cfg.paths.dataDir, 'sandbox'), { recursive: true })
    fs.accessSync(cfg.paths.dataDir, fs.constants.W_OK)
    const probe = path.join(cfg.paths.dataDir, 'sandbox', `.doctor-probe-${process.pid}`)
    fs.writeFileSync(probe, 'probe')
    fs.unlinkSync(probe)
    return { name: 'dirs', ok: true, detail: 'data + sandbox writable' }
  } catch (e) {
    return { name: 'dirs', ok: false, detail: `data/sandbox not writable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function stageDisk(cfg: Config): DoctorStage {
  try {
    const s = fs.statfsSync(cfg.paths.dataDir)
    const free = Number(s.bsize) * Number(s.bavail)
    return free >= DISK_MIN_BYTES
      ? { name: 'disk', ok: true, detail: `${Math.floor(free / 1024 ** 3)} GiB free` }
      : { name: 'disk', ok: false, detail: `only ${Math.floor(free / 1024 ** 2)} MiB free (< 500 MiB)` }
  } catch (e) {
    return { name: 'disk', ok: false, detail: `statfs failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function stageState(cfg: Config): DoctorStage {
  try {
    // Both readers throw on corruption; missing files are fine (fresh install).
    const desk = loadDeskState(cfg)
    readLedger(cfg)
    return { name: 'state', ok: true, detail: `desk state ${desk.state}, ledger parses` }
  } catch (e) {
    return { name: 'state', ok: false, detail: `state corrupt: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Secrets hygiene: wallet keys live in the external wallet server ONLY. A CDP private
 * key or wallet secret in the DESK .env is a burned-credential incident
 * waiting to happen — the desk .env legitimately holds Telegram/LLM tokens,
 * so only wallet-lane secret shapes are checked.
 */
function stageEnvSanity(cfg: Config): DoctorStage {
  try {
    const envFile = path.join(deskRootOf(cfg), '.env')
    const text = fs.readFileSync(envFile, 'utf8')
    const suspicious: string[] = []
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(\S+)\s*$/.exec(line)
      if (!m) continue
      const key = m[1]!
      // LLM/Telegram keys are allowed in the desk .env; wallet-lane secrets are not.
      if (!/CDP_|PRIVATE_KEY|WALLET_SECRET|MNEMONIC|SEED_/i.test(key)) continue
      suspicious.push(key)
    }
    if (suspicious.length > 0) {
      return {
        name: 'env',
        ok: false,
        detail: `wallet-lane secret(s) in agent .env: ${suspicious.join(', ')} — move to the external wallet server and rotate`,
      }
    }
    return { name: 'env', ok: true, detail: 'no wallet secrets in desk .env' }
  } catch {
    return { name: 'env', ok: true, detail: 'no desk .env present (nothing to leak)' }
  }
}

async function stageBrain(cfg: Config): Promise<DoctorStage> {
  // codex lane (§12.6): health is the LOCAL keyfile — the ChatGPT backend has
  // no /models to probe, and the access token refreshes itself at request
  // time. Missing/dead keyfile fails the stage with the fix in the detail.
  if (cfg.brain === 'codex') {
    const status = codexTokenStatus()
    return status.present && status.hint === undefined
      ? { name: 'brain', ok: true, detail: `codex keyfile present (${cfg.llm.model})` }
      : { name: 'brain', ok: false, detail: `codex brain: ${status.hint ?? 'unreadable keyfile'}` }
  }
  try {
    const res = await fetch(cfg.llm.baseUrl + '/models', { signal: AbortSignal.timeout(BRAIN_PROBE_TIMEOUT_MS) })
    return res.ok
      ? { name: 'brain', ok: true, detail: `${cfg.llm.model} reachable` }
      : { name: 'brain', ok: false, detail: `HTTP ${res.status} from ${cfg.llm.baseUrl}/models` }
  } catch (e) {
    return { name: 'brain', ok: false, detail: `brain unreachable at ${cfg.llm.baseUrl}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function stageHandsGate(cfg: Config): DoctorStage {
  const state = readDoctorState(cfg)
  if (state?.lastTestGreenAt === undefined) {
    return { name: 'hands-gate', ok: false, detail: 'never ran a full doctor — run: npm run doctor' }
  }
  const ageMs = Date.now() - state.lastTestGreenAt
  if (ageMs > TEST_GREEN_MAX_AGE_MS) {
    return { name: 'hands-gate', ok: false, detail: `last green test run is stale (${Math.floor(ageMs / 86_400_000)}d old) — re-run: npm run doctor` }
  }
  return { name: 'hands-gate', ok: true, detail: `test suite green ${Math.floor(ageMs / 86_400_000)}d ago` }
}

/** Run the cheap stages (no subprocesses — safe at every boot). */
export async function runDoctor(cfg: Config): Promise<DoctorReport> {
  const stages: DoctorStage[] = [
    stageDirs(cfg),
    stageDisk(cfg),
    stageState(cfg),
    stageEnvSanity(cfg),
    await stageBrain(cfg),
    stageHandsGate(cfg),
  ]
  const ok = stages.every((s) => s.ok)
  // Persist so the dashboard/brief and the tools' execute-time re-check see it.
  const prev = readDoctorState(cfg) ?? {}
  writeDoctorState(cfg, { ...prev, lastRunTs: Date.now(), cheapOk: ok })
  return { ok, stages }
}

// ── Full run (CLI only) ──────────────────────────────────────────────────────

function runCapture(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, output: out })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output: out.slice(-4000) })
    })
  })
}

/** Full doctor: cheap stages + tsc + full test suite. Opens the hands gate on green. */
export async function runFullDoctor(cfg: Config, root: string): Promise<DoctorReport> {
  const cheap = await runDoctor(cfg)
  const tsc = await runCapture('npx', ['tsc', '--noEmit'], root, 180_000)
  const tests = await runCapture('npx', ['vitest', 'run', '--reporter=basic'], root, 600_000)
  const full = { tscOk: tsc.code === 0, testsOk: tests.code === 0, ts: Date.now() }
  if (full.tscOk && full.testsOk) {
    const prev = readDoctorState(cfg) ?? {}
    // The full run IS the proof: persist green with cheapOk re-derived from the
    // core stages, so a first-ever run opens the gate instead of needing two runs.
    const cheapCoreOk = cheap.stages.filter((s) => s.name !== 'hands-gate').every((s) => s.ok)
    writeDoctorState(cfg, { ...prev, lastRunTs: Date.now(), lastTestGreenAt: Date.now(), cheapOk: cheapCoreOk, full })
  }
  // A green full run satisfies the hands-gate stage by definition — don't show
  // the pre-run stale state (which would mark a fresh install UNHEALTHY).
  const handsStage: DoctorStage =
    full.tscOk && full.testsOk
      ? { name: 'hands-gate', ok: true, detail: 'test suite green (this run)' }
      : (cheap.stages.find((s) => s.name === 'hands-gate') ?? { name: 'hands-gate', ok: false, detail: 'full run failed' })
  const stages: DoctorStage[] = [
    ...cheap.stages.filter((s) => s.name !== 'hands-gate'),
    handsStage,
    { name: 'tsc', ok: full.tscOk, detail: full.tscOk ? 'clean' : tsc.output.trim().split('\n').slice(-3).join(' | ') },
    { name: 'tests', ok: full.testsOk, detail: full.testsOk ? 'suite green' : tests.output.trim().split('\n').slice(-3).join(' | ') },
  ]
  return { ok: stages.every((s) => s.ok), stages, full }
}

/** One-line-per-stage report for logs / Telegram / the dashboard. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.stages.map((s) => `${s.ok ? '✅' : '❌'} ${s.name}: ${s.detail}`)
  return `${report.ok ? '🩺 Doctor: HEALTHY' : '🩺 Doctor: UNHEALTHY — hands are gated off'}\n${lines.join('\n')}`
}

/** Desk root — re-derived here so the doctor never imports config's env plumbing. */
function deskRootOf(cfg: Config): string {
  // dataDir = <root>/data → root is its parent.
  return path.dirname(cfg.paths.dataDir)
}

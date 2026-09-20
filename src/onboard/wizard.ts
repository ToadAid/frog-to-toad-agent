import fs from 'node:fs'
import path from 'node:path'
import { envValueOf, runBrainSetupMenu, upsertEnvFile } from '../llm/brainSetup.js'
import type { ChecklistItem, ChecklistResult, OnboardIo } from './types.js'
import { assessChecklist, buildChecklist, maskSecret, missingRequired, renderChecklist } from './checklist.js'
import { discoverAdminChatId, probeBotToken, sendOnboardingPing } from './telegram.js'
import { installUnit } from './unit.js'

/**
 * The §12.7 onboarding wizard: fresh box → talking frog. Every step talks
 * through OnboardIo (injectable), re-runs are idempotent (existing values
 * shown as [current], Enter keeps them), and aborts leave partial progress
 * on disk so the next `npm run onboard` resumes.
 */

export const BOOT_MARKER = 'frog-to-toad-agent is live'
const BOOT_WATCH_TIMEOUT_MS = 120_000
const BOOT_POLL_MS = 2_000
const DOCTOR_STATE_FRESH_MS = 90_000
const DESK_UNIT = 'frog-to-toad-agent.service'

export type OnboardDeps = {
  /** In-wizard cheap-doctor fallback, injectable for tests (spy). */
  runDoctorFn?: (io: OnboardIo) => Promise<{ ok: boolean; detail: string }>
  /** Test levers for the real-time loops (defaults: 120s boot, 90s discovery). */
  bootTimeoutMs?: number
  discoveryTimeoutMs?: number
}

export async function runOnboarding(io: OnboardIo, deps: OnboardDeps = {}): Promise<number> {
  io.print('──────────── frog-to-toad-agent onboarding ────────────')

  // ── checklist ──
  const items = await assessChecklist(buildChecklist(io), io)
  io.print(renderChecklist(items))

  // Hard requirements the wizard cannot fix (env/data/node): stop here.
  // token + chat id are also required but they are what this wizard fills.
  const wizardFixable = new Set([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ADMIN_CHAT_ID',
    'TELEGRAM_PRINCIPAL_USER_ID',
    'wallet',
  ])
  const blockers = items.filter((i) => i.required && i.result.status === 'missing' && !wizardFixable.has(i.key))
  if (blockers.length > 0) {
    io.print('[onboard] fix the [!] items above first, then rerun: npm run onboard')
    return 1
  }

  const collected: Record<string, string> = {}
  let envCreated = !fs.existsSync(io.envPath)

  // ── step 1 · bot token ──
  const token = await collectToken(io)
  if (token === null) return abort(io)
  collected['TELEGRAM_BOT_TOKEN'] = token

  // ── step 2 · admin chat id ──
  const discovered: { principalUserId?: string } = {}
  const chatId = await collectAdminChatId(io, token, deps.discoveryTimeoutMs, discovered)
  if (chatId === null) return abort(io)
  collected['TELEGRAM_ADMIN_CHAT_ID'] = chatId
  const principalUserId = await collectPrincipalUserId(io, discovered.principalUserId)
  if (principalUserId === null) return abort(io)
  collected['TELEGRAM_PRINCIPAL_USER_ID'] = principalUserId

  // ── step 3 · brain ──
  io.print('\nStep 3/7 · Brain')
  const brain = await runBrainSetupMenu({
    envPath: io.envPath,
    runCodexLogin: io.runCodexLogin,
    print: io.print,
    ask: io.ask,
    confirm: io.confirm,
    fetchImpl: io.fetchImpl,
  })
  if (brain.aborted) return abort(io)

  // ── step 4 · .env ──
  io.print('\nStep 4/7 · Write .env')
  const entries: Record<string, string> = { ...collected }
  // DRY_RUN=true is forced on a FRESH .env only — an existing box's value is
  // the principal's own decision and is never touched.
  const envCreatedNow = !fs.existsSync(io.envPath)
  if (envCreated || envCreatedNow) entries['DRY_RUN'] = 'true'
  const { changed, created } = upsertEnvFile(io.envPath, entries)
  io.print(`  ✓ ${created || envCreatedNow ? 'created' : 'updated'} .env — changed: ${changed.join(', ') || '(nothing)'}`)
  io.print('  ⚠ dry-run first: every order is simulated until YOU flip DRY_RUN=false,')
  io.print('    and flipping requires the MCP wallet lane (see .env.example).')

  // ── step 5 · systemd unit ──
  io.print('\nStep 5/7 · systemd --user unit')
  const unit = await installUnit(io)

  // ── step 6 · first boot ──
  let doctor: { ok: boolean; detail: string } | undefined
  if (unit === 'installed') {
    io.print('\nStep 6/7 · First boot')
    const boot = await bootAndWatch(io, deps.bootTimeoutMs)
    if (!boot.booted) return abort(io)
    doctor = await doctorState(io, deps)
    io.print(`  ✓ doctor (cheap gate): ${doctor.ok ? 'healthy' : 'UNHEALTHY'} — ${doctor.detail}`)
  } else {
    io.print('\nStep 6/7 · First boot — skipped (unit not installed).')
    io.print('  start the frog your own way: npm run dev (tmux), or rerun onboard.')
  }

  // ── step 7 · handshake ──
  io.print('\nStep 7/7 · Handshake')
  const chatNum = Number(collected['TELEGRAM_ADMIN_CHAT_ID'] ?? envValueOf(io.envPath, 'TELEGRAM_ADMIN_CHAT_ID'))
  if (Number.isFinite(chatNum)) {
    const ping = await sendOnboardingPing(token, chatNum, '🐸 Frog-to-Toad Agent onboarded. This ping proves the token + your chat id work — press /start to talk to your frog.', io.fetchImpl)
    if (ping.ok) {
      io.print(`  ✓ ping delivered to chat ${chatNum} — confirm it arrived on your phone.`)
    } else {
      io.print(`  ! ping failed (${ping.error}) — the desk may still deliver once running; check the chat id.`)
    }
  }
  printFinisher(io)
  await offerFullDoctor(io)
  return 0
}

function abort(io: OnboardIo): number {
  io.print('[onboard] stopped — what was written so far is kept.')
  io.print('           resume any time: npm run onboard')
  return 1
}

// ── steps, exported individually for tests ──────────────────────────────────

export async function showChecklist(io: OnboardIo): Promise<Array<ChecklistItem & { result: ChecklistResult }>> {
  const items = await assessChecklist(buildChecklist(io), io)
  io.print(renderChecklist(items))
  const missing = missingRequired(items)
  if (missing.length > 0) io.print(`  still needed: ${missing.join(', ')}`)
  return items
}

/** Masked token entry. Enter on the prompt keeps the .env value; a typed
 * value is probed via getMe until valid or aborted (empty twice → abort). */
export async function collectToken(io: OnboardIo): Promise<string | null> {
  io.print('\nStep 1/7 · Telegram bot token')
  io.print('  Create a bot with @BotFather → /newbot, then paste the token here.')
  io.print('  It is written to .env only and is never printed or logged.')
  const current = envValueOf(io.envPath, 'TELEGRAM_BOT_TOKEN')
  for (let attempt = 0; attempt < 2; attempt++) {
    let input: string
    if (current !== undefined) {
      io.print(`  Current token: ${maskSecret(current)} — Enter keeps it.`)
      input = await io.ask('Bot token (Enter=keep, new token to replace): ')
      if (input.trim() === '') return current
    } else {
      input = await io.askHidden('Bot token (input hidden): ')
    }
    const trimmed = input.trim()
    if (trimmed === '') {
      io.print('  (empty — try again)')
      continue
    }
    const probe = await probeBotToken(trimmed, io.fetchImpl)
    if (probe.ok) {
      io.print(`  ✓ verified as @${probe.username}`)
      return trimmed
    }
    io.print(`  ✗ ${probe.error} — try again.`)
  }
  return null
}

/** Chat-id discovery: getUpdates watch when the desk is NOT polling (a live
 * desk holds the 409), manual entry otherwise. */
export async function collectAdminChatId(
  io: OnboardIo,
  token: string,
  timeoutMs = 90_000,
  discovered: { principalUserId?: string } = {},
): Promise<string | null> {
  io.print('\nStep 2/7 · Your Telegram identity')
  const active = await io.exec('systemctl', ['--user', 'is-active', '--quiet', DESK_UNIT], 5_000)
  const deskLive = active.status === 0

  if (!deskLive) {
    io.print('  Open a chat with your bot and press Start / send "hi" NOW.')
    io.print(`  Watching for your message (up to ${Math.round(timeoutMs / 1000)} s)…`)
    const found = await discoverAdminChatId(token, { timeoutMs }, io.fetchImpl)
    if (
      found.chatId !== undefined &&
      found.principalUserId !== undefined &&
      (await io.confirm(`Use chat ${found.chatId} and user ${found.principalUserId} as your principal identity?`, true))
    ) {
      discovered.principalUserId = String(found.principalUserId)
      return String(found.chatId)
    }
    if (found.error === 'conflict') {
      io.print('  (another bot process is polling — cannot watch here; type it manually.)')
    } else if (found.error !== undefined) {
      io.print(`  (no luck: ${found.error})`)
    }
  }
  io.print('  Tip: message your bot once — it replies "This desk is private. Your chat id: N".')
  const manual = (await io.ask('TELEGRAM_ADMIN_CHAT_ID (number): ')).trim()
  return /^\d+$/.test(manual) || /^-\d+$/.test(manual) ? manual : null
}

export async function collectPrincipalUserId(
  io: OnboardIo,
  discovered?: string,
): Promise<string | null> {
  if (discovered !== undefined) return discovered
  const current = envValueOf(io.envPath, 'TELEGRAM_PRINCIPAL_USER_ID')
  if (current !== undefined && /^[1-9][0-9]*$/.test(current)) {
    const input = (await io.ask('TELEGRAM_PRINCIPAL_USER_ID (Enter=keep current): ')).trim()
    if (input === '') return current
    return /^[1-9][0-9]*$/.test(input) ? input : null
  }
  io.print('  Your principal user id is the positive from.id of your Telegram account, separate from chat routing.')
  const input = (await io.ask('TELEGRAM_PRINCIPAL_USER_ID (positive number): ')).trim()
  return /^[1-9][0-9]*$/.test(input) ? input : null
}

/** The boot watch: poll the log tail for the live/fatal markers the boot path
 * actually emits. Timeout is a printed hint, not a silent hang. */
export async function bootAndWatch(io: OnboardIo, timeoutMs = BOOT_WATCH_TIMEOUT_MS): Promise<{ booted: boolean }> {
  io.print('\n[onboard] starting the desk (systemctl --user start)…')
  const start = await io.exec('systemctl', ['--user', 'start', DESK_UNIT], 30_000)
  if (start.status !== 0) {
    io.print(`  ! start failed: ${start.stderr.trim() || 'exit nonzero'}`)
    return { booted: false }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tail = io.readLogTail(40)
    if (tail.includes(BOOT_MARKER)) return { booted: true }
    if (tail.includes('fatal:') || tail.includes('TELEGRAM_BOT_TOKEN is required')) {
      io.print('  ✗ boot failed — last log lines:')
      for (const line of tail.split('\n').slice(-8)) io.print(`    ${line}`)
      return { booted: false }
    }
    await io.sleep(BOOT_POLL_MS)
  }
  io.print('  (no boot marker in time — check: journalctl --user -u frog-to-toad-agent -n 50)')
  io.print('                            or: npm run desk follow')
  return { booted: false }
}

/** Doctor read: the boot the wizard just started already ran the cheap gate
 * and persisted data/state/doctor.json — read it back. Stale/missing → run
 * the cheap doctor in-wizard (deps.runDoctorFn, loadConfig-based). */
export async function doctorState(io: OnboardIo, deps: OnboardDeps = {}): Promise<{ ok: boolean; detail: string; fresh: boolean }> {
  const statePath = path.join(io.repoDir, 'data', 'state', 'doctor.json')
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { lastRunTs?: number; cheapOk?: boolean }
    if (raw.lastRunTs !== undefined && Date.now() - raw.lastRunTs < DOCTOR_STATE_FRESH_MS) {
      return { ok: raw.cheapOk === true, detail: 'from boot gate', fresh: true }
    }
  } catch {
    /* fall through to in-wizard run */
  }
  const run = deps.runDoctorFn ?? defaultRunDoctor
  const r = await run(io)
  return { ...r, fresh: false }
}

async function defaultRunDoctor(io: OnboardIo): Promise<{ ok: boolean; detail: string }> {
  try {
    try { process.loadEnvFile(io.envPath) } catch { /* no .env yet — fine */ }
    const { loadConfig } = await import('../config.js')
    const { runDoctor, formatDoctorReport } = await import('../doctor/doctor.js')
    const report = await runDoctor(loadConfig())
    return { ok: report.ok, detail: formatDoctorReport(report) }
  } catch (e) {
    return { ok: false, detail: `doctor failed: ${e instanceof Error ? e.message : e}` }
  }
}

export function printFinisher(io: OnboardIo): void {
  io.print('\n  Talk to it like a trader:')
  io.print('    "what is BTC doing?"        "research PEPE"')
  io.print('    "buy 0.1 ETH of MOG (simulated)"          /status /positions /agents /stop')
  io.print('  Hands (workspace/exec/browser) stay gated until: npm run doctor')
  io.print('  Controls: npm run desk status | logs | follow | restart')
}

export async function offerFullDoctor(io: OnboardIo): Promise<void> {
  if (!(await io.confirm('Optional: run the FULL doctor now (tsc + tests, opens the hands gate for 7 days, takes minutes)?', false))) {
    io.print('  (skipped — run it later: npm run doctor)')
    return
  }
  io.print('  running full doctor — this takes a few minutes…')
  const r = await io.exec('npm', ['run', 'doctor'], 15 * 60_000)
  io.print(r.status === 0 ? '  ✓ full doctor green — hands gate open.' : '  ! full doctor failed — see the output above / npm run desk logs.')
}

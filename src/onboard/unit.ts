import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { OnboardIo } from './types.js'

/**
 * systemd --user unit install (§12.7): render deploy/frog-to-toad-agent.service
 * with this box's paths, confirm, write, daemon-reload, enable — and attempt
 * `loginctl enable-linger` best-effort (it can trigger polkit; a failure is a
 * printed instruction, never a wizard failure). Non-Linux defers to §12.8.
 */

export type UnitContext = { repoDir: string; nodeBinDir: string; homeDir: string; deskDir?: string }

export function nodeBinDir(execPath: string = process.execPath): string {
  return path.dirname(execPath)
}

export function unitPathFor(homeDir: string): string {
  return path.join(homeDir, '.config', 'systemd', 'user', 'frog-to-toad-agent.service')
}

export function renderUnitTemplate(template: string, ctx: UnitContext): string {
  const envLine = ctx.deskDir ? `Environment=FROG_TO_TOAD_DIR=${ctx.deskDir}` : ''
  return template
    .split('{{REPO_DIR}}').join(ctx.repoDir)
    .split('{{NODE_BIN_DIR}}').join(ctx.nodeBinDir)
    .split('{{HOME}}').join(ctx.homeDir)
    .split('{{FROG_TO_TOAD_DIR_ENV}}').join(envLine)
}

export function unitsDiffer(a: string, b: string): boolean {
  return a.trim() !== b.trim()
}

export type UnitInstallOutcome = 'installed' | 'kept' | 'aborted' | 'unsupported'

/** Render + install the user unit. Idempotent: an identical existing unit is
 * kept untouched; a differing one requires an explicit yes (default NO —
 * never clobber a hand-tuned unit silently). */
export async function installUnit(io: OnboardIo): Promise<UnitInstallOutcome> {
  if (io.platform !== 'linux') {
    io.print('[onboard] not Linux — unit install ships with §12.8 packaging.')
    io.print('          for now: npm run dev (tmux) to keep the frog alive.')
    return 'unsupported'
  }

  const template = fs.readFileSync(io.unitTemplatePath, 'utf8')
  const rendered = renderUnitTemplate(template, {
    repoDir: io.repoDir,
    nodeBinDir: nodeBinDir(),
    homeDir: io.homeDir,
    deskDir: process.env.FROG_TO_TOAD_DIR ?? process.env.TRADING_DESK_DIR,
  })

  let existing: string | undefined
  try {
    existing = fs.readFileSync(io.unitPath, 'utf8')
  } catch {
    /* no unit yet */
  }
  if (existing !== undefined) {
    if (!unitsDiffer(existing, rendered)) {
      io.print('  ✓ unit already installed and up to date — kept.')
      return 'kept'
    }
    io.print('  an existing unit differs from the template. Diff:')
    for (const line of diffLines(existing, rendered)) io.print(`    ${line}`)
    if (!(await io.confirm('  Overwrite the unit?', false))) return 'aborted'
  }

  fs.mkdirSync(path.dirname(io.unitPath), { recursive: true, mode: 0o755 })
  fs.writeFileSync(io.unitPath, rendered.endsWith('\n') ? rendered : `${rendered}\n`, { mode: 0o644 })

  const reload = await io.exec('systemctl', ['--user', 'daemon-reload'], 15_000)
  if (reload.status !== 0) {
    io.print(`  ! daemon-reload failed: ${reload.stderr.trim() || reload.stdout.trim() || 'exit nonzero'}`)
    io.print('    is the systemd --user manager reachable? (see checklist hint)')
    return 'aborted'
  }
  const enable = await io.exec('systemctl', ['--user', 'enable', 'frog-to-toad-agent.service'], 15_000)
  if (enable.status !== 0) {
    io.print(`  ! enable failed: ${enable.stderr.trim() || 'exit nonzero'}`)
    return 'aborted'
  }

  // Linger survives logout+reboot; may prompt via polkit — best-effort only.
  const linger = await io.exec('loginctl', ['enable-linger', os.userInfo().username], 10_000)
  if (linger.status === 0) {
    io.print('  ✓ daemon-reload · enabled · linger: OK')
  } else {
    io.print(`  ✓ installed + enabled · linger NOT set (${linger.stderr.trim() || 'needs privileges'})`)
    io.print(`    run once by hand: loginctl enable-linger ${os.userInfo().username}`)
  }
  return 'installed'
}

function diffLines(existing: string, rendered: string): string[] {
  const a = existing.split('\n')
  const b = rendered.split('\n')
  const out: string[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max && out.length < 12; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`- ${a[i]}`)
      if (b[i] !== undefined) out.push(`+ ${b[i]}`)
    }
  }
  return out
}

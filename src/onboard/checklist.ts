import fs from 'node:fs'
import path from 'node:path'
import { envValueOf } from '../llm/brainSetup.js'
import type { ChecklistItem, ChecklistResult, OnboardIo } from './types.js'

/**
 * The pre-flight checklist (§12.7): a data-driven picture of what the desk
 * has / lacks, rendered before the wizard touches anything. Values come ONLY
 * from `envValueOf` (the `desk` CLI does not load .env) and secrets are
 * rendered masked — `1234…AB`, never the full value.
 */

/** first4…last2 — same shape discipline as the brain keyfile status. */
export function maskSecret(v: string | undefined): string {
  if (v === undefined || v === '') return '(missing)'
  if (v.length <= 6) return '••••'
  return `${v.slice(0, 4)}…${v.slice(-2)}`
}

function envItem(envPath: string, key: string, label: string, required: boolean, opts?: {
  present?: (value: string) => ChecklistResult
  absent?: ChecklistResult
}): ChecklistItem {
  return {
    key,
    label,
    required,
    probe: async () => {
      const value = envValueOf(envPath, key)
      if (value === undefined || value === '') return opts?.absent ?? { status: 'missing', detail: '(missing)' }
      return opts?.present?.(value) ?? { status: 'ok', detail: value }
    },
  }
}

const GLM_LANE_LABEL: Record<string, string> = {
  zai: 'Z.ai GLM (API key)',
  openai: 'OpenAI (API key)',
  codex: 'OpenAI-compatible (API key preset)',
  ollama: 'Ollama (local, no key)',
}

/** Build the checklist. Probes are per-item so tests can drive one at a time. */
export function buildChecklist(io: OnboardIo): ChecklistItem[] {
  const deskDir = path.join(io.repoDir, 'data')
  return [
    envItem(io.envPath, 'TELEGRAM_BOT_TOKEN', 'Telegram bot token', true, {
      present: (v) => ({ status: 'ok', detail: maskSecret(v) }),
    }),
    envItem(io.envPath, 'TELEGRAM_ADMIN_CHAT_ID', 'Telegram admin chat id', true),
    envItem(io.envPath, 'TELEGRAM_PRINCIPAL_USER_ID', 'Telegram principal user id', true),
    envItem(io.envPath, 'BRAIN', 'LLM brain lane', false, {
      absent: { status: 'info', detail: 'BRAIN=glm default — pick a brain in step 3' },
      present: (v) => {
        const lane = envValueOf(io.envPath, 'LLM_PROVIDER') ?? 'zai'
        const laneLabel = GLM_LANE_LABEL[lane] ?? lane
        return { status: 'ok', detail: v === 'codex' ? 'codex (ChatGPT keyfile)' : `${laneLabel} via GLM` }
      },
    }),
    envItem(io.envPath, 'DRY_RUN', 'Dry-run safety', false, {
      absent: { status: 'info', detail: 'true (default — safe)' },
      present: (v) =>
        v === 'true'
          ? { status: 'ok', detail: 'true — every order simulated' }
          : { status: 'warn', detail: 'false — LIVE orders; wallet lane must be configured' },
    }),
    {
      key: 'wallet',
      label: 'Wallet lane',
      required: false,
      probe: async () => {
        const dryRun = envValueOf(io.envPath, 'DRY_RUN') ?? 'true'
        if (dryRun === 'true') return { status: 'info', detail: 'dry-run needs none; live needs MCP_COMMAND (external signer)' }
        const mcp = envValueOf(io.envPath, 'MCP_COMMAND')
        return mcp
          ? { status: 'ok', detail: 'MCP_COMMAND present' }
          : { status: 'missing', detail: 'DRY_RUN=false but no MCP_COMMAND' }
      },
    },
    {
      key: 'dataDir',
      label: 'data/ dir writable',
      required: true,
      probe: async () => {
        try {
          fs.mkdirSync(deskDir, { recursive: true })
          fs.accessSync(deskDir, fs.constants.W_OK)
          return { status: 'ok', detail: 'writable' }
        } catch (e) {
          return { status: 'missing', detail: `not writable (${e instanceof Error ? e.message : e})` }
        }
      },
    },
    {
      key: 'node',
      label: 'node version',
      required: true,
      probe: async () => {
        const major = Number(process.versions.node.split('.')[0])
        return major >= 24
          ? { status: 'ok', detail: `v${process.versions.node}` }
          : { status: 'missing', detail: `v${process.versions.node} — need >= 24` }
      },
    },
    {
      key: 'systemd',
      label: 'systemd --user manager',
      required: false,
      probe: async (io2) => {
        if (io2.platform !== 'linux') return { status: 'info', detail: 'not Linux — unit install is §12.8' }
        const r = await io2.exec('systemctl', ['--user', 'is-system-running'], 5_000)
        if (r.status === 0) return { status: 'ok', detail: r.stdout.trim() || 'running' }
        // `degraded` exits 1 but IS a working manager; absence exits 3+.
        if (r.stdout.trim().startsWith('degraded')) return { status: 'ok', detail: 'degraded (usable)' }
        return {
          status: 'warn',
          detail: 'not reachable — export XDG_RUNTIME_DIR=/run/user/$(id -u) or log in locally',
        }
      },
    },
  ]
}

/** Run every probe. A probe that throws becomes a warn — a broken check never
 * blocks the wizard; the step that needs the thing re-verifies for real. */
export async function assessChecklist(items: ChecklistItem[], io: OnboardIo): Promise<Array<ChecklistItem & { result: ChecklistResult }>> {
  const out = []
  for (const item of items) {
    let result: ChecklistResult
    try {
      result = item.probe ? await item.probe(io) : { status: 'ok', detail: '' }
    } catch (e) {
      result = { status: 'warn', detail: `check failed (${e instanceof Error ? e.message : e})` }
    }
    out.push({ ...item, result })
  }
  return out
}

const GLYPH: Record<ChecklistResult['status'], string> = { ok: '✓', missing: ' ', warn: '!', info: 'i' }

export function renderChecklist(items: Array<ChecklistItem & { result: ChecklistResult }>): string {
  return items
    .map(({ label, required, result }) => `  [${required && result.status === 'missing' ? '!' : GLYPH[result.status]}] ${label.padEnd(24)} ${result.detail}`)
    .join('\n')
}

/** Required items still missing — the wizard refuses to continue past these. */
export function missingRequired(items: Array<ChecklistItem & { result: ChecklistResult }>): string[] {
  return items.filter((i) => i.required && i.result.status === 'missing').map((i) => i.label)
}

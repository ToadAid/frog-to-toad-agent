import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const limitsSchema = z.object({
  perTradeUsdMax: z.number().positive().default(50),
  dailyUsdMax: z.number().positive().default(200),
  maxOpenPositions: z.number().int().positive().default(10),
  approvalTimeoutSec: z.number().int().positive().default(120),
  /** Approval throttle (Nautilus message-bus steal): max cards pending at once. */
  approvalMaxPending: z.number().int().positive().default(3),
  /** Minimum seconds between approval cards — a runaway loop can't spam the principal's phone. */
  approvalMinIntervalSec: z.number().min(0).default(5),
  tokenAllowlist: z.array(z.string()).default([]),
  blockedSymbols: z.array(z.string()).default([]),
  blockedAddresses: z.array(z.string()).default([]),
})

const fileConfigSchema = z.object({
  limits: limitsSchema.optional(),
  guardedTools: z.array(z.string()).default(['swap_execute']),
  lessonsSampleMin: z.number().int().positive().default(5),
})

/** External MCP wallet-lane backends — the ONLY modes real execution may run under. */
export const WALLET_BACKENDS = ['coinbase-mcp', 'cobo-mcp'] as const
export type WalletBackend = (typeof WALLET_BACKENDS)[number]

export type Limits = z.infer<typeof limitsSchema>

export type FileConfig = z.infer<typeof fileConfigSchema>

export type Config = {
  /** Which brain the desk thinks with — `glm` (default, the LLM_PROVIDER lane) or `codex` (ChatGPT OAuth keyfile). */
  brain: 'glm' | 'codex'
  dryRun: boolean
  /** Frog-to-Toad apprenticeship: only DRY_RUN swap_execute may bypass human approval. */
  autonomousDryRun?: boolean
  /** A1 finite simulated capital. Undefined means the principal has not granted a bankroll. */
  apprenticeshipSeedUsd?: number
  /** A2 principal-owned autonomous wake cadence. Undefined means no autonomous clock. */
  apprenticeshipWakeCron?: string
  executionMode: string
  llm: {
    provider: string
    baseUrl: string
    model: string
    apiKey: string
    temperature: number
    maxTokens: number
  }
  telegram: {
    botToken: string
    adminChatId: number | undefined
    /** Exact Telegram PERSON identity. Never inferred from chat routing. */
    principalUserId?: number
    groupChatId?: number
    allowedChatIds: number[]
    /** Live progress-draft bubble while the agent works (default on). */
    progressDrafts: boolean
  }
  limits: Limits
  guardedTools: string[]
  lessonsSampleMin: number
  /** Turns between [memory nudge] reminders in the agent loop (0 = off; default 10). */
  memoryNudgeInterval: number
  /** Morning brief cron (principal's timezone; empty string = off). */
  briefCron: string
  /** Proactive sentinel scan cron (principal's timezone; empty string = off). */
  sentinelCron: string
  /** Watchdog heartbeat cron (Nautilus steal): brain + ritual staleness (empty string = off). */
  watchdogCron: string
  /** 24h price move % that trips a sentinel alert (default 5). */
  sentinelMovePct: number
  /** External MCP wallet server (Coinbase CDP / Cobo). The signer lives there, never here. */
  mcp: {
    command: string | undefined
    args: string[]
    /** Deny-by-default allowlist of server tool names the desk may call. */
    allowedTools: string[]
    /** Server tool name swap_execute's 'mcp' backend calls. */
    swapTool: string
    /** KEY=VALUE file loaded into the wallet server's env only (keys never in desk .env). */
    envFile: string | undefined
  }
  /** IANA zone the PRINCIPAL lives in — drives every "today/yesterday" the desk reasons about. */
  timezone: string
  paths: {
    dataDir: string
    agentsDir: string
    skillsDir: string
    /** Repo-shipped reference data (output styles, Tier 2 #6). */
    assetsDir: string
  }
  statusPort: number
  selftest: boolean
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined
}

function envNumber(name: string): number | undefined {
  const v = env(name)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function envTelegramUserId(name: string): number | undefined {
  const value = env(name)
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a canonical positive numeric Telegram user ID`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a canonical positive numeric Telegram user ID`)
  }
  return parsed
}

/** Comma-separated env value (`MCP_ALLOWED_TOOLS` style). Undefined when unset/empty. */
function parseListEnv(raw: string | undefined): string[] | undefined {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return list.length > 0 ? list : undefined
}

/**
 * Provider presets — one raw-fetch client, two wire formats:
 *  - zai    : Z.ai GLM (default, the home-country stack) — chat completions
 *  - openai : api.openai.com chat models — chat completions
 *  - codex  : OpenAI Codex models — Responses API (chat/completions 404s on them)
 *  - ollama : local Ollama, no API key needed — chat completions
 * LLM_MODEL overrides any preset's default model.
 */
const llmPresets: Record<string, { baseUrl: string; model: string }> = {
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  codex: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.3-codex' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'glm-5.3-flash:cloud' },
}

/**
 * BRAIN=codex lane — ChatGPT web-login OAuth (keyfile credential, no API key).
 * Literal here because codexAuth.ts imports THIS module (no import cycle);
 * codexAuth.ts holds the protocol constants (issuer, client_id) and points
 * back at this file.
 */
const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol'

function isLocalBaseUrl(url: string): boolean {
  return url.includes('127.0.0.1') || url.includes('localhost')
}

/** Resolve the agent root (where config.json / agents/ / skills/ live). */
export function deskRoot(): string {
  // FROG_TO_TOAD_DIR is the public name. TRADING_DESK_DIR remains as a
  // compatibility fallback for existing installations and test harnesses.
  return env('FROG_TO_TOAD_DIR') ?? env('TRADING_DESK_DIR') ?? path.resolve(import.meta.dirname, '..')
}

export function loadConfig(): Config {
  const root = deskRoot()

  let file: FileConfig
  const configPath = path.join(root, 'config.json')
  if (fs.existsSync(configPath)) {
    const parsed = fileConfigSchema.safeParse(JSON.parse(fs.readFileSync(configPath, 'utf8')))
    if (!parsed.success) {
      throw new Error(`config.json invalid: ${parsed.error.message}`)
    }
    file = parsed.data
  } else {
    file = fileConfigSchema.parse({})
  }
  const limits = file.limits ?? limitsSchema.parse({
    // Env overrides for the approval throttle (config.json limits override these).
    approvalMaxPending: Number(env('APPROVAL_MAX_PENDING') ?? 3),
    approvalMinIntervalSec: Number(env('APPROVAL_MIN_INTERVAL_SEC') ?? 5),
  })

  const dryRun = (env('DRY_RUN') ?? 'true') !== 'false'
  const executionMode = env('EXECUTION_MODE') ?? 'none'
  const apprenticeshipSeedRaw = env('APPRENTICESHIP_SEED_USD')
  const apprenticeshipSeedUsd =
    apprenticeshipSeedRaw === undefined ? undefined : Number(apprenticeshipSeedRaw)
  const autonomousDryRun = (env('AUTONOMOUS_DRY_RUN') ?? 'false') === 'true'
  const apprenticeshipWakeCron = env('APPRENTICESHIP_WAKE_CRON')
  const configuredGuardedTools = parseListEnv(env('GUARDED_TOOLS')) ?? file.guardedTools
  // A2 constitutional seam: an autonomous frog may never create/delete its
  // own clock without the principal. This union survives operator overrides.
  const guardedTools = autonomousDryRun
    ? [...new Set([...configuredGuardedTools, 'schedule_create', 'schedule_delete'])]
    : configuredGuardedTools

  // Brain selection (§12.6): BRAIN=codex swaps the whole LLM lane to the
  // ChatGPT-OAuth keyfile client; BRAIN=glm (default) leaves the LLM_PROVIDER
  // machinery below completely untouched.
  const brainRaw = (env('BRAIN') ?? 'glm').toLowerCase()
  if (brainRaw !== 'glm' && brainRaw !== 'codex') {
    throw new Error(`Unknown BRAIN '${brainRaw}'. Known: glm, codex`)
  }
  const brain: 'glm' | 'codex' = brainRaw

  const providerName = (env('LLM_PROVIDER') ?? 'zai').toLowerCase()
  const preset = llmPresets[providerName]
  if (env('LLM_PROVIDER') !== undefined && !preset) {
    throw new Error(
      `Unknown LLM_PROVIDER '${providerName}'. Known: ${Object.keys(llmPresets).join(', ')} ` +
        `(or omit LLM_PROVIDER and set LLM_BASE_URL/LLM_MODEL directly for any OpenAI-compatible endpoint)`,
    )
  }
  // An explicit LLM_PROVIDER means "use that endpoint" — the preset's baseUrl
  // wins over any LLM_BASE_URL left in .env, but LLM_MODEL can still override
  // the preset's default model (e.g. LLM_PROVIDER=ollama LLM_MODEL=glm-5.3-flash:cloud).
  const usePreset = preset !== undefined

  const cfg: Config = {
    brain,
    dryRun,
    autonomousDryRun,
    apprenticeshipSeedUsd,
    apprenticeshipWakeCron,
    executionMode,
    llm: {
      provider: brain === 'codex' ? 'codex' : providerName,
      baseUrl: brain === 'codex'
        ? CODEX_BACKEND_BASE_URL
        : (usePreset ? preset!.baseUrl : (env('LLM_BASE_URL') ?? 'https://api.z.ai/api/paas/v4')).replace(/\/+$/, ''),
      model: brain === 'codex'
        ? (env('CODEX_MODEL') ?? CODEX_DEFAULT_MODEL)
        : (env('LLM_MODEL') ?? (usePreset ? preset!.model : 'glm-4.6')),
      // The keyfile IS the credential on the codex lane — an API key here
      // would be a second credential pretending to be the first.
      apiKey: brain === 'codex' ? '' : (env('LLM_API_KEY') ?? ''),
      temperature: envNumber('LLM_TEMPERATURE') ?? 0.3,
      maxTokens: envNumber('LLM_MAX_TOKENS') ?? 4096,
    },
    telegram: {
      botToken: env('TELEGRAM_BOT_TOKEN') ?? '',
      adminChatId: envNumber('TELEGRAM_ADMIN_CHAT_ID'),
      principalUserId: envTelegramUserId('TELEGRAM_PRINCIPAL_USER_ID'),
      groupChatId: envNumber('TELEGRAM_GROUP_CHAT_ID'),
      allowedChatIds: (env('TELEGRAM_ALLOWED_CHAT_IDS') ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n !== 0),
      // One live "progress draft" bubble edited in place while the agent works
      // (the OpenClaw pattern). Set TELEGRAM_PROGRESS_DRAFTS=off for final-only.
      progressDrafts: (env('TELEGRAM_PROGRESS_DRAFTS') ?? 'on') !== 'off',
    },
    limits,
    // GUARDED_TOOLS (.env, comma-separated) overrides config.json when set.
    // In autonomous apprenticeship mode A2 still force-adds schedule mutation:
    // the frog may not expand or delete its own clock.
    guardedTools,
    lessonsSampleMin: file.lessonsSampleMin,
    mcp: {
      command: env('MCP_COMMAND'),
      args: (env('MCP_ARGS') ?? '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
      allowedTools: (env('MCP_ALLOWED_TOOLS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
      swapTool: env('MCP_SWAP_TOOL') ?? 'swap',
      envFile: env('MCP_ENV_FILE'),
    },
    timezone: env('USER_TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    memoryNudgeInterval: Math.max(0, Number(env('MEMORY_NUDGE_INTERVAL') ?? 10) || 0),
    briefCron: env('MORNING_BRIEF_CRON') ?? '47 8 * * *',
    sentinelCron: env('SENTINEL_CRON') ?? '19 */2 * * *',
    watchdogCron: env('WATCHDOG_CRON') ?? '37 */2 * * *',
    sentinelMovePct: Number(env('SENTINEL_MOVE_PCT') ?? 5),
    paths: {
      dataDir: path.join(root, 'data'),
      agentsDir: path.join(root, 'agents'),
      skillsDir: path.join(root, 'skills'),
      assetsDir: path.join(root, 'assets'),
    },
    statusPort: envNumber('STATUS_PORT') ?? 8787,
    selftest: env('SELFTEST') === '1',
  }

  validate(cfg)
  return cfg
}

function validate(cfg: Config): void {
  // Frog-to-Toad A0: autonomous approval is simulation-only. A config that
  // tries to carry this authority into live mode is invalid and will not boot.
  if (cfg.autonomousDryRun && !cfg.dryRun) {
    throw new Error('AUTONOMOUS_DRY_RUN=true requires DRY_RUN=true — autonomous live-money approval is forbidden.')
  }
  if (
    cfg.apprenticeshipSeedUsd !== undefined &&
    (!Number.isFinite(cfg.apprenticeshipSeedUsd) || cfg.apprenticeshipSeedUsd <= 0)
  ) {
    throw new Error('APPRENTICESHIP_SEED_USD must be a positive finite USD amount when set.')
  }
  if (cfg.autonomousDryRun && cfg.apprenticeshipSeedUsd === undefined) {
    throw new Error(
      'AUTONOMOUS_DRY_RUN=true requires APPRENTICESHIP_SEED_USD — simulated capital must be granted explicitly by the principal.',
    )
  }
  if (cfg.apprenticeshipWakeCron !== undefined) {
    if (cfg.apprenticeshipWakeCron.trim().split(/\s+/).length !== 5) {
      throw new Error(
        'APPRENTICESHIP_WAKE_CRON must be exactly a 5-field cron expression (minute granularity).',
      )
    }
    if (!cfg.autonomousDryRun || !cfg.dryRun) {
      throw new Error(
        'APPRENTICESHIP_WAKE_CRON requires AUTONOMOUS_DRY_RUN=true and DRY_RUN=true.',
      )
    }
    if (cfg.telegram.adminChatId === undefined) {
      throw new Error(
        'APPRENTICESHIP_WAKE_CRON requires TELEGRAM_ADMIN_CHAT_ID so scheduled runs have an authorized conversation lane.',
      )
    }
  }
  if (cfg.telegram.botToken !== '' && cfg.telegram.principalUserId === undefined) {
    throw new Error(
      'Telegram ingress requires TELEGRAM_PRINCIPAL_USER_ID to bind system owner identity (set a positive numeric Telegram user ID, or leave TELEGRAM_BOT_TOKEN unset/empty)',
    )
  }
  // Hard day-one safety invariant: real execution requires an MCP wallet backend.
  if (!cfg.dryRun && !WALLET_BACKENDS.includes(cfg.executionMode as WalletBackend)) {
    throw new Error(
      'Refusing to start: DRY_RUN=false requires EXECUTION_MODE=coinbase-mcp or cobo-mcp. ' +
        'Real execution requires the external MCP wallet lane (MCP_COMMAND, MCP_ALLOWED_TOOLS).',
    )
  }
  if (!cfg.dryRun && WALLET_BACKENDS.includes(cfg.executionMode as WalletBackend)) {
    if (cfg.mcp.command === undefined) {
      throw new Error('DRY_RUN=false requires MCP_COMMAND (the external MCP wallet server to launch).')
    }
    if (cfg.mcp.allowedTools.length === 0) {
      throw new Error('DRY_RUN=false requires MCP_ALLOWED_TOOLS (explicit allowlist of server tools — deny by default).')
    }
  }
  if (cfg.selftest) return // selftest may lack tokens/keys
  if (!cfg.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required (copy .env.example to .env).')
  }
  // codex lane: the OAuth keyfile (data/state/codex-auth.json) is the credential —
  // the client fails loud with `npm run desk login` when it's missing.
  if (cfg.brain === 'glm' && !cfg.llm.apiKey && cfg.llm.provider !== 'ollama' && !isLocalBaseUrl(cfg.llm.baseUrl)) {
    throw new Error('LLM_API_KEY is required for remote providers (set LLM_API_KEY in .env).')
  }
}

/** Secrets-masked view for logs and selftest output. */
export function describeConfig(cfg: Config): string {
  const mask = (s: string) => (s ? `${s.slice(0, 4)}…${s.slice(-2)}` : '(unset)')
  const lines = [
    `frog-to-toad-agent config`,
    `  dry run        : ${cfg.dryRun ? 'YES — no orders will be signed' : 'NO (real mode)'}`,
    `  autonomous sim : ${cfg.autonomousDryRun ? 'ON — DRY_RUN swap_execute only' : 'off'}`,
    `  sim treasury   : ${
      cfg.apprenticeshipSeedUsd === undefined
        ? '(ungranted)'
        : `$${cfg.apprenticeshipSeedUsd.toFixed(2)} seed`
    }`,
    `  wake cron      : ${cfg.apprenticeshipWakeCron ?? '(off — principal has not granted a clock)'}`,
    `  execution mode : ${cfg.executionMode}`,
    cfg.brain === 'codex'
      ? `  llm            : BRAIN=codex model=${cfg.llm.model} (ChatGPT web-login keyfile — see npm run desk login)`
      : `  llm            : provider=${cfg.llm.provider} model=${cfg.llm.model} baseUrl=${cfg.llm.baseUrl} key=${mask(cfg.llm.apiKey)}`,
    `  telegram       : token=${mask(cfg.telegram.botToken)} adminChatConfigured=${cfg.telegram.adminChatId !== undefined} ownerBindingConfigured=${cfg.telegram.principalUserId !== undefined} groupChatConfigured=${cfg.telegram.groupChatId !== undefined}`,
    `  limits         : perTrade=$${cfg.limits.perTradeUsdMax} daily=$${cfg.limits.dailyUsdMax} approvalTimeout=${cfg.limits.approvalTimeoutSec}s`,
    `  data dir       : ${cfg.paths.dataDir}`,
    `  timezone       : ${cfg.timezone} (principal's local time)`,
    ...(WALLET_BACKENDS.includes(cfg.executionMode as WalletBackend)
      ? [
          `  mcp            : command=${cfg.mcp.command ?? '(unset)'} swapTool=${cfg.mcp.swapTool}`,
          `  mcp allowlist  : ${cfg.mcp.allowedTools.join(', ') || '(empty — nothing registered)'}`,
        ]
      : []),
  ]
  return lines.join('\n')
}

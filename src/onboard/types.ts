/**
 * Onboarding IO surface (§12.7): every step of the wizard speaks through this
 * one record, so tests inject fetch/exec/streams/tmpdirs and the real shell in
 * scripts/desk.ts stays a thin, untested TTY wrapper.
 */
export type ExecResult = { status: number | null; stdout: string; stderr: string }

export type OnboardIo = {
  repoDir: string
  envPath: string
  homeDir: string
  unitPath: string
  unitTemplatePath: string
  logFile: string
  isTty: boolean
  platform: NodeJS.Platform
  fetchImpl: typeof fetch
  /** Spawn a command and capture output (systemctl/loginctl/npm). */
  exec: (cmd: string, args: string[], timeoutMs?: number) => Promise<ExecResult>
  /** Tail of the agent log — injectable so tests never touch the real log. */
  readLogTail: (n: number) => string
  print: (s?: string) => void
  ask: (q: string) => Promise<string>
  askHidden: (q: string) => Promise<string>
  confirm: (q: string, dflt?: boolean) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  /** Injected so wizard-core tests never open a browser or bind a port. */
  runCodexLogin: () => Promise<string>
}

export type ChecklistStatus = 'ok' | 'missing' | 'warn' | 'info'

export type ChecklistResult = {
  status: ChecklistStatus
  /** Short human detail, secrets already masked. */
  detail: string
}

export type ChecklistItem = {
  key: string
  label: string
  required: boolean
  probe?: (io: OnboardIo) => Promise<ChecklistResult>
}

import fs from 'node:fs'
import path from 'node:path'
import { deskRoot } from '../config.js'

/**
 * Codex brain keyfile lane (§12.6) — ChatGPT web-login OAuth tokens.
 *
 * Discipline mirrors an external wallet server: the tokens live in ONE chmod-600
 * keyfile, NEVER in the desk .env, NEVER in chat or logs. The file format is
 * the Codex CLI's own auth.json shape (verified against codex-rs 0.152.0), but
 * it is the DESK'S OWN copy — we never read or write ~/.codex/auth.json, so a
 * desk refresh can never invalidate the CLI's login (refresh-token rotation).
 */

export const CODEX_ISSUER = 'https://auth.openai.com'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CODEX_LOGIN_COMMAND = 'npm run desk login'

/** CLI refresh policy: proactive when access exp is within 5 min (or >8d since last refresh). */
const REFRESH_WINDOW_MS = 5 * 60 * 1000
const PROACTIVE_REFRESH_MAX_AGE_MS = 8 * 86_400_000

export type CodexAuthTokens = {
  id_token: string
  access_token: string
  refresh_token: string
  account_id: string | null
}

/** The Codex CLI auth.json shape — kept byte-compatible on purpose. */
export type CodexAuthFile = {
  auth_mode: 'chatgpt'
  OPENAI_API_KEY: null
  tokens: CodexAuthTokens
  last_refresh: string
}

/** Everything the client/doctor/watchdog need, derived from the keyfile. */
export type CodexAuth = {
  accessToken: string
  refreshToken: string
  accountId: string
  fedramp: boolean
  /** access_token JWT exp (seconds), falling back to the id_token's exp. */
  exp: number | undefined
  lastRefresh: Date | undefined
}

export class CodexAuthPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAuthPermanentError'
  }
}

export function codexKeyfilePath(): string {
  const override = process.env['CODEX_AUTH_FILE']
  if (override !== undefined && override.trim() !== '') return override.trim()
  return path.join(deskRoot(), 'data', 'state', 'codex-auth.json')
}

/** Decode a JWT payload WITHOUT verifying — the CLI does the same; the IdP already vetted it. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1] === undefined) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

type IdTokenClaims = {
  email?: string
  exp?: number
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
    chatgpt_account_is_fedramp?: boolean
  }
}

function readClaims(jwt: string): IdTokenClaims {
  return decodeJwtPayload(jwt) as IdTokenClaims ?? {}
}

export function loadCodexAuth(file: string = codexKeyfilePath()): CodexAuth | undefined {
  const cached = cache.get(file)
  try {
    const stat = fs.statSync(file)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.auth
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CodexAuthFile>
    const tokens = parsed.tokens
    if (
      typeof tokens?.access_token !== 'string' || tokens.access_token === '' ||
      typeof tokens?.refresh_token !== 'string' || tokens.refresh_token === ''
    ) {
      cache.set(file, { mtimeMs: stat.mtimeMs, auth: undefined })
      return undefined
    }
    const idClaims = readClaims(tokens.id_token ?? '')
    const accessExp = readClaims(tokens.access_token).exp
    const authClaims = idClaims['https://api.openai.com/auth']
    const auth: CodexAuth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      // account-id chain (codex-rs manager.rs): stored field first, id_token claim fallback
      accountId: tokens.account_id ?? authClaims?.chatgpt_account_id ?? '',
      fedramp: authClaims?.chatgpt_account_is_fedramp === true,
      exp: accessExp ?? idClaims.exp,
      lastRefresh: parsed.last_refresh ? new Date(parsed.last_refresh) : undefined,
    }
    if (auth.accountId === '') {
      cache.set(file, { mtimeMs: stat.mtimeMs, auth: undefined })
      return undefined
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, auth })
    return auth
  } catch {
    // Missing or unreadable keyfile — same answer either way: no codex auth.
    cache.delete(file)
    return undefined
  }
}

/** mtime-keyed cache so a fresh `desk login` is picked up while the desk runs. */
const cache = new Map<string, { mtimeMs: number; auth: CodexAuth | undefined }>()

export function writeCodexAuth(
  tokens: CodexAuthTokens,
  file: string = codexKeyfilePath(),
): string {
  const payload: CodexAuthFile = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens,
    last_refresh: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Atomic tmp+rename with a 0600 keyfile — the temp file carries the mode so
  // no window exists where the tokens are world-readable.
  const tmp = `${file}.tmp.${process.pid}`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(payload, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  cache.delete(file)
  return file
}

export function needsRefresh(auth: CodexAuth, now: number = Date.now()): boolean {
  const expMs = auth.exp !== undefined ? auth.exp * 1000 : undefined
  if (expMs !== undefined) return now + REFRESH_WINDOW_MS >= expMs
  const last = auth.lastRefresh?.getTime()
  if (last === undefined) return true
  return now - last > PROACTIVE_REFRESH_MAX_AGE_MS
}

/** Local-only status for the doctor brain stage and the watchdog — no network. */
export function codexTokenStatus(file: string = codexKeyfilePath()): {
  present: boolean
  valid: boolean
  refreshable: boolean
  hint?: string
} {
  const auth = loadCodexAuth(file)
  if (auth === undefined) {
    return { present: false, valid: false, refreshable: false, hint: `no keyfile — run: ${CODEX_LOGIN_COMMAND}` }
  }
  const refreshable = auth.refreshToken !== ''
  const expired = needsRefresh(auth)
  return {
    present: true,
    valid: refreshable || !expired,
    refreshable,
    hint: expired
      ? (refreshable ? undefined : `expired and unrefreshable — run: ${CODEX_LOGIN_COMMAND}`)
      : undefined,
  }
}

type RefreshResult = {
  id_token?: string
  access_token?: string
  refresh_token?: string
}

/**
 * Silent refresh + persist. Refresh-token rotation is respected: whatever the
 * server hands back becomes the new keyfile contents. Fails LOUD (with the
 * fix in the message) on permanent failures; transient failures throw a plain
 * error so the caller's retry ladder handles them.
 */
export async function refreshCodexTokens(
  file: string = codexKeyfilePath(),
  fetchImpl: typeof fetch = fetch,
): Promise<CodexAuth> {
  const current = loadCodexAuth(file)
  if (current === undefined) {
    throw new CodexAuthPermanentError(`Codex brain has no keyfile — run: ${CODEX_LOGIN_COMMAND}`)
  }

  const refreshed = await requestRefresh(current.refreshToken, fetchImpl)
  const tokens: CodexAuthTokens = {
    // The CLI keeps the id_token when the refresh response omits one.
    id_token: refreshed.id_token ?? readRawTokens(file)?.id_token ?? '',
    access_token: refreshed.access_token ?? '',
    refresh_token: refreshed.refresh_token ?? current.refreshToken,
    account_id: current.accountId,
  }
  if (tokens.access_token === '') {
    throw new Error('Codex token refresh returned no access_token (transient — will retry)')
  }
  writeCodexAuth(tokens, file)
  const next = loadCodexAuth(file)
  if (next === undefined) throw new Error('Codex keyfile unreadable right after refresh')
  return next
}

function readRawTokens(file: string): CodexAuthTokens | undefined {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as CodexAuthFile).tokens
  } catch {
    return undefined
  }
}

/**
 * The token endpoint accepts the standard form-encoded grant (proven live in
 * ~/coder with this client_id) AND the JSON shape current codex-rs sends —
 * form first, JSON fallback on a 400.
 */
async function requestRefresh(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<RefreshResult> {
  const url = 'https://auth.openai.com/oauth/token'
  const init = (body: string, contentType: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    signal: AbortSignal.timeout(20_000),
  })

  // Standard form-encoded grant first; the JSON shape current codex-rs sends
  // is the fallback (the endpoint flipped content types once before).
  let res = await fetchImpl(
    url,
    init(new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(), 'application/x-www-form-urlencoded'),
  )
  if (res.status === 400) {
    res = await fetchImpl(
      url,
      init(
        JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
        'application/json',
      ),
    )
  }
  await classify(res)
  return (await res.json()) as RefreshResult
}

async function classify(res: Response): Promise<void> {
  if (res.ok) return
  const text = await res.text().catch(() => '')
  // Permanent (codex-rs manager.rs): 401, or 400 invalid_grant — the refresh
  // token is expired/revoked/reused. Re-login is the ONLY fix.
  const permanent = res.status === 401 || (res.status === 400 && /invalid_grant/i.test(text))
  const detail = text.slice(0, 300) || `HTTP ${res.status}`
  if (permanent) {
    throw new CodexAuthPermanentError(`Codex refresh token rejected (${detail}) — re-auth needed: ${CODEX_LOGIN_COMMAND}`)
  }
  throw new Error(`Codex token refresh failed transiently: HTTP ${res.status} ${detail}`)
}

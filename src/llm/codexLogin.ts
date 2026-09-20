import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { CODEX_CLIENT_ID, CODEX_ISSUER, writeCodexAuth } from './codexAuth.js'

/**
 * Codex brain login (§12.6) — the Codex CLI's browser OAuth flow, desk-sized.
 * Verified constants (codex-rs login/src/server.rs + manager.rs, 0.152.0 binary ✓):
 * PKCE S256, loopback server on 127.0.0.1:1455 (fallback 1457), redirect
 * `http://localhost:{port}/auth/callback`, code→tokens via form-urlencoded
 * grant at {issuer}/oauth/token. The principal logs in ONCE in a browser;
 * tokens land in the desk keyfile (chmod 600 — see codexAuth.ts).
 */

export const LOGIN_PORTS = [1455, 1457]
export const LOGIN_WAIT_MS = 5 * 60_000
export const LOGIN_SCOPE = 'openid profile email offline_access'

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthorizeUrl(port: number, challenge: string, state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: `http://localhost:${port}/auth/callback`,
    scope: LOGIN_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    originator: 'codex_cli_rs',
  })
  return `${CODEX_ISSUER}/oauth/authorize?${query.toString()}`
}

/** Validate the callback query against our state; returns the auth code. */
export function handleCallbackQuery(
  query: URLSearchParams,
  expectedState: string,
): { ok: true; code: string } | { ok: false; error: string } {
  const err = query.get('error')
  if (err) {
    const desc = query.get('error_description')
    return { ok: false, error: desc ? `${err}: ${desc}` : err }
  }
  if (query.get('state') !== expectedState) return { ok: false, error: 'state mismatch (CSRF guard) — restart the login' }
  const code = query.get('code')
  if (!code) return { ok: false, error: 'no code in callback' }
  return { ok: true, code }
}

export type TokenExchangeResponse = {
  id_token: string
  access_token: string
  refresh_token: string
}

/** Code → tokens (form-urlencoded, exact codex-rs field set). */
export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenExchangeResponse> {
  const res = await fetchImpl('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  const parsed = (await res.json()) as Partial<TokenExchangeResponse>
  if (!parsed.access_token || !parsed.refresh_token) {
    throw new Error('token exchange response missing access_token/refresh_token')
  }
  return parsed as TokenExchangeResponse
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
  child.on('error', () => {/* headless box — the printed URL is the real path */})
  child.unref()
}

function listenOn(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/**
 * The full flow: bind loopback → authorize URL → browser → callback →
 * exchange → keyfile. Resolves with the keyfile path. Only the principal's
 * email/plan are printed — never token contents.
 */
export async function runCodexLogin(opts: {
  keyfile?: string
  fetchImpl?: typeof fetch
  openBrowser?: boolean
} = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const shouldOpen = opts.openBrowser ?? true

  let server: http.Server | undefined
  let port = 0
  for (const p of LOGIN_PORTS) {
    try {
      server = await listenOn(p)
      port = p
      break
    } catch {
      continue // port taken (stale CLI login server?) — try the fallback
    }
  }
  if (server === undefined) {
    throw new Error(`could not bind login ports ${LOGIN_PORTS.join('/')} on 127.0.0.1 — is another login running?`)
  }

  try {
    const { verifier, challenge } = pkcePair()
    const state = base64Url(randomBytes(32))
    const authUrl = buildAuthorizeUrl(port, challenge, state)

    const waitCallback = new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('login timed out after 5 min — run it again')), LOGIN_WAIT_MS)
      server!.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404).end()
          return
        }
        clearTimeout(timer)
        const verdict = handleCallbackQuery(url.searchParams, state)
        if (!verdict.ok) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end(`Login failed: ${verdict.error}`)
          reject(new Error(verdict.error))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body><h3>Frog brain forged.</h3><p>Login complete — you can close this window.</p></body></html>')
        resolve({ code: verdict.code, redirectUri: `http://localhost:${port}/auth/callback` })
      })
    })

    console.log(`listening on 127.0.0.1:${port} — opening browser for ChatGPT login…`)
    console.log(`If the browser does not open, paste this URL into any browser:\n  ${authUrl}`)
    if (shouldOpen) openBrowser(authUrl)
    const { code, redirectUri } = await waitCallback

    const tokens = await exchangeCodeForTokens(code, verifier, redirectUri, fetchImpl)
    return writeCodexAuth(
      {
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id: null,
      },
      opts.keyfile,
    )
  } finally {
    server.close()
  }
}
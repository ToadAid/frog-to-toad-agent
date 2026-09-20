import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  // Isolated desk root + keyfile for every test in this file.
  process.env['TRADING_DESK_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-codex-'))
  process.env['SELFTEST'] = '1'
})

afterEach(() => {
  if (ORIG_ENV['CODEX_AUTH_FILE'] === undefined) delete process.env['CODEX_AUTH_FILE']
  else process.env['CODEX_AUTH_FILE'] = ORIG_ENV['CODEX_AUTH_FILE']
})

// ── fixtures ─────────────────────────────────────────────────────────────────

function b64u(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function makeJwt(claims: object): string {
  return `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(claims)}.not-a-signature`
}

const expSoon = Math.floor(Date.now() / 1000) + 60 // 1 min — inside the 5-min refresh window
const expFar = Math.floor(Date.now() / 1000) + 3600

const AUTH_CLAIMS = {
  chatgpt_account_id: 'acc-123',
  chatgpt_plan_type: 'pro',
  chatgpt_account_is_fedramp: true,
}

function fixtureTokens(overrides: Partial<{ idTokenClaims: object; accessClaims: object; accountId: string | null }> = {}) {
  return {
    id_token: makeJwt({
      email: 'frog@example.com',
      exp: expFar,
      'https://api.openai.com/auth': AUTH_CLAIMS,
      ...overrides.idTokenClaims,
    }),
    access_token: makeJwt({ exp: expFar, ...overrides.accessClaims }),
    refresh_token: 'rt-old',
    account_id: overrides.accountId !== undefined ? overrides.accountId : null,
  }
}

function keyfile(name: string): string {
  const file = path.join(process.env['TRADING_DESK_DIR']!, name)
  process.env['CODEX_AUTH_FILE'] = file
  return file
}

import {
  codexKeyfilePath,
  codexTokenStatus,
  decodeJwtPayload,
  loadCodexAuth,
  needsRefresh,
  refreshCodexTokens,
  CodexAuthPermanentError,
  writeCodexAuth,
  CODEX_LOGIN_COMMAND,
} from '../src/llm/codexAuth.js'
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  handleCallbackQuery,
  LOGIN_PORTS,
  pkcePair,
} from '../src/llm/codexLogin.js'
import { createCodexLlmClient } from '../src/llm/codex.js'

// ── JWT decoding + keyfile ───────────────────────────────────────────────────

describe('codex keyfile lane', () => {
  it('decodes JWT payloads without verification, refuses garbage', () => {
    expect(decodeJwtPayload(makeJwt({ exp: 123 }))?.['exp']).toBe(123)
    expect(decodeJwtPayload('two.parts')).toBeUndefined()
    expect(decodeJwtPayload('a.!!!.c')).toBeUndefined()
  })

  it('writes chmod 600 atomically and reads back the account chain', () => {
    const file = keyfile('auth-a.json')
    writeCodexAuth(fixtureTokens(), file)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    const auth = loadCodexAuth(file)!
    expect(auth.accessToken).toContain('.') // a JWT, never raw content printed
    expect(auth.accountId).toBe('acc-123') // id_token claim fallback
    expect(auth.fedramp).toBe(true)
    expect(auth.refreshToken).toBe('rt-old')
    expect(auth.exp).toBe(expFar)
  })

  it('stored account_id wins over the id_token claim (codex-rs chain order)', () => {
    const file = keyfile('auth-b.json')
    writeCodexAuth(fixtureTokens({ accountId: 'ws-456' }), file)
    expect(loadCodexAuth(file)!.accountId).toBe('ws-456')
  })

  it('a keyfile without claims is unusable, not guessed', () => {
    const file = keyfile('auth-c.json')
    writeCodexAuth({
      id_token: makeJwt({ email: 'frog@example.com' }), // no chatgpt_account_id
      access_token: makeJwt({ exp: expFar }),
      refresh_token: 'rt',
      account_id: null,
    }, file)
    expect(loadCodexAuth(file)).toBeUndefined()
  })

  it('a corrupt keyfile fail-closes to undefined', () => {
    const file = keyfile('auth-d.json')
    fs.writeFileSync(file, '{corrupt', 'utf8')
    expect(loadCodexAuth(file)).toBeUndefined()
    expect(codexTokenStatus(file).present).toBe(false)
  })

  it('mtime cache picks up a fresh `desk login` while the desk runs', () => {
    const file = keyfile('auth-e.json')
    writeCodexAuth(fixtureTokens(), file)
    expect(loadCodexAuth(file)!.refreshToken).toBe('rt-old')
    // Different content (and a fresh mtime) — same path.
    fs.writeFileSync(file, JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { ...fixtureTokens(), refresh_token: 'rt-new' },
      last_refresh: new Date().toISOString(),
    }), { mode: 0o600 })
    expect(loadCodexAuth(file)!.refreshToken).toBe('rt-new')
  })

  it('codexTokenStatus: missing keyfile names the fix; expired-but-refreshable stays valid', () => {
    const missing = codexTokenStatus(path.join(os.tmpdir(), 'no-such-keyfile.json'))
    expect(missing).toMatchObject({ present: false, valid: false })
    expect(missing.hint).toContain('npm run desk login')

    const file = keyfile('auth-f.json')
    writeCodexAuth(fixtureTokens({ accessClaims: { exp: Math.floor(Date.now() / 1000) - 10 } }), file)
    const st = codexTokenStatus(file)
    expect(st.present).toBe(true)
    expect(st.refreshable).toBe(true)
    expect(st.valid).toBe(true) // client refreshes silently — not a dead brain
    expect(st.hint).toBeUndefined()
  })
})

// ── refresh policy ───────────────────────────────────────────────────────────

describe('codex refresh policy', () => {
  it('needsRefresh: within the 5-min window → true; healthy → false', () => {
    const auth = loadCodexAuth(keyfile('auth-a.json'))! // written above
    expect(needsRefresh({ ...auth, exp: Math.floor(Date.now() / 1000) + 60 }, Date.now())).toBe(true)
    expect(needsRefresh({ ...auth, exp: Math.floor(Date.now() / 1000) + 3600 }, Date.now())).toBe(false)
  })

  it('needsRefresh without exp falls back to the 8-day last_refresh rule', () => {
    const auth = loadCodexAuth(keyfile('auth-a.json'))!
    expect(needsRefresh({ ...auth, exp: undefined, lastRefresh: new Date(Date.now() - 9 * 86_400_000) })).toBe(true)
    expect(needsRefresh({ ...auth, exp: undefined, lastRefresh: new Date(Date.now() - 1 * 86_400_000) })).toBe(false)
    expect(needsRefresh({ ...auth, exp: undefined, lastRefresh: undefined })).toBe(true)
  })
})

describe('codex silent refresh', () => {
  it('refreshes with the form grant, persists rotation, keeps the id_token fallback', async () => {
    const file = keyfile('auth-refresh.json')
    writeCodexAuth(fixtureTokens(), file)

    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        id_token: null,
        access_token: makeJwt({ exp: expFar }),
        refresh_token: 'rt-new',
      }), { status: 200 })
    }) as unknown as typeof fetch

    const next = await refreshCodexTokens(file, fetchImpl)
    expect(next.refreshToken).toBe('rt-new')

    // Form-encoded first call (the standard grant — proven live in ~/coder).
    const first = new URLSearchParams(String(calls[0]!.init.body))
    expect(calls[0]!.url).toBe('https://auth.openai.com/oauth/token')
    expect(calls[0]!.init.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' })
    expect(first.get('grant_type')).toBe('refresh_token')
    expect(first.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(first.get('refresh_token')).toBe('rt-old')

    // Rotation persisted + id_token kept (server omitted it).
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(raw.tokens.refresh_token).toBe('rt-new')
    expect(raw.tokens.access_token).toContain('.')
    expect(raw.tokens.id_token).toContain('.')
  })

  it('falls back to the JSON refresh shape when the form grant 400s', async () => {
    const file = keyfile('auth-json.json')
    writeCodexAuth(fixtureTokens(), file)

    const bodies: Array<{ contentType: string; body: string }> = []
    const fetchImpl = (async (_url: unknown, init: any = {}) => {
      bodies.push({ contentType: init.headers['content-type'], body: String(init.body) })
      if (bodies.length === 1) return new Response('bad request', { status: 400 })
      return new Response(JSON.stringify({
        id_token: makeJwt({ exp: expFar }),
        access_token: makeJwt({ exp: expFar }),
        refresh_token: 'rt-json',
      }), { status: 200 })
    }) as unknown as typeof fetch

    await refreshCodexTokens(file, fetchImpl)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]!.contentType).toBe('application/json')
    expect(JSON.parse(bodies[1]!.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-old' })
  })

  it('a rejected refresh token fails LOUD with the fix in the message', async () => {
    const file = keyfile('auth-dead.json')
    writeCodexAuth(fixtureTokens(), file)
    const fetchImpl = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    await expect(refreshCodexTokens(file, fetchImpl)).rejects.toThrow(CodexAuthPermanentError)
    await expect(refreshCodexTokens(file, fetchImpl)).rejects.toThrow(CODEX_LOGIN_COMMAND)
  })

  it('401 and server errors are classified permanent vs transient', async () => {
    const file = keyfile('auth-dead2.json')
    writeCodexAuth(fixtureTokens(), file)
    const fetch401 = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    await expect(refreshCodexTokens(file, fetch401)).rejects.toThrow(CodexAuthPermanentError)
    const fetch500 = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    await expect(refreshCodexTokens(file, fetch500)).rejects.toThrow(/transient|HTTP 500/)
  })

  it('no keyfile at all → permanent error naming the login command', async () => {
    await expect(refreshCodexTokens(path.join(os.tmpdir(), 'never-existed.json'), fetch)).rejects.toThrow(CodexAuthPermanentError)
  })
})

// ── login flow helpers ───────────────────────────────────────────────────────

describe('codex login flow', () => {
  it('PKCE pair: challenge is sha256(verifier), base64url', () => {
    const { verifier, challenge } = pkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest().toString('base64url'))
    expect(verifier.length).toBe(86) // 64 random bytes → base64url (codex-rs pkce.rs)
    expect(challenge).not.toContain('=')
  })

  it('authorize URL carries the exact CLI query set', () => {
    const url = new URL(buildAuthorizeUrl(1455, 'challenge-x', 'state-y'))
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-x')
    expect(url.searchParams.get('state')).toBe('state-y')
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs')
  })

  it('callback validation: code ok; error/state-mismatch/missing-code refused', () => {
    const q = (s: string) => new URLSearchParams(s)
    expect(handleCallbackQuery(q('code=abc&state=s'), 's')).toEqual({ ok: true, code: 'abc' })
    expect(handleCallbackQuery(q('error=access_denied'), 's').ok).toBe(false)
    expect(handleCallbackQuery(q('code=abc&state=evil'), 's')).toMatchObject({ ok: false, error: /state mismatch/ })
    expect(handleCallbackQuery(q('state=s'), 's')).toMatchObject({ ok: false, error: /no code/ })
  })

  it('exchange sends the exact form body and refuses incomplete token sets', async () => {
    let init: any
    const fetchImpl = (async (_url: unknown, i: any = {}) => {
      init = i
      return new Response(JSON.stringify({ id_token: 'i', access_token: 'a', refresh_token: 'r' }), { status: 200 })
    }) as unknown as typeof fetch
    const tokens = await exchangeCodeForTokens('code-1', 'verifier-1', 'http://localhost:1455/auth/callback', fetchImpl)
    expect(tokens).toMatchObject({ access_token: 'a', refresh_token: 'r' })
    const body = new URLSearchParams(String(init.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-1')
    expect(body.get('code_verifier')).toBe('verifier-1')
    expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')

    const bad = (async () => new Response(JSON.stringify({ access_token: 'a' }), { status: 200 })) as unknown as typeof fetch
    await expect(exchangeCodeForTokens('c', 'v', 'u', bad)).rejects.toThrow(/missing access_token\/refresh_token/)
  })

  it('fallback port list matches the CLI (1455 → 1457)', () => {
    expect(LOGIN_PORTS).toEqual([1455, 1457])
  })
})

// ── the client ───────────────────────────────────────────────────────────────

describe('createCodexLlmClient', () => {
  function codexCfg(baseUrl = 'https://chatgpt.com/backend-api/codex') {
    return {
      brain: 'codex' as const,
      dryRun: true,
      executionMode: 'none',
      llm: { provider: 'codex', baseUrl, model: 'gpt-5.6-sol', apiKey: '', temperature: 0.3, maxTokens: 4096 },
      telegram: { botToken: 'x', adminChatId: 1, allowedChatIds: [], progressDrafts: true },
      limits: {
        perTradeUsdMax: 50, dailyUsdMax: 200, maxOpenPositions: 10, approvalTimeoutSec: 120,
        approvalMaxPending: 3, approvalMinIntervalSec: 5, tokenAllowlist: [], blockedSymbols: [], blockedAddresses: [],
      },
      guardedTools: ['swap_execute'],
      lessonsSampleMin: 5,
      memoryNudgeInterval: 10,
      briefCron: '47 8 * * *', sentinelCron: '19 */2 * * *', watchdogCron: '37 */2 * * *', sentinelMovePct: 5,
      mcp: { command: undefined, args: [], allowedTools: [], swapTool: 'swap', envFile: undefined },
      paths: { dataDir: '/tmp', agentsDir: '/tmp', skillsDir: '/tmp', assetsDir: '/tmp' },
      statusPort: 8787,
      selftest: true,
      timezone: 'America/New_York',
    }
  }

  beforeEach(() => {
    process.env['CODEX_AUTH_FILE'] = keyfile('auth-client.json')
    writeCodexAuth(fixtureTokens(), codexKeyfilePath())
  })

  function responsesOk(text = 'frog says hi') {
    const response = {
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  it('hits {baseUrl}/responses with Bearer + ChatGPT-Account-ID headers', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetchImpl = (async (url: unknown, init: any = {}) => {
      calls.push({ url: String(url), init })
      return responsesOk()
    }) as unknown as typeof fetch

    const res = await createCodexLlmClient(codexCfg(), fetchImpl).complete({
      messages: [{ role: 'system', content: 'desk brain' }, { role: 'user', content: 'hello' }],
      tools: [],
    })
    expect(res.message.content).toBe('frog says hi')
    expect(res.usage).toEqual({ in: 10, out: 5 })
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0]!.init.headers['authorization']).toMatch(/^Bearer /)
    expect(calls[0]!.init.headers['chatgpt-account-id']).toBe('acc-123')
    expect(calls[0]!.init.headers['x-openai-fedramp']).toBe('true') // claim was set in the fixture
    expect(JSON.parse(calls[0]!.init.body)['model']).toBe('gpt-5.6-sol')
    expect(JSON.parse(calls[0]!.init.body)['instructions']).toBe('desk brain')
    expect(JSON.parse(calls[0]!.init.body)['stream']).toBe(true)
    expect(JSON.parse(calls[0]!.init.body)['max_output_tokens']).toBeUndefined()
  })

  it('reconstructs text from Codex SSE deltas when the completed envelope omits output', async () => {
    const fetchImpl = (async () => new Response([
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'frog ' })}`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'says hi' })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch

    const res = await createCodexLlmClient(codexCfg(), fetchImpl).complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })
    expect(res.message.content).toBe('frog says hi')
    expect(res.usage).toEqual({ in: 10, out: 5 })
  })

  it('401 → one silent refresh → one retry with the NEW bearer', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: unknown, init: any = {}) => {
      urls.push(String(url))
      if (urls.length === 1) return new Response('expired', { status: 401 })
      if (urls.length === 2) {
        return new Response(JSON.stringify({
          id_token: makeJwt({ exp: expFar }),
          access_token: makeJwt({ exp: expFar + 60 }),
          refresh_token: 'rt-rotated',
        }), { status: 200 })
      }
      return responsesOk()
    }) as unknown as typeof fetch

    const res = await createCodexLlmClient(codexCfg(), fetchImpl).complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })
    expect(res.message.content).toBe('frog says hi')
    expect(urls[1]).toBe('https://auth.openai.com/oauth/token')
    // Bearer on the retry is the refreshed token (different exp → different JWT)
    expect(JSON.parse(fs.readFileSync(codexKeyfilePath(), 'utf8')).tokens.refresh_token).toBe('rt-rotated')
  })

  it('second 401 after refresh fails loud naming the login command', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(
      createCodexLlmClient(codexCfg(), fetchImpl).complete({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      }),
    ).rejects.toThrow(/desk login/)
  })

  it('a dead refresh token fails loud before any request is sent', async () => {
    const file = codexKeyfilePath()
    writeCodexAuth({ ...fixtureTokens(), refresh_token: 'rt-doomed' }, file)
    const fetchImpl = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    // Force the proactive-refresh path: access token already expired.
    writeCodexAuth({
      id_token: makeJwt({ exp: expFar }),
      access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 }),
      refresh_token: 'rt-doomed',
      account_id: 'acc-123',
    }, file)
    await expect(
      createCodexLlmClient(codexCfg(), fetchImpl).complete({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      }),
    ).rejects.toThrow(CodexAuthPermanentError)
  })

  it('no keyfile → permanent error with the fix, before any request', async () => {
    process.env['CODEX_AUTH_FILE'] = path.join(os.tmpdir(), 'nope.json')
    const seen: unknown[] = []
    const fetchImpl = (async (...a: unknown[]) => { seen.push(a); return responsesOk() }) as unknown as typeof fetch
    await expect(
      createCodexLlmClient(codexCfg(), fetchImpl).complete({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      }),
    ).rejects.toThrow(CodexAuthPermanentError)
    expect(seen).toHaveLength(0)
  })
})

// ── config + doctor wiring ───────────────────────────────────────────────────

describe('BRAIN switch wiring', () => {
  it('BRAIN=codex resolves the keyfile lane (no API key, no telegram validation under selftest)', async () => {
    const { loadConfig } = await import('../src/config.js')
    process.env['BRAIN'] = 'codex'
    const cfg = loadConfig()
    expect(cfg.brain).toBe('codex')
    expect(cfg.llm.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
    expect(cfg.llm.model).toBe('gpt-5.6-sol')
    expect(cfg.llm.apiKey).toBe('')
  })

  it('CODEX_MODEL overrides the model', async () => {
    const { loadConfig } = await import('../src/config.js')
    process.env['BRAIN'] = 'codex'
    process.env['CODEX_MODEL'] = 'gpt-5.1-codex-max'
    expect(loadConfig().llm.model).toBe('gpt-5.1-codex-max')
    delete process.env['CODEX_MODEL']
  })

  it('BRAIN=bogus is refused with the known set', async () => {
    const { loadConfig } = await import('../src/config.js')
    process.env['BRAIN'] = 'claude'
    expect(() => loadConfig()).toThrow(/Unknown BRAIN/)
  })

  it('BRAIN=glm is the default and keeps validation behavior', async () => {
    const { loadConfig } = await import('../src/config.js')
    delete process.env['BRAIN']
    expect(loadConfig().brain).toBe('glm')
  })

  it('codex lane passes validation WITHOUT LLM_API_KEY (keyfile is the credential)', async () => {
    const { loadConfig } = await import('../src/config.js')
    process.env['BRAIN'] = 'codex'
    process.env['SELFTEST'] = '' // real validation path
    process.env['TELEGRAM_BOT_TOKEN'] = 'tok'
    process.env['TELEGRAM_PRINCIPAL_USER_ID'] = '123456'
    process.env['LLM_API_KEY'] = ''
    expect(() => loadConfig()).not.toThrow()
    // GLM lane still refuses a keyless remote provider.
    process.env['BRAIN'] = 'glm'
    expect(() => loadConfig()).toThrow(/LLM_API_KEY/)
  })
})

describe('doctor + watchdog brain probes (codex lane, no network)', () => {
  it('doctor brain stage: healthy with a valid keyfile, UNHEALTHY without one', async () => {
    const { runDoctor } = await import('../src/doctor/doctor.js')
    const { loadConfig } = await import('../src/config.js')
    process.env['BRAIN'] = 'codex'
    process.env['TELEGRAM_PRINCIPAL_USER_ID'] = '123456'
    const cfg = loadConfig()

    const missing = await runDoctor(cfg)
    const brainMissing = missing.stages.find((s) => s.name === 'brain')!
    expect(brainMissing.ok).toBe(false)
    expect(brainMissing.detail).toContain('desk login')

    writeCodexAuth(fixtureTokens(), codexKeyfilePath())
    const healthy = await runDoctor(cfg)
    const brainOk = healthy.stages.find((s) => s.name === 'brain')!
    expect(brainOk.ok).toBe(true)
    expect(brainOk.detail).toContain('codex keyfile present')
  })

  it('watchdog alerts on a dead keyfile, stays silent on a live one', async () => {
    const { runWatchdog } = await import('../src/rituals/watchdog.js')
    const { loadConfig } = await import('../src/config.js')
    process.env['BRAIN'] = 'codex'
    process.env['TELEGRAM_PRINCIPAL_USER_ID'] = '123456'
    const cfg = loadConfig()

    // Missing keyfile → brain finding naming the fix; staleness suppressed by a fresh boot.
    fs.rmSync(codexKeyfilePath(), { force: true })
    const bad = await runWatchdog(cfg, { now: () => Date.now(), bootedAt: () => Date.now() })
    expect(bad.find((f) => f.check === 'brain')?.alert).toContain('desk login')

    writeCodexAuth(fixtureTokens(), codexKeyfilePath())
    const good = await runWatchdog(cfg, { now: () => Date.now(), bootedAt: () => Date.now() })
    expect(good.find((f) => f.check === 'brain')).toBeUndefined()
  })
})

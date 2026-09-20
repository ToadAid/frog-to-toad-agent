/**
 * Telegram probes for onboarding (§12.7): plain fetch against the Bot API —
 * no grammy here, so the wizard can verify a token BEFORE any bot process
 * exists, and tests inject fetchImpl. Hard rule: the token appears only
 * inside the request line — every error string passes through sanitize() so
 * an accidental echo of the URL can never leak the token into a message.
 */

const API_BASE = 'https://api.telegram.org'
const PROBE_TIMEOUT_MS = 15_000

export type TelegramProbe = { ok: boolean; username?: string; error?: string }

/** Strip any accidental occurrence of the token (or its URL form) from a message. */
export function sanitizeToken(token: string, message: string): string {
  return message.split(`bot${token}`).join('bot•••').split(token).join('•••')
}

function describeStatus(status: number): string {
  if (status === 401) return 'invalid token (Telegram rejected it)'
  if (status === 404) return 'token malformed (check the BotFather token)'
  if (status === 429) return 'rate-limited — retry in a moment'
  return `HTTP ${status}`
}

/** GET /getMe — validates the token without side effects (safe alongside a
 * polling bot, but onboarding runs this pre-boot anyway). */
export async function probeBotToken(token: string, fetchImpl: typeof fetch = fetch): Promise<TelegramProbe> {
  try {
    const res = await fetchImpl(`${API_BASE}/bot${token}/getMe`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return { ok: false, error: describeStatus(res.status) }
    const raw = (await res.json()) as { result?: { username?: string } }
    const username = raw.result?.username
    if (username === undefined) return { ok: false, error: 'unexpected getMe response' }
    return { ok: true, username }
  } catch (e) {
    return { ok: false, error: sanitizeToken(token, e instanceof Error ? e.message : String(e)) }
  }
}

export type DiscoveryResult = { chatId?: number; principalUserId?: number; name?: string; error?: string }

type TgUpdate = {
  message?: {
    chat?: { id?: number; first_name?: string; title?: string }
    from?: { id?: number; first_name?: string }
  }
  channel_post?: unknown
  edited_message?: unknown
  callback_query?: unknown
}

/**
 * Watch getUpdates for a real user message and extract its chat id — the
 * automated form of the .env.example bootstrap trick ("message your bot once,
 * the desk echoes your chat id"). Accepts only `update.message` (NOT
 * channel_post / edited_message / callback_query). A 409 means some other
 * process (the live desk) is already polling — that is a distinct error the
 * caller turns into the manual-entry path; it is never retried here.
 */
export async function discoverAdminChatId(
  token: string,
  opts: { timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
  let offset = 0
  while (Date.now() < deadline) {
    const pollTimeoutSec = Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)))
    try {
      const res = await fetchImpl(
        `${API_BASE}/bot${token}/getUpdates?timeout=${pollTimeoutSec}${offset > 0 ? `&offset=${offset}` : ''}`,
        { signal: AbortSignal.timeout((pollTimeoutSec + 10) * 1000) },
      )
      if (res.status === 409) return { error: 'conflict' }
      if (!res.ok) return { error: describeStatus(res.status) }
      const raw = (await res.json()) as { result?: TgUpdate[] }
      const updates = raw.result ?? []
      for (const u of updates) {
        offset = Math.max(offset, (u as unknown as { update_id?: number }).update_id ?? 0) + 1
        if (u.message?.chat?.id !== undefined && u.message.from?.id !== undefined) {
          const name = u.message.from?.first_name ?? u.message.chat.first_name ?? u.message.chat.title
          return { chatId: u.message.chat.id, principalUserId: u.message.from.id, name }
        }
      }
      if (updates.length > 0) {
        // Acknowledge non-message updates so they don't re-arrive; keep polling.
        await fetchImpl(`${API_BASE}/bot${token}/getUpdates?offset=${offset}`).catch(() => undefined)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('TimeoutError') || msg.includes('aborted')) continue // long-poll timeout — keep watching
      return { error: sanitizeToken(token, msg) }
    }
  }
  return { error: 'no message arrived before the deadline' }
}

/** The handshake check: sendMessage the wizard's greeting to the admin chat. */
export async function sendOnboardingPing(
  token: string,
  chatId: number,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(`${API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: describeStatus(res.status) }
    const raw = (await res.json()) as { ok?: boolean }
    if (raw.ok === false) return { ok: false, error: 'Telegram refused the message' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: sanitizeToken(token, e instanceof Error ? e.message : String(e)) }
  }
}

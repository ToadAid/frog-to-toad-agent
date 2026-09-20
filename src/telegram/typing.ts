/**
 * Typing indicator keepalive (the OpenClaw pattern, desk-sized): Telegram's
 * "typing…" status expires after ~5s, so while the agent works we re-fire
 * sendChatAction on an interval. Guardrails: a failure budget (stop after N
 * consecutive failures instead of spamming), a TTL (never type forever), and
 * unref'd timers so a stuck indicator can't hold the process open.
 */

const DEFAULT_INTERVAL_MS = 5_000 // Telegram expires the status in ~5s
const DEFAULT_MAX_FAILURES = 2
const DEFAULT_TTL_MS = 60_000 // hard stop — no infinite typing

export type TypingIndicator = {
  start: (chatId: number) => void
  stop: () => void
}

export type TypingApi = {
  sendChatAction: (chatId: number, action: 'typing') => Promise<unknown>
}

export function createTypingIndicator(
  api: TypingApi,
  timerOpts?: { intervalMs?: number; maxFailures?: number; ttlMs?: number; log?: (msg: string) => void },
): TypingIndicator {
  const intervalMs = timerOpts?.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxFailures = timerOpts?.maxFailures ?? DEFAULT_MAX_FAILURES
  const ttlMs = timerOpts?.ttlMs ?? DEFAULT_TTL_MS
  const log = timerOpts?.log

  let interval: ReturnType<typeof setInterval> | undefined
  let ttl: ReturnType<typeof setTimeout> | undefined
  let stopped = true
  let failures = 0

  async function fire(chatId: number): Promise<void> {
    try {
      await api.sendChatAction(chatId, 'typing')
      failures = 0
    } catch (err) {
      failures += 1
      // A dead sendChatAction must not loop forever — trip the budget.
      log?.(`typing indicator failed (${failures}/${maxFailures}): ${err instanceof Error ? err.message : String(err)}`)
      if (failures >= maxFailures) stop()
    }
  }

  function start(chatId: number): void {
    stop() // one indicator per run — restart cleanly
    stopped = false
    void fire(chatId)
    interval = setInterval(() => {
      if (stopped) return
      void fire(chatId)
    }, intervalMs)
    interval.unref?.()
    ttl = setTimeout(() => {
      if (!stopped) {
        log?.(`typing indicator TTL exceeded (${ttlMs}ms) — auto-stopping`)
        stop()
      }
    }, ttlMs)
    ttl.unref?.()
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    clearInterval(interval)
    clearTimeout(ttl)
    interval = undefined
    ttl = undefined
  }

  return { start, stop }
}
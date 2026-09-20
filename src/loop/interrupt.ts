/** Per-chat AbortControllers so /stop can interrupt a run mid-flight. */
const active = new Map<number, AbortController>()

export function register(chatId: number, runId: string): AbortController {
  // One live run per chat (the bot serializes runs); replace any stale controller.
  active.set(chatId, new AbortController())
  void runId
  const controller = active.get(chatId)
  if (!controller) throw new Error('interrupt: controller vanished')
  return controller
}

export function abort(chatId: number): boolean {
  const controller = active.get(chatId)
  if (!controller) return false
  controller.abort()
  return true
}

/** Kill switch: abort EVERY active run. Returns how many were stopped. */
export function abortAll(): number {
  const n = active.size
  for (const controller of active.values()) controller.abort()
  return n
}

export function release(chatId: number, controller: AbortController): void {
  if (active.get(chatId) === controller) active.delete(chatId)
}
import { log } from './log.js'

export type FetchJsonOptions = {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  retries?: number
}

/** fetch + JSON with timeout, retry on 429/5xx (honoring Retry-After), clear errors. */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 20_000, retries = 2 } = opts
  let lastError = 'unknown error'

  for (let attempt = 0; attempt <= retries; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      })
      if (res.ok) {
        return (await res.json()) as T
      }
      const retryAfter = res.headers.get('retry-after')
      lastError = `HTTP ${res.status} from ${url}: ${(await res.text()).slice(0, 300)}`
      if (res.status === 429 || res.status >= 500) {
        const waitMs =
          retryAfter !== null && Number.isFinite(Number(retryAfter))
            ? Number(retryAfter) * 1000
            : 1000 * 2 ** attempt
        if (attempt < retries) {
          log.warn(`fetchJson retry ${attempt + 1}/${retries} in ${waitMs}ms: ${lastError}`)
          await sleep(waitMs)
          continue
        }
      }
      throw new Error(lastError)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('HTTP ')) throw err
      lastError = err instanceof Error ? err.message : String(err)
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw new Error(`${url} failed after ${retries + 1} attempts: ${lastError}`)
    }
  }
  throw new Error(lastError) // unreachable
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
import { z } from 'zod'
import { defineTool } from './registry.js'
import { handsGateOpen } from '../doctor/doctor.js'
import { log } from '../log.js'

/**
 * Browser tool (Phase 12.5) — a keyless fetch lane: URL → page → readable
 * text. The desk's news/feeds lanes hit known APIs; this one opens arbitrary
 * pages the frog is pointed at (or finds), which makes it the desk's most
 * exposed mouth — so it is guarded like the approval gate:
 *
 *  - SSRF guard: DNS is resolved FIRST and checked against private ranges —
 *    the status server on 127.0.0.1 must never be reachable from an agent URL
 *  - redirects are followed MANUALLY, re-checking every hop (redirect is the
 *    classic SSRF bypass)
 *  - http(s) only, HTML/text content types only (no binaries into context)
 *  - size cap + readability strip (scripts/styles/tags out, title + text + links in)
 *  - timeout; failures are honest, never fabricated content
 */

export const FETCH_TIMEOUT_MS = 20_000
export const MAX_BYTES = 96 * 1024
const LINKS_MAX = 20

export function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local (cloud metadata, e.g. 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true // ULA + link-local
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7)) // v4-mapped
  return false
}

/** Resolve a hostname and refuse private/loopback targets (SSRF guard). */
export async function assertPublicHost(hostname: string): Promise<void> {
  const { lookup } = await import('node:dns')
  const results = await new Promise<{ address: string }[]>((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err)
      else resolve(addresses as Array<{ address: string }>)
    })
  })
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      throw new Error(`SSRF guard: ${hostname} resolves to a private address (${r.address})`)
    }
  }
  if (results.length === 0) throw new Error(`SSRF guard: ${hostname} resolves to nothing`)
}

/** Strip fetched HTML down to what a brain can use: title, text, links. */
export function htmlToText(html: string): { title: string; text: string; links: string[] } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = decodeEntities((titleMatch?.[1] ?? '').trim()).slice(0, 200)
  const links: string[] = []
  for (const m of [...html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]) {
    const label = decodeEntities(m[2]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    links.push(`${label ? label + ' → ' : ''}${m[1]}`)
    if (links.length >= LINKS_MAX) break
  }
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  text = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
  return { title, text: text.slice(0, MAX_BYTES), links }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '�'
      return String.fromCodePoint(code)
    })
}

const OK_CONTENT_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml', 'text/markdown']

/** One checked hop: resolve → SSRF check → fetch (no auto-redirect). */
async function checkedFetch(url: URL, signal: AbortSignal): Promise<Response> {
  await assertPublicHost(url.hostname)
  return fetch(url, { redirect: 'manual', signal })
}

export const browserFetchTool = defineTool({
  name: 'browser_fetch',
  description:
    'Fetch a public web page and return readable text (title, body text, first links). HTML/text only, size-capped. ' +
    'Private/internal addresses are refused (SSRF guard). Respect robots.txt and site terms — this is a polite reader, not a scraper.',
  danger: 'readonly',
  input: z.object({
    url: z.string().url().describe('the page to fetch (http/https)'),
  }),
  execute: async (input, ctx) => {
    if (!handsGateOpen(ctx.cfg)) {
      return { text: '[error] hands are gated: doctor is unhealthy or has never run a full check (npm run doctor).' }
    }
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return { text: `[error] not a valid URL: ${input.url}` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { text: `[error] only http/https URLs are allowed (got ${url.protocol})` }
    }
    const signal = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ctx.signal])
    let res: Response
    let current = url
    try {
      // Manual redirect loop — every hop re-runs the SSRF check (the classic
      // bypass is a public URL that 302s to 127.0.0.1 or 169.254.169.254).
      for (let hop = 0; hop < 5; hop++) {
        res = await checkedFetch(current, signal)
        const location = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && location) {
          current = new URL(location, current)
          continue
        }
        break
      }
      if (res!.status >= 300 && res!.status < 400) {
        return { text: '[error] too many redirects (5 hop cap) — refusing to follow further' }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { text: `[error] fetch failed: ${msg}` }
    }
    const status = res!.status
    const contentType = (res!.headers.get('content-type') ?? '').toLowerCase()
    if (status < 200 || status >= 400) {
      return { text: `[error] HTTP ${status} from ${current.host}` }
    }
    const mime = contentType.split(';')[0]!.trim()
    if (!OK_CONTENT_TYPES.some((t) => mime === t || mime.startsWith(t))) {
      return { text: `[error] refusing non-text content type '${contentType.trim() || 'unknown'}' — HTML/text only` }
    }
    const buf = Buffer.from(await res!.arrayBuffer())
    if (buf.length > MAX_BYTES) {
      return { text: `[error] page is ${buf.length} bytes — over the ${MAX_BYTES}-byte cap` }
    }
    const raw = buf.toString('utf8')
    if (raw.includes('\0')) {
      return { text: `[error] content looks binary — refusing` }
    }
    void ctx
    const isHtml = mime.includes('html')
    const { title, text: body, links } = isHtml
      ? htmlToText(raw)
      : { title: current.pathname, text: raw.slice(0, MAX_BYTES), links: [] as string[] }
    return {
      text:
        `🌐 ${title || current.host} — ${current.href}\n(HTTP ${status}, ${buf.length} bytes)\n\n${body}` +
        (links.length > 0 ? `\n\nLinks:\n${links.map((l) => `  • ${l}`).join('\n')}` : ''),
    }
  },
})
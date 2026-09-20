import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { isPrivateIp, assertPublicHost, htmlToText, browserFetchTool } from '../src/tools/browser.js'
import { doctorStatePath } from '../src/doctor/doctor.js'

// ── Seams ────────────────────────────────────────────────────────────────────
// node:dns is mocked so SSRF tests never touch a real resolver; fetch is
// stubbed per-test so redirect/binary/oversize paths are all synthetic.

const dnsState = vi.hoisted(() => ({
  addresses: [{ address: '93.184.216.34' }] as Array<{ address: string }>,
  err: null as Error | null,
}))
vi.mock('node:dns', () => ({
  lookup: (
    host: string,
    _opts: unknown,
    cb: (err: Error | null, res: Array<{ address: string }>) => void,
  ) => {
    if (dnsState.err) return cb(dnsState.err, [])
    // real resolvers answer an IP literal with itself — mirror that so the
    // SSRF guard's own behavior (not the mock) is what's under test
    const isIpLiteral = host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    cb(null, isIpLiteral ? [{ address: host }] : dnsState.addresses)
  },
}))

let cfg: Config

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-browser-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

beforeEach(() => {
  // open hands gate — gate-closed behavior is covered in hands.test.ts
  const file = doctorStatePath(cfg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ lastRunTs: Date.now(), cheapOk: true, lastTestGreenAt: Date.now() }))
  dnsState.addresses = [{ address: '93.184.216.34' }]
  dnsState.err = null
})

const ctx = () =>
  ({
    cfg,
    agent: { name: 'test-agent' },
    runId: 't',
    chatId: 0,
    signal: new AbortController().signal,
    notify: async () => {},
    requestApproval: async () => 'deny' as const,
    callSubagent: async () => '',
    send: {},
  }) as unknown as Parameters<typeof browserFetchTool.execute>[1]

/** Minimal fake Response — just what browser.ts touches. */
function fakeRes(init: { status?: number; location?: string; contentType?: string; body?: string }): Response {
  const headers = new Map<string, string>()
  if (init.location !== undefined) headers.set('location', init.location)
  if (init.contentType !== undefined) headers.set('content-type', init.contentType)
  return {
    status: init.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => new TextEncoder().encode(init.body ?? '').buffer,
  } as unknown as Response
}

describe('12.5 — SSRF guard', () => {
  it('isPrivateIp covers the dangerous ranges (incl. cloud metadata)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip)).toBe(true)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1', '100.128.0.1']) {
      expect(isPrivateIp(ip)).toBe(false)
    }
  })

  it('refuses a hostname that resolves private — even mixed with public answers', async () => {
    dnsState.addresses = [{ address: '8.8.8.8' }, { address: '192.168.1.10' }]
    await expect(assertPublicHost('mixed.example.com')).rejects.toThrow(/SSRF guard.*192\.168\.1\.10/)
  })

  it('refuses a hostname that resolves to nothing', async () => {
    dnsState.addresses = []
    await expect(assertPublicHost('nx.example.com')).rejects.toThrow(/resolves to nothing/)
  })

  it('passes a genuinely public hostname', async () => {
    await expect(assertPublicHost('example.com')).resolves.toBeUndefined()
  })

  it('dns failure is refused, not passed through', async () => {
    dnsState.err = new Error('EAI_AGAIN')
    await expect(assertPublicHost('flaky.example.com')).rejects.toThrow('EAI_AGAIN')
  })
})

describe('12.5 — browser_fetch', () => {
  it('refuses non-http(s) schemes without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await browserFetchTool.execute({ url: 'file:///etc/passwd' }, ctx())
    expect(r.text).toContain('only http/https')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('refuses a URL whose DNS points private — before any request', async () => {
    dnsState.addresses = [{ address: '169.254.169.254' }] // cloud metadata
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await browserFetchTool.execute({ url: 'https://evil.example.com/creds' }, ctx())
    expect(r.text).toContain('SSRF guard')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('a public URL that redirects to a private one is refused at the redirect hop', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeRes({ status: 302, location: 'http://127.0.0.1:8787/kill' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await browserFetchTool.execute({ url: 'https://open.example.com/redirect' }, ctx())
    expect(r.text).toContain('SSRF guard')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://open.example.com/redirect')
    vi.unstubAllGlobals()
  })

  it('a redirect hop to a PUBLIC page is followed and rendered', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeRes({ status: 301, location: '/final' }))
      .mockResolvedValueOnce(
        fakeRes({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html><title>Final</title><p>landed here</p></html>' }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const r = await browserFetchTool.execute({ url: 'https://a.example.com/start' }, ctx())
    expect(r.text).toContain('Final')
    expect(r.text).toContain('landed here')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]![0])).toBe('https://a.example.com/final')
    vi.unstubAllGlobals()
  })

  it('an endless redirect chain is capped at 5 hops', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(fakeRes({ status: 302, location: '/next' })))
    vi.stubGlobal('fetch', fetchMock)
    const r = await browserFetchTool.execute({ url: 'https://loop.example.com/a' }, ctx())
    expect(r.text).toContain('too many redirects')
    expect(fetchMock).toHaveBeenCalledTimes(5)
    vi.unstubAllGlobals()
  })

  it('non-text content types are refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes({ status: 200, contentType: 'application/json', body: '{"a":1}' })))
    const r = await browserFetchTool.execute({ url: 'https://api.example.com/data' }, ctx())
    expect(r.text).toContain('refusing non-text content type')
    vi.unstubAllGlobals()
  })

  it('HTTP errors are reported honestly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes({ status: 404 })))
    const r = await browserFetchTool.execute({ url: 'https://gone.example.com/x' }, ctx())
    expect(r.text).toContain('HTTP 404')
    vi.unstubAllGlobals()
  })

  it('oversize and binary bodies are refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes({ status: 200, contentType: 'text/html', body: 'x'.repeat(97 * 1024) })))
    const big = await browserFetchTool.execute({ url: 'https://big.example.com/x' }, ctx())
    expect(big.text).toContain('over the')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fakeRes({ status: 200, contentType: 'text/html', body: 'ok\0hidden' }),
    ))
    const bin = await browserFetchTool.execute({ url: 'https://bin.example.com/x' }, ctx())
    expect(bin.text).toContain('looks binary')
    vi.unstubAllGlobals()
  })

  it('happy path: HTML is stripped to title, text, and links', async () => {
    const html = '<html><head><title>The Page</title></head><body><p>Real content here</p><a href="/more">More</a></body></html>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes({ status: 200, contentType: 'text/html', body: html })))
    const r = await browserFetchTool.execute({ url: 'https://ok.example.com/page' }, ctx())
    expect(r.text).toContain('The Page')
    expect(r.text).toContain('Real content here')
    expect(r.text).toContain('/more')
    vi.unstubAllGlobals()
  })
})

describe('12.5 — htmlToText', () => {
  it('strips scripts/styles/comments, keeps text + links, decodes entities', () => {
    const out = htmlToText(
      '<html><head><title>Hi</title><style>body{}</style></head><body>' +
        '<script>alert(1)</script><p>Hello &amp; world</p><a href="/x">Link one</a><a href="/y">Two</a></body></html>',
    )
    expect(out.title).toBe('Hi')
    expect(out.text).toContain('Hello & world')
    expect(out.text).not.toContain('alert(1)')
    expect(out.text).not.toContain('body{}')
    expect(out.links[0]).toContain('Link one')
    expect(out.links[0]).toContain('/x')
    expect(out.links.length).toBe(2)
  })

  it('numeric and named entities decode', () => {
    const { text } = htmlToText('<p>&#65;&#66;&nbsp;&copy;</p>')
    expect(text).toContain('AB')
  })

  it('link labels are tag-stripped', () => {
    const { links } = htmlToText('<a href="/q"><b>Bold</b> label</a>')
    expect(links[0]).toContain('Bold label')
    expect(links[0]).not.toContain('<b>')
  })
})
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { startStatusServer } from '../src/status/http.js'
import { clearChartCache } from '../src/status/chart.js'
import { DASHBOARD_HTML } from '../src/status/dashboardHtml.js'
import { appendJsonl } from '../src/store/jsonl.js'
import { forecastsPath } from '../src/market/forecastGrader.js'

// Same seam as dashboardExtras.test.ts: every external feed goes through the
// mocked fetchJson — no network in tests. Binance klines + coingecko prices
// are served; everything else throws (the research panels degrade gracefully).
const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))

let dir = ''
let cfg: Config
let server: http.Server
let base = ''

const ADMIN = 4321
const TOKEN = '123:ABCsecretTOKEN'
const source = Object.assign(() => ({ activeRuns: 0, pendingApprovals: 0, lastRunAt: undefined }), {
  submitPrompt: undefined as undefined | ((text: string, images?: string[]) => void),
})

/** 300 hourly candles, oscillating so every indicator has warmup data. */
function klines(): number[][] {
  const out: number[][] = []
  const start = Date.now() - 300 * 3600_000
  for (let i = 0; i < 300; i++) {
    const close = 100 + Math.round(Math.sin(i / 12) * 20) + i * 0.1
    out.push([
      start + i * 3600_000, // ms
      close - 2, // open
      close + 3, // high
      close - 4, // low
      close, // close
      1000 + i, // volume
    ])
  }
  return out
}

const CONTRACT = `0x${'ab'.repeat(20)}`
const CONTRACT_POOL = `0x${'cd'.repeat(20)}`

/** GeckoTerminal OHLCV rows, NEWEST first (wire order) — 300 hourly candles. */
function gtRows(n = 300): number[][] {
  const endSec = Math.floor(Date.now() / 1000)
  const out: number[][] = []
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.1
    out.push([endSec - (n - 1 - i) * 3600, close * 0.998, close * 1.002, close * 0.995, close, 900 + i])
  }
  return out.reverse()
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-tabs-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  process.env['TELEGRAM_ADMIN_CHAT_ID'] = String(ADMIN)
  process.env['TELEGRAM_PRINCIPAL_USER_ID'] = String(ADMIN)
  process.env['TELEGRAM_BOT_TOKEN'] = TOKEN
  process.env['LLM_API_KEY'] = 'sk-supersecret'
  cfg = { ...loadConfig(), statusPort: 0 }
  fetchJsonMock.mockImplementation(async (url?: string) => {
    if (url === undefined) return {} // phantom vitest hook
    const u = typeof url === 'string' ? url : ''
    if (u.includes('/api/v3/klines')) return klines()
    if (u.includes('/market_chart')) return { prices: klines().map((k) => [k[0], k[4]]) }
    if (u.includes('api.exchange.coinbase.com')) return { price: '120.00' }
    // DexScreener: the CONTRACT fixture has a Base pool; any other address
    // trades on ethereum only (the Base-only refusal case).
    if (u.includes('dexscreener.com')) {
      if (u.toLowerCase().includes(CONTRACT)) {
        return {
          pairs: [
            {
              chainId: 'base',
              dexId: 'uniswap',
              pairAddress: CONTRACT_POOL,
              baseToken: { address: CONTRACT, name: 'Toby', symbol: 'TOBY' },
              liquidity: { usd: 26000 },
            },
          ],
        }
      }
      const addr = u.split('/tokens/')[1] ?? 'unknown'
      return {
        pairs: [
          {
            chainId: 'ethereum',
            dexId: 'uniswap',
            pairAddress: `0x${'11'.repeat(20)}`,
            baseToken: { address: addr, name: 'Elsewhere', symbol: 'ELS' },
            liquidity: { usd: 5000 },
          },
        ],
      }
    }
    if (u.includes('geckoterminal.com')) return { data: { attributes: { ohlcv_list: gtRows() } } }
    throw new Error(`unexpected url: ${u}`)
  })

  // Transcripts: admin chat + a side chat, with a corrupt line to skip.
  const tdir = path.join(dir, 'data', 'transcript')
  fs.mkdirSync(tdir, { recursive: true })
  fs.writeFileSync(
    path.join(tdir, `${ADMIN}.jsonl`),
    [
      JSON.stringify({ ts: 1, message: { role: 'user', content: 'hello frog' } }),
      'CORRUPT LINE',
      JSON.stringify({ ts: 2, message: { role: 'assistant', content: 'gm', tool_calls: [{ function: { name: 'market_technicals' } }] } }),
      JSON.stringify({ ts: 3, message: { role: 'user', content: 'see chart', images: ['data:image/png;base64,xx'] } }),
      JSON.stringify({ ts: 4, note: 'transcript notes are not chat turns' }),
      JSON.stringify({ ts: 5, message: { role: 'tool', tool_call_id: 't1', content: 'x'.repeat(3000) } }),
    ].join('\n'),
    'utf8',
  )
  fs.writeFileSync(
    path.join(tdir, '999.jsonl'),
    JSON.stringify({ ts: 1, message: { role: 'user', content: 'side chat' } }) + '\n',
    'utf8',
  )

  // One issued forecast for the Kronos tab.
  fs.mkdirSync(path.dirname(forecastsPath(cfg)), { recursive: true })
  appendJsonl(forecastsPath(cfg), {
    id: 'BTC-hourly-1',
    symbol: 'BTC',
    interval: 'hourly',
    issuedAt: Date.now() - 3600_000,
    issuedPrice: 100,
    horizonCandles: 12,
    candleMs: 3_600_000,
    bandLow: 98,
    bandHigh: 105,
    p50: 102,
    pUp: 0.7,
    movePct: 2,
  })

  server = startStatusServer(cfg, source)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
  clearChartCache()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('GET /chart', () => {
  it('serves candles + indicator series + the dossier (mocked binance klines)', async () => {
    clearChartCache()
    const res = await fetch(`${base}/chart?symbol=BTC&interval=hourly`)
    expect(res.status).toBe(200)
    const v = (await res.json()) as Record<string, unknown>
    expect(v.source).toBe('binance')
    expect(v.closeOnly).toBe(false)
    expect((v.candles as unknown[]).length).toBe(300)
    // series are point-or-null arrays aligned to the candles
    expect((v.ema20 as unknown[]).length).toBe(300)
    expect((v.ema20 as unknown[])[0]).toBeNull() // NaN before EMA20 warmup
    const e20tail = (v.ema20 as Array<{ value: number } | null>).slice(-1)[0]
    expect(e20tail).not.toBeNull()
    expect((v.rsi as unknown[]).length).toBe(300)
    const macd = v.macd as { line: unknown[]; signal: unknown[]; histogram: unknown[] }
    expect(macd.histogram.filter((p) => p !== null).length).toBeGreaterThan(0)
    const bb = v.boll as { upper: unknown[] }
    expect(bb.upper.filter((p) => p !== null).length).toBe(281) // 300 - 20 + 1
    const d = v.dossier as Record<string, unknown>
    expect(d.candles).toBe(300)
    expect(Array.isArray(d.notes)).toBe(true)
    expect((v.majors as string[]).length).toBeGreaterThan(3)
  })

  it('caches: a second identical hit does not re-fetch the feed', async () => {
    clearChartCache()
    const callsBefore = fetchJsonMock.mock.calls.length
    await fetch(`${base}/chart?symbol=ETH&interval=hourly`)
    const afterFirst = fetchJsonMock.mock.calls.length
    expect(afterFirst).toBeGreaterThan(callsBefore)
    await fetch(`${base}/chart?symbol=ETH&interval=hourly`)
    expect(fetchJsonMock.mock.calls.length).toBe(afterFirst)
  })

  it('rejects bad params; any feed-servable ticker now charts (the majors list is gone)', async () => {
    expect((await fetch(`${base}/chart?symbol=BTC&interval=weekly`)).status).toBe(400)
    // QQQQ used to be refused as "not a tracked symbol" — Binance klines serve it now
    const q = (await (await fetch(`${base}/chart?symbol=QQQQ&interval=hourly`)).json()) as Record<string, unknown>
    expect(q.source).toBe('binance')
  })

  it('charts a Base contract address — pinpointed to its pool, resolution cached', async () => {
    clearChartCache()
    const callsBefore = fetchJsonMock.mock.calls.length
    const res = await fetch(`${base}/chart?symbol=${CONTRACT}&interval=hourly`)
    expect(res.status).toBe(200)
    const v = (await res.json()) as Record<string, unknown>
    expect(v.source).toBe('geckoterminal')
    expect(v.closeOnly).toBe(false) // true OHLCV from the pool, not close-only
    expect(v.symbol).toBe(CONTRACT) // verbatim — never uppercased
    expect(v.pairAddress).toBe(CONTRACT_POOL)
    expect(v.label).toBe('Toby (TOBY)')
    expect(v.liquidityUsd).toBe(26000)
    expect((v.candles as unknown[]).length).toBe(300)
    // repeat hit: DexScreener resolution happened inside the cached computation
    const afterFirst = fetchJsonMock.mock.calls.length
    expect(afterFirst).toBeGreaterThan(callsBefore)
    await fetch(`${base}/chart?symbol=${CONTRACT}&interval=hourly`)
    expect(fetchJsonMock.mock.calls.length).toBe(afterFirst)
  })

  it('refuses a contract with no Base pool — 502 naming the chains it trades on', async () => {
    clearChartCache()
    const res = await fetch(`${base}/chart?symbol=${`0x${'ef'.repeat(20)}`}&interval=hourly`)
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).toMatch(/no Base pool/)
    expect(text).toMatch(/ethereum/)
  })
})

describe('GET /threads (chat transcript read-back)', () => {
  it('defaults to the admin chat, skips notes + corrupt lines, caps tool content', async () => {
    const res = await fetch(`${base}/threads`)
    expect(res.status).toBe(200)
    const v = (await res.json()) as { chats: Array<Record<string, unknown>>; chatId: number; messages: Array<Record<string, unknown>> }
    expect(v.chatId).toBe(ADMIN)
    // admin chat listed first even though the side chat is newer
    expect(v.chats[0]).toMatchObject({ chatId: ADMIN, isAdmin: true })
    // corrupt line skipped, transcript note skipped, 4 real messages kept
    expect(v.messages.length).toBe(4)
    const withTools = v.messages.find((m) => m.role === 'assistant')
    expect((withTools!.tools as string[])[0]).toBe('market_technicals')
    const withImg = v.messages.find((m) => m.role === 'user' && m.imageCount)
    expect(withImg!.imageCount).toBe(1)
    const toolMsg = v.messages.find((m) => m.role === 'tool')
    expect(String(toolMsg!.content).length).toBeLessThanOrEqual(2030)
    expect(String(toolMsg!.content)).toContain('…(')
  })

  it('?chat= selects another chat; garbage chat falls back to the admin default', async () => {
    const side = (await (await fetch(`${base}/threads?chat=999`)).json()) as { chatId: number; messages: unknown[] }
    expect(side.chatId).toBe(999)
    expect(side.messages.length).toBe(1)
    const fallback = (await (await fetch(`${base}/threads?chat=garbage`)).json()) as { chatId: number }
    expect(fallback.chatId).toBe(ADMIN)
  })
})

describe('POST /prompt with an image (vision lane, same caps as Telegram)', () => {
  it('passes a whitelisted image to the submit lane as a data URI', async () => {
    const seen: Array<{ text: string; images?: string[] }> = []
    source.submitPrompt = (text, images) => seen.push({ text, images })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64')
    const res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'what do you see?', imageBase64: png, imageMime: 'image/png' }),
    })
    expect(res.status).toBe(202)
    expect(seen.length).toBe(1)
    expect(seen[0]!.images![0]).toBe(`data:image/png;base64,${png}`)
    expect(seen[0]!.text).toBe('what do you see?')
  })

  it('rejects a non-whitelisted mime and an oversized image', async () => {
    const badMime = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', imageBase64: Buffer.from('x').toString('base64'), imageMime: 'text/html' }),
    })
    expect(badMime.status).toBe(400)
    const big = Buffer.alloc(5 * 1024 * 1024 + 2, 1).toString('base64')
    const oversize = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', imageBase64: big, imageMime: 'image/png' }),
    })
    expect(oversize.status).toBe(413)
  })
})

describe('GET /research + /kronos', () => {
  it('research degrades panel-by-panel when feeds die (no network here)', async () => {
    const res = await fetch(`${base}/research`)
    expect(res.status).toBe(200)
    const v = (await res.json()) as Record<string, unknown>
    expect(v.fng).toBeUndefined() // mock throws for this host → panel empty, not the endpoint
    expect(Array.isArray(v.news)).toBe(true)
    expect(Array.isArray(v.journal)).toBe(true)
    expect(v.lessons).toBeNull() // no lessons.md in the tmpdir
    expect(Array.isArray(v.recentGrades)).toBe(true)
  })

  it('kronos: records + accuracy + lane liveness', async () => {
    const res = await fetch(`${base}/kronos`)
    expect(res.status).toBe(200)
    const v = (await res.json()) as Record<string, unknown>
    const recs = v.records as Array<Record<string, unknown>>
    expect(recs.length).toBe(1)
    expect(recs[0]).toMatchObject({ symbol: 'BTC', p50: 102, bandLow: 98 })
    // lane liveness is honest about the repo's own runner (kronos-server/run.sh)
    expect(v.laneReady).toBe(fs.existsSync(path.join(process.cwd(), 'kronos-server', 'run.sh')))
    expect((v.majors as string[]).length).toBeGreaterThan(3)
    const acc = v.accuracy as Record<string, unknown>
    expect(acc.issued).toBe(1) // issued but not yet at horizon → nothing graded
    expect(acc.graded).toBe(0)
  })
})

describe('POST /halt + /resume (the persisted state machine)', () => {
  it('halts, persists, shows in /settings, resumes', async () => {
    const halt = await fetch(`${base}/halt`, { method: 'POST' })
    expect(halt.status).toBe(200)
    const h = (await halt.json()) as { deskState: { state: string; reason?: string } }
    expect(h.deskState.state).toBe('HALTED')
    expect(h.deskState.reason).toBe('dashboard HALT')
    // persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'desk_state.json'), 'utf8'))
    expect(onDisk.state).toBe('HALTED')

    const settings = (await (await fetch(`${base}/settings`)).json()) as Record<string, unknown>
    expect((settings.deskState as Record<string, unknown>).state).toBe('HALTED')
    expect((settings.doctor as Record<string, unknown>).handsOpen).toBe(false)
    expect(settings.adminConfigured).toBe(true)
    // settings must never carry secrets
    expect(JSON.stringify(settings)).not.toContain(TOKEN)
    expect(JSON.stringify(settings)).not.toContain('sk-supersecret')
    expect((settings as Record<string, unknown>).apiKey).toBeUndefined()

    const resume = await fetch(`${base}/resume`, { method: 'POST' })
    expect(resume.status).toBe(200)
    const r = (await resume.json()) as { deskState: { state: string } }
    expect(r.deskState.state).toBe('ACTIVE')
  })

  it('refuses GET on state-mutating routes', async () => {
    expect((await fetch(`${base}/halt`)).status).toBe(405)
    expect((await fetch(`${base}/resume`)).status).toBe(405)
  })
})

describe('POST /kronos/run (fire-and-forget, one at a time)', () => {
  it('accepts a run and the record lands (mocked klines + a stub runner)', async () => {
    process.env['KRONOS_COMMAND'] = 'node'
    process.env['KRONOS_ARGS'] =
      '-e||console.log(JSON.stringify({ok:true,p50:[100,101],bandLow:99,bandHigh:103,pUp:0.6,horizonMovePct:1,model:"test",sampleCount:2,lookback:300}))'
    process.env['KRONOS_TIMEOUT_MS'] = '15000'
    const res = await fetch(`${base}/kronos/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC', interval: 'hourly' }),
    })
    expect(res.status).toBe(202)
    // second run while the first is live → 409
    const dup = await fetch(`${base}/kronos/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'ETH', interval: 'hourly' }),
    })
    expect(dup.status).toBe(409)
    // wait for the runner (up to ~3s), then the new record must be on disk
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const recs = fs.readFileSync(forecastsPath(cfg), 'utf8').trim().split('\n')
      if (recs.length >= 2) break
    }
    const lines = fs.readFileSync(forecastsPath(cfg), 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(last.symbol).toBe('BTC')
    expect(last.bandLow).toBe(99)
    delete process.env['KRONOS_COMMAND']
    delete process.env['KRONOS_ARGS']
    delete process.env['KRONOS_TIMEOUT_MS']
  })

  it('accepts a CHECKSUMMED contract address — case-significant identity survives intact', async () => {
    process.env['KRONOS_COMMAND'] = 'node'
    process.env['KRONOS_ARGS'] =
      '-e||console.log(JSON.stringify({ok:true,p50:[100,101],bandLow:99,bandHigh:103,pUp:0.6,horizonMovePct:1,model:"test",sampleCount:2,lookback:300}))'
    process.env['KRONOS_TIMEOUT_MS'] = '15000'
    // Mixed-case rendering of CONTRACT — same bytes, case-significant identity.
    const address = `0x${'Ab'.repeat(20)}`
    const res = await fetch(`${base}/kronos/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: address, interval: 'hourly' }),
    })
    expect(res.status).toBe(202)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const lines = fs.readFileSync(forecastsPath(cfg), 'utf8').trim().split('\n')
      if (lines.some((l) => l.toLowerCase().includes(address.toLowerCase()))) break
    }
    const recs = fs
      .readFileSync(forecastsPath(cfg), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const hit = recs.find((r) => String(r.baseAddress).toLowerCase() === address.toLowerCase())
    expect(hit).toBeDefined()
    expect(hit!.baseAddress).toBe(address) // verbatim — uppercasing would break EVM identity
    expect(hit!.pairAddress).toBe(CONTRACT_POOL)
    expect(hit!.label).toBe('Toby (TOBY)')
    delete process.env['KRONOS_COMMAND']
    delete process.env['KRONOS_ARGS']
    delete process.env['KRONOS_TIMEOUT_MS']
  })
})

describe('the page itself', () => {
  it('references the vendored lib once, has all six tabs, and no CDN anywhere', () => {
    expect((DASHBOARD_HTML.match(/\/vendor\/lwc\.js/g) ?? []).length).toBe(1)
    for (const tab of ['tab-desk', 'tab-chat', 'tab-charts', 'tab-research', 'tab-kronos', 'tab-settings']) {
      expect(DASHBOARD_HTML).toContain(`id="${tab}"`)
    }
    // no external hosts, no secrets — the page must work offline forever
    expect(DASHBOARD_HTML).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/)
    expect(DASHBOARD_HTML).not.toContain(TOKEN)
    expect(DASHBOARD_HTML).toContain('kronos')
    expect(DASHBOARD_HTML).toContain('/halt')
  })

  it('serves the vendored chart lib when present, 404 + honest notice when not', async () => {
    const res = await fetch(`${base}/vendor/lwc.js`)
    if (fs.existsSync(path.join(process.cwd(), 'vendor', 'lightweight-charts.standalone.production.js'))) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('javascript')
      const body = await res.text()
      expect(body).toContain('TradingView')
    } else {
      expect(res.status).toBe(404)
      expect(await res.text()).toContain('§12.9')
    }
  })
})

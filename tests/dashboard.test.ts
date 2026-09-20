import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { startStatusServer, emitEvent } from '../src/status/http.js'
import { appendLedger } from '../src/store/positions.js'

// Live price feeds are network-dependent (CoinGecko 429s, Binance geo-blocks)
// — never let a rate limit decide whether the dashboard tests pass.
const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))

let dir = ''
let cfg: Config
let server: http.Server
let base = ''

const source = Object.assign(
  () => ({ activeRuns: 1, pendingApprovals: 2, lastRunAt: 123 }),
  { killAll: () => ({ runsAborted: 1, approvalsDenied: 2, deskState: "HALTED" }) },
)

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-dash-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  fetchJsonMock.mockImplementation(async (url?: string) => {
    if (url === undefined) return {} // phantom vitest hook
    if (typeof url === 'string' && url.includes('api.exchange.coinbase.com') && url.includes('ETH-USD')) {
      return { price: '2500.00' } // coinbase ticker shape
    }
    throw new Error(`unexpected url: ${url}`)
  })
  cfg = { ...loadConfig(), statusPort: 0 } // port 0 = OS picks a free port
  // One simulated open so the dashboard has a position to price.
  appendLedger(cfg, {
    ts: Date.now(),
    type: 'open',
    symbol: 'ETH',
    qty: 0.01,
    entryUsd: 2400,
    dryRun: true,
    rationale: 'dashboard test',
  })
  server = startStatusServer(cfg, source)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('desktop dashboard endpoints', () => {
  it('serves a self-contained dashboard page at /', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('KILL ALL')
    expect(html).toContain("/events")
    expect(html).not.toContain('src="http') // no external scripts — CSP-safe
    expect(html).not.toContain('href="http')
  })

  it('/status includes positions with live marks, PnL and recent ledger', async () => {
    const s = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>
    expect(s.activeRuns).toBe(1)
    expect(s.pendingApprovals).toBe(2)
    const positions = s.positions as Array<Record<string, unknown>>
    expect(positions.length).toBe(1)
    const pos = positions[0]!
    expect(pos.symbol).toBe('ETH')
    // feed chain is mocked above — the mark is deterministic
    expect(pos.markUsd).toBe(2500)
    const ledger = s.recentLedger as Array<Record<string, unknown>>
    expect(ledger.length).toBe(1)
    expect(ledger[0]!.rationale).toBe('dashboard test')
    expect(s.realizedPnlUsd).toBe(0)
  })

  it('POST /kill triggers the kill switch and reports counts', async () => {
    const res = await fetch(`${base}/kill`, { method: 'POST' })
    const r = (await res.json()) as { runsAborted: number; approvalsDenied: number; deskState: string }
    expect(r).toEqual({ runsAborted: 1, approvalsDenied: 2, deskState: 'HALTED' })
  })

  it('GET /kill is refused (405) — the switch is POST-only', async () => {
    const res = await fetch(`${base}/kill`)
    expect(res.status).toBe(405)
  })

  it('SSE /events streams emitted events to listeners', async () => {
    let buffer = ''
    const ctrl = new AbortController()
    const got = (async () => {
      const res = await fetch(`${base}/events`, { signal: ctrl.signal })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      // read until the emitted event lands (first chunk is the hello frame)
      while (!buffer.includes('"kind":"final"')) {
        const chunk = await reader.read()
        if (chunk.value !== undefined) buffer += decoder.decode(chunk.value)
        if (chunk.done) break
      }
      ctrl.abort()
    })()
    // give the listener a moment to register, then emit
    await new Promise((r) => setTimeout(r, 100))
    emitEvent({ kind: 'final', runId: 'x', text: 'done' })
    await got
    expect(buffer).toContain('"kind":"hello"')
    expect(buffer).toContain('"kind":"final"')
  })
})
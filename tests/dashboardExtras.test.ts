import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { startStatusServer } from '../src/status/http.js'
import { appendLedger } from '../src/store/positions.js'
import { appendJsonl } from '../src/store/jsonl.js'
import { taGradesPath } from '../src/market/signalGrader.js'
import { createApprovalGate } from '../src/safety/approvals.js'
import { createNullSender } from '../src/telegram/bot.js'

// Same discipline as dashboard.test.ts: prices come from a mock, not from
// whatever CoinGecko's rate limiter feels like today.
const fetchJsonMock = vi.hoisted(() => vi.fn())
vi.mock('../src/http.js', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))

let dir = ''
let cfg: Config
let server: http.Server
let base = ''

const decided: Array<{ reqId: string; allow: boolean }> = []
const source = Object.assign(
  () => ({ activeRuns: 0, pendingApprovals: 1, lastRunAt: 123 }),
  {
    pendingList: () => [
      {
        reqId: 'abc123',
        tool: 'swap_execute',
        summary: 'Buy 0.001 WETH with USDC on Base',
        danger: 'trade',
        ageSec: 5,
        timeoutSec: 120,
      },
    ],
    decideApproval: (reqId: string, allow: boolean) => {
      decided.push({ reqId, allow })
      return reqId === 'abc123'
    },
  },
)

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-dash2-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = { ...loadConfig(), statusPort: 0 }
  fetchJsonMock.mockImplementation(async (url?: string) => {
    if (url === undefined) return {} // phantom vitest hook
    if (typeof url === 'string' && url.includes('api.exchange.coinbase.com') && url.includes('BTC-USD')) {
      return { price: '50000.00' }
    }
    throw new Error(`unexpected url: ${url}`)
  })

  // Day 1: open ETH. Day 2: open BTC + close the ETH (+$1 realized).
  const day1 = Date.now() - 26 * 3600_000
  const day2 = Date.now() - 3600_000
  appendLedger(cfg, { ts: day1, type: 'open', symbol: 'ETH', qty: 0.01, entryUsd: 2400, dryRun: true, rationale: 'd1 open' })
  appendLedger(cfg, { ts: day2, type: 'open', symbol: 'BTC', qty: 0.0001, entryUsd: 50000, dryRun: false, rationale: 'live open' })
  appendLedger(cfg, { ts: day2, type: 'close', symbol: 'ETH', qty: 0.01, exitUsd: 2500, dryRun: true, rationale: 'd2 close' })

  // One graded signal for the track-record table.
  fs.mkdirSync(path.join(dir, 'data', 'grades'), { recursive: true })
  appendJsonl(taGradesPath(cfg), {
    key: `${day1}:SOL:BUY`,
    symbol: 'SOL',
    signal: 'BUY',
    entryTs: day1,
    entryPrice: 140,
    gradedPrice: 152,
    movePct: 5.0,
    benchSymbol: 'BTC',
    benchMovePct: 1.0,
    alphaPct: 4.0,
    hit: true,
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

describe('dashboard approvals + clarity endpoints', () => {
  it('GET /approvals returns full pending detail', async () => {
    const res = await fetch(`${base}/approvals`)
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<Record<string, unknown>>
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({
      reqId: 'abc123',
      tool: 'swap_execute',
      danger: 'trade',
      timeoutSec: 120,
    })
    expect(String(list[0]!.summary)).toContain('WETH')
  })

  it('POST /approvals answers through the source gate', async () => {
    const res = await fetch(`${base}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reqId: 'abc123', allow: true }),
    })
    expect(res.status).toBe(200)
    expect((await res.json())).toMatchObject({ ok: true, allow: true })
    expect(decided).toEqual([{ reqId: 'abc123', allow: true }])
  })

  it('POST /approvals on an unknown/expired request is 404 (deny by default)', async () => {
    const res = await fetch(`${base}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reqId: 'ghost', allow: true }),
    })
    expect(res.status).toBe(404)
    expect(decided[decided.length - 1]).toEqual({ reqId: 'ghost', allow: true })
  })

  it('POST /approvals with a malformed body is 400', async () => {
    const res = await fetch(`${base}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reqId: 'abc123' }), // missing allow
    })
    expect(res.status).toBe(400)
  })

  it('POST /prompt validates input and 503s without a submit lane', async () => {
    const bad = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    })
    expect(bad.status).toBe(400)
    // The test source has no submitPrompt wired → 503, not a silent drop.
    const noLane = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'what is BTC doing?' }),
    })
    expect(noLane.status).toBe(503)
  })

  it('/status carries pnlHistory, exec summary, unrealized total and recent grades', async () => {
    const s = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>
    // ETH: open 0.01 @ 2400 → close 0.01 @ 2500 = +$1.00 realized, one day point.
    const pnl = s.pnlHistory as Array<{ day: string; realizedUsd: number }>
    expect(pnl.length).toBe(1)
    expect(pnl[0]!.realizedUsd).toBeCloseTo(1.0, 6)
    expect(s.realizedPnlUsd).toBeCloseTo(1.0, 6)

    const exec = s.exec as Record<string, unknown>
    expect(exec.opens).toBe(2)
    expect(exec.closes).toBe(1)
    expect(exec.liveOpens).toBe(1) // the BTC open was dryRun:false
    expect(exec.avgOpenUsd).toBeCloseTo((0.01 * 2400 + 0.0001 * 50000) / 2, 4) // (24+5)/2

    // BTC still open at 0.0001 × mock mark 50000 = $5 value vs $5 cost → $0.00
    expect(s.unrealizedPnlUsd).toBe(0)

    const grades = s.recentGrades as Array<Record<string, unknown>>
    expect(grades.length).toBe(1)
    expect(grades[0]).toMatchObject({ symbol: 'SOL', signal: 'BUY', hit: true, alphaPct: 4 })
  })
})

describe('approval gate — dashboard decide path', () => {
  it('pendingList shows the request; decide() settles it through the same promise', async () => {
    const sender = createNullSender()
    const adminCfg: Config = {
      ...cfg,
      telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111, botToken: 'x' },
    }
    const events: Array<Record<string, unknown>> = []
    const gate = createApprovalGate(adminCfg, sender, (e) => events.push(e as Record<string, unknown>))
    const p = gate({ tool: 'swap_execute', input: {}, summary: 'dash test', danger: 'trade' }, 111, new AbortController().signal)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const list = gate.pendingList()
    expect(list.length).toBe(1)
    expect(list[0]!.tool).toBe('swap_execute')
    expect(list[0]!.summary).toBe('dash test')
    expect(list[0]!.ageSec).toBeLessThanOrEqual(2)
    expect(gate.pendingCount()).toBe(1)
    expect(events.some((e) => e.kind === 'approval_created')).toBe(true)

    expect(gate.decide('ghost', true)).toBe(false) // unknown → false, nothing settled
    expect(gate.decide(list[0]!.reqId, true)).toBe(true)
    await expect(p).resolves.toBe('allow')
    expect(gate.pendingCount()).toBe(0)
    const decidedEvt = events.find((e) => e.kind === 'approval_decided')
    expect(decidedEvt).toMatchObject({ decision: 'allow', via: '(approved on dashboard)' })
  })
})

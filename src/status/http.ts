import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { readLedger } from '../store/positions.js'
import { portfolioView, type PnlPoint } from '../store/portfolioView.js'
import { getUsdPrice } from '../market/feeds.js'
import { signalAccuracy, recentGrades } from '../market/signalGrader.js'
import { log } from '../log.js'
import { DASHBOARD_HTML } from './dashboardHtml.js'
import type { PendingApproval } from '../safety/approvals.js'
import { loadDeskState, setDeskState, type DeskTradingState } from '../safety/deskState.js'
import { readDoctorState, handsGateOpen } from '../doctor/doctor.js'
import { chartView, isChartInterval } from './chart.js'
import { researchView, kronosView, settingsView, threadsView } from './data.js'
import { runForecast } from '../tools/kronos.js'
import { isContractAddress } from '../tools/tokens.js'

/** One Kronos run at a time (the runner is a per-call Python spawn — up to 5 min). */
let kronosRunning = false

/** The vendored chart lib, read once from disk (null = missing → 404 + tab notice). */
let vendorLwc: Buffer | null | undefined

export type DashboardPosition = {
  symbol: string
  tokenAddress?: string
  qty: number
  avgEntryUsd: number
  costBasisUsd: number
  /** Live mark from the feed chain; null when no feed covers the token. */
  markUsd: number | null
  valueUsd: number | null
  unrealizedPnlUsd: number | null
}

/** Cumulative realized PnL, one point per day a close landed (oldest first). */
export type { PnlPoint } from '../store/portfolioView.js'

/** Doctor gate view for /status and the dashboard (Phase 12.0). */
function doctorStatus(cfg: Config): DeskStatus['doctor'] {
  const state = readDoctorState(cfg)
  return {
    cheapOk: state?.cheapOk === true,
    lastRunTs: state?.lastRunTs,
    lastTestGreenAt: state?.lastTestGreenAt,
    handsOpen: handsGateOpen(cfg),
  }
}

export type DeskStatus = {
  dryRun: boolean
  uptimeSec: number
  brain: string
  /** Persisted trading state machine (Nautilus steal #1): ACTIVE / REDUCING / HALTED. */
  deskState: { state: DeskTradingState; since: number; reason?: string }
  caps: { dailyUsedUsd: number; dailyMaxUsd: number; perTradeMaxUsd: number }
  activeRuns: number
  pendingApprovals: number
  openPositions: number
  lastRunAt: number | undefined
  realizedPnlUsd: number
  /** Daily cumulative realized PnL (sparkline) + current unrealized for the label. */
  pnlHistory: PnlPoint[]
  unrealizedPnlUsd: number | null
  exec: { opens: number; closes: number; liveOpens: number; avgOpenUsd: number | null; largestOpenUsd: number | null }
  /** Ledger data holes (fail-closed PnL) — ok:false means the numbers may lie. */
  integrity: { ok: boolean; corruptLines: number; orphanCloses: number; clampedCloses: number }
  /** Doctor gate (Phase 12.0): cheap-stage health + whether the hands tools are open. */
  doctor: { cheapOk: boolean; lastRunTs?: number; lastTestGreenAt?: number; handsOpen: boolean }
  taSignals: {
    graded: number
    hits: number
    hitRatePct: number | null
    avgMovePct: number | null
    avgAlphaPct?: number | null
  }
  recentGrades: Array<{
    symbol: string
    signal: string
    entryTs: number
    entryPrice: number
    gradedPrice: number
    movePct: number
    alphaPct?: number | null
    hit: boolean | null
  }>
  positions: DashboardPosition[]
  recentLedger: Array<{
    ts: number
    type: string
    symbol?: string
    tokenAddress?: string
    qty?: number
    entryUsd?: number
    dryRun: boolean
    rationale?: string
  }>
}

/** Live fields the caller owns (run/approval counters + the kill switch). */
export type StatusSource = (() => Pick<
  DeskStatus,
  'activeRuns' | 'pendingApprovals' | 'lastRunAt'
>) & {
  killAll?: () => { runsAborted: number; approvalsDenied: number; deskState: string }
  /** Dashboard approval detail view + desktop answers (same gate as Telegram). */
  pendingList?: () => PendingApproval[]
  decideApproval?: (reqId: string, allow: boolean) => boolean
  /** TUI chat lane: submit a prompt as the admin, same loop + gates as Telegram. */
  submitPrompt?: (text: string, images?: string[]) => void
  rewindThread?: (n: number) => Promise<{ ok: boolean; text: string; error?: string }>
  threadCheckpoints?: () => Array<{ ts: number; lines: number; preview: string }>
}

/**
 * Local status endpoint + desktop dashboard.
 * GET  /           → dashboard UI (single self-contained page)
 * GET  /status     → JSON snapshot (positions priced live)
 * GET  /approvals  → pending approvals, full detail (dashboard approval view)
 * POST /approvals  → {reqId, allow} — desktop answer through the SAME gate as
 *                    Telegram (deny-default, same settle path, same ledger)
 * GET  /events     → SSE stream of run + approval events
 * POST /kill       → kill switch: abort all runs + deny all pending approvals
 * POST /prompt     → {text, imageBase64?, imageMime?} — TUI/Chat-tab lane (admin)
 * GET  /threads    → transcript read-back (?chat=<id>, admin chat default)
 * GET  /chart      → candles + indicator series (?symbol=BTC&interval=hourly)
 * GET  /research   → signals/journal/lessons/news/sentiment/TVL/stablecoins
 * GET  /kronos     → forecast records + accuracy + lane liveness
 * GET  /settings   → read-only config/doctor/desk-state view
 * POST /halt /resume → the persisted trading state machine (principal-owned)
 * Binds 127.0.0.1 only — never expose this.
 */
export function startStatusServer(cfg: Config, source: StatusSource): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? ''
    const pathname = url.split('?')[0] ?? ''
    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(DASHBOARD_HTML)
        return
      }
      if (req.method === 'GET' && pathname === '/vendor/lwc.js') {
        // The vendored lightweight-charts build (Charts tab). Read from disk at
        // startup — never a CDN. Missing file → 404 and the tab shows a notice.
        if (vendorLwc === undefined) {
          try {
            vendorLwc = fs.readFileSync(path.join(process.cwd(), 'vendor', 'lightweight-charts.standalone.production.js'))
          } catch {
            vendorLwc = null
          }
        }
        if (vendorLwc === null) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('vendor/lightweight-charts.standalone.production.js missing (BUILD_LIST §12.9)')
          return
        }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' })
        res.end(vendorLwc)
        return
      }
      if (pathname === '/status') {
        const snap = { ...(await status(cfg)), ...source() }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(snap, null, 2))
        return
      }
      if (pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(`data: ${JSON.stringify({ kind: 'hello', ts: Date.now() })}\n\n`)
        eventListeners.add(res)
        req.on('close', () => eventListeners.delete(res))
        return
      }
      if (pathname === '/approvals') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(source.pendingList?.() ?? []))
          return
        }
        if (req.method === 'POST') {
          const body = (await readBody(req)) as { reqId?: string; allow?: boolean }
          if (typeof body.reqId !== 'string' || typeof body.allow !== 'boolean') {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'body must be {reqId, allow}' }))
            return
          }
          const ok = source.decideApproval?.(body.reqId, body.allow) ?? false
          if (!ok) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'unknown or expired approval' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, reqId: body.reqId, allow: body.allow }))
          return
        }
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'use GET or POST' }))
        return
      }
      if (pathname === '/prompt') {
        // The TUI's chat lane — the prompt enters the SAME per-chat queue and
        // agent loop as a Telegram message (including the approval gate).
        // Optional image: {imageBase64, imageMime} rides the vision lane with
        // the SAME caps as a Telegram photo (mime whitelist, 5 MB decoded).
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use POST' }))
          return
        }
        const body = (await readBody(req, 8_000_000)) as { text?: unknown; imageBase64?: unknown; imageMime?: unknown }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '' || text.length > 4_000) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'body must be {text: string, 1..4000 chars}' }))
          return
        }
        let images: string[] | undefined
        if (typeof body.imageBase64 === 'string' && body.imageBase64 !== '') {
          const mime = typeof body.imageMime === 'string' ? body.imageMime : ''
          const buf = Buffer.from(body.imageBase64, 'base64')
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) || buf.byteLength === 0) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'imageMime must be image/png|jpeg|webp|gif with a decodable imageBase64' }))
            return
          }
          if (buf.byteLength > 5 * 1024 * 1024) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: `image too large (${(buf.byteLength / 1e6).toFixed(1)} MB — cap 5 MB)` }))
            return
          }
          images = [`data:${mime};base64,${buf.toString('base64')}`]
        }
        if (!source.submitPrompt) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'no admin chat configured — set TELEGRAM_ADMIN_CHAT_ID' }))
          return
        }
        source.submitPrompt(text, images)
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (pathname === '/threads') {
        // Chat tab: transcript read-back (admin chat by default).
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use GET' }))
          return
        }
        const chatParam = new URL(url, 'http://x').searchParams.get('chat')
        const chatId = chatParam !== null && chatParam !== '' ? Number(chatParam) : undefined
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(threadsView(cfg, Number.isFinite(chatId) ? chatId : undefined)))
        return
      }
      if (pathname === '/thread/checkpoints') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use GET' }))
          return
        }
        if (!source.threadCheckpoints) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'no admin chat configured' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ checkpoints: source.threadCheckpoints() }))
        return
      }
      if (pathname === '/thread/rewind') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use POST' }))
          return
        }
        if (!source.rewindThread) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'no admin chat configured' }))
          return
        }
        const body = (await readBody(req)) as { n?: unknown }
        const n = Number(body.n)
        if (!Number.isInteger(n) || n < 1 || n > 1_000) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'body must be {n: integer from 1 to 1000}' }))
          return
        }
        const result = await source.rewindThread(n)
        res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }
      if (pathname === '/chart') {
        // Charts tab: candles + indicator series (any servable ticker or a Base
        // contract, 60s cache — validation happens in chartView's feed verdict).
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use GET' }))
          return
        }
        const params = new URL(url, 'http://x').searchParams
        const raw = (params.get('symbol') ?? '').trim()
        // Contract addresses are case-significant identity — never uppercased.
        const symbol = isContractAddress(raw) ? raw : raw.toUpperCase()
        const interval = params.get('interval') ?? 'hourly'
        if (symbol === '' || symbol.length > 64 || !isChartInterval(interval)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: "symbol must be a ticker or a Base contract address; interval must be 'hourly' or 'daily'" }))
          return
        }
        try {
          const view = await chartView(symbol, interval)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(view))
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }
      if (pathname === '/research') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use GET' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(await researchView(cfg)))
        return
      }
      if (pathname === '/kronos') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use GET' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(kronosView(cfg)))
        return
      }
      if (pathname === '/kronos/run') {
        // "Run forecast now" — 202 immediately, the runner takes up to 5 min
        // (first run downloads model weights). The result lands in the SSE
        // feed AND the admin chat; the record lands in /kronos either way.
        // One at a time — a second request while one runs gets a 409.
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use POST' }))
          return
        }
        if (kronosRunning) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'a forecast is already running — wait for it to finish' }))
          return
        }
        const body = (await readBody(req)) as { symbol?: unknown; interval?: unknown; predLen?: unknown }
        const rawSymbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
        // Contract addresses are case-significant identity — never uppercased.
        const symbol = rawSymbol !== '' && isContractAddress(rawSymbol) ? rawSymbol : rawSymbol.toUpperCase()
        const interval = body.interval === 'daily' ? 'daily' : 'hourly'
        const predLen = Number(body.predLen)
        if (symbol === '') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'body must be {symbol: string}' }))
          return
        }
        kronosRunning = true
        emitEvent({ kind: 'kronos_started', ts: Date.now(), symbol, interval })
        void runForecast(cfg, {
          symbol,
          interval,
          ...(Number.isFinite(predLen) && predLen >= 1 && predLen <= 120 ? { predLen } : {}),
        })
          .then((text) => {
            emitEvent({ kind: 'kronos_result', ts: Date.now(), symbol, interval, ok: !text.startsWith('[error]'), text })
          })
          .catch((err) => {
            emitEvent({ kind: 'kronos_result', ts: Date.now(), symbol, interval, ok: false, text: String(err) })
          })
          .finally(() => {
            kronosRunning = false
          })
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, started: true }))
        return
      }
      if (pathname === '/settings') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use GET' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(settingsView(cfg)))
        return
      }
      if (pathname === '/halt' || pathname === '/resume') {
        // The persisted trading state machine, principal-owned. Same rules as
        // the Telegram commands: HALT is instant and sticky; RESUME re-enables
        // and says so to the admin chat.
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use POST' }))
          return
        }
        const state: DeskTradingState = pathname === '/halt' ? 'HALTED' : 'ACTIVE'
        const reason = pathname === '/halt' ? 'dashboard HALT' : 'dashboard resume'
        const record = setDeskState(cfg, state, reason)
        log.warn(`desk state: ${record.state} (${reason})`)
        emitEvent({ kind: 'desk_state', ts: Date.now(), state: record.state, reason })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, deskState: record }))
        return
      }
      if (pathname === '/kill') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'use POST' }))
          return
        }
        const result = source.killAll?.() ?? { runsAborted: 0, approvalsDenied: 0, deskState: 'HALTED' }
        log.warn(
          `🛑 KILL SWITCH: ${result.runsAborted} run(s) aborted, ${result.approvalsDenied} approval(s) denied — desk ${result.deskState}`,
        )
        emitEvent({ kind: 'kill', ts: Date.now(), ...result })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(404)
      res.end('not found')
    } catch (err) {
      log.error(`status server: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: 'internal' }))
    }
  })
  server.listen(cfg.statusPort, '127.0.0.1', () => {
    log.info(`dashboard: http://127.0.0.1:${cfg.statusPort}/ · status: /status`)
  })
  return server
}

function readBody(req: http.IncomingMessage, maxBytes = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > maxBytes) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    req.on('error', reject)
  })
}

const eventListeners = new Set<http.ServerResponse>()

/** Push a run event to all SSE listeners (called by the run event bus). */
export function emitEvent(event: unknown): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of eventListeners) {
    try {
      res.write(payload)
    } catch {
      eventListeners.delete(res)
    }
  }
}

async function status(cfg: Config): Promise<Omit<DeskStatus, 'activeRuns' | 'pendingApprovals' | 'lastRunAt'>> {
  // One fold, shared with the morning brief (src/store/portfolioView.ts).
  const view = await portfolioView(cfg)
  const positions: DashboardPosition[] = view.positions
  const ledger = readLedger(cfg)
  const recent = ledger.slice(-15).reverse()

  return {
    dryRun: cfg.dryRun,
    uptimeSec: Math.floor(process.uptime()),
    brain: cfg.llm.model,
    deskState: loadDeskState(cfg),
    caps: {
      dailyUsedUsd: view.dailySpendUsd,
      dailyMaxUsd: cfg.limits.dailyUsdMax,
      perTradeMaxUsd: cfg.limits.perTradeUsdMax,
    },
    openPositions: view.positions.length,
    realizedPnlUsd: view.realizedPnlUsd,
    pnlHistory: view.pnlDaily,
    unrealizedPnlUsd: view.unrealizedPnlUsd,
    exec: view.exec,
    integrity: view.integrity,
    doctor: doctorStatus(cfg),
    taSignals: signalAccuracy(cfg),
    recentGrades: recentGrades(cfg, 10).map((g) => ({
      symbol: g.symbol,
      signal: g.signal,
      entryTs: g.entryTs,
      entryPrice: g.entryPrice,
      gradedPrice: g.gradedPrice,
      movePct: g.movePct,
      alphaPct: g.alphaPct ?? null,
      hit: g.hit,
    })),
    positions,
    recentLedger: recent.map((e) => ({
      ts: e.ts,
      type: e.type,
      symbol: e.symbol,
      tokenAddress: e.tokenAddress,
      qty: e.qty,
      entryUsd: e.entryUsd,
      dryRun: e.dryRun,
      rationale: e.rationale,
    })),
  }
}

let lastRunAt: number | undefined

export function noteRunFinished(): void {
  lastRunAt = Date.now()
}

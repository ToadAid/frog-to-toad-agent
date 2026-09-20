import {
  Container,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
} from '@earendil-works/pi-tui'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { loadConfig } from '../config.js'

/**
 * Desk TUI (pi-tui — same engine OpenClaw's TUI runs on) — the desktop
 * communication channel alongside Telegram + the web dashboard. Talks to the
 * desk's own localhost endpoints only: GET /status, SSE /events,
 * GET/POST /approvals, POST /prompt, POST /kill. It is a VIEW + input lane —
 * every privileged action goes through the same gate as Telegram.
 */

// ── ANSI style helpers (no chalk — the desk carries no styling deps) ────────
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`
const green = (s: string) => `\x1b[32m${s}\x1b[39m`
const red = (s: string) => `\x1b[31m${s}\x1b[39m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`
const magenta = (s: string) => `\x1b[35m${s}\x1b[39m`

const MARKDOWN_THEME = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: yellow,
  codeBlock: (s: string) => dim(s),
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: magenta,
  bold,
  italic: dim,
  strikethrough: dim,
  underline: dim,
}

const EDITOR_THEME = {
  borderColor: cyan,
  selectList: {
    selectedPrefix: (s: string) => green(s),
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
}

const MAX_LOG_LINES = 200 // ring buffer — a long soak must not eat the RAM

type PendingApproval = { reqId: string; tool: string; summary: string; danger: string }

function fmtClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input !== 'object') return String(input)
  return Object.entries(input as Record<string, unknown>)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
}

// ── Desk connection ──────────────────────────────────────────────────────────
const cfg = loadConfig()
const base = `http://127.0.0.1:${cfg.statusPort}`

async function deskFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, init)
  const body = (await res.json().catch(() => null)) as unknown
  return { ok: res.ok, status: res.status, body }
}

// ── TUI shell ────────────────────────────────────────────────────────────────
const terminal = new ProcessTerminal()
const tui: TUI = new TuiMainScreen(terminal)

const header = new Text('', 0, 0)
const log = new Container()
const activity = new Text('', 0, 0) // live "what is it doing now" line
const approvalsBox = new Container()
const loader = new Loader(tui, cyan, dim, 'connecting…')
const hint = new Text(
  dim('type a prompt and Enter · /y allow · /n deny · /rewind · /kill · /clear · ctrl+c quit'),
  0,
  0,
)
const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 })

const pending: PendingApproval[] = []

tui.addChild(header)
tui.addChild(new Text(''))
tui.addChild(log)
tui.addChild(activity)
tui.addChild(approvalsBox)
tui.addChild(loader)
tui.addChild(editor)
tui.addChild(hint)

// Ring-buffer discipline (OpenClaw's coalesced-refresh lesson): the log must
// never grow unbounded during a long session.
function pushLine(text: string): Text {
  const c = new Text(text, 0, 0)
  log.addChild(c)
  while (log.children.length > MAX_LOG_LINES) log.removeChild(log.children[0]!)
  tui.requestRender()
  return c
}

function renderApprovals(): void {
  while (approvalsBox.children.length > 0) approvalsBox.removeChild(approvalsBox.children[0]!)
  if (pending.length === 0) {
    tui.requestRender()
    return
  }
  approvalsBox.addChild(new Text(yellow(bold(`🔒 ${pending.length} approval(s) pending`)), 0, 0))
  for (const a of pending) {
    approvalsBox.addChild(
      new Text(
        yellow(`  ${a.reqId.slice(0, 8)} · ${a.tool} · ${a.danger} — ${a.summary}`),
        0,
        0,
      ),
    )
  }
  approvalsBox.addChild(new Text(dim('  /y [id] allow · /n [id] deny'), 0, 0))
  tui.requestRender()
}

// ── Live event feed (SSE) → the chat log ─────────────────────────────────────
/** In-flight ⚙️ lines per tool name — the result event edits them, not appends. */
const pendingToolLines = new Map<string, Text>()

function handleEvent(e: Record<string, unknown>): void {
  const kind = String(e.kind)
  switch (kind) {
    case 'hello':
      pushLine(dim(`desk connected (${base})`))
      loader.stop()
      loader.setMessage(dim('idle — type a prompt'))
      break
    case 'run_started':
      pushLine(cyan(`▶ ${fmtClock(Number(e.ts ?? Date.now()))} run started · ${String(e.agent)}`))
      pendingToolLines.clear()
      loader.start()
      loader.setMessage(dim('working…'))
      activity.setText('')
      break
    case 'tool_call': {
      const tool = String(e.tool)
      const line = pushLine(dim(`  ⚙ ${tool} ${summarizeInput(e.input)}`))
      pendingToolLines.set(tool, line)
      activity.setText(dim(`⚙ ${tool}…`))
      loader.setMessage(dim(`⚙ ${tool}…`))
      break
    }
    case 'tool_result': {
      const tool = String(e.tool)
      const line = pendingToolLines.get(tool)
      const mark = e.ok ? green('  ✔') : red('  ✖')
      if (line) line.setText(`${mark} ${tool} ${e.ok ? '' : 'FAILED'}`)
      pendingToolLines.delete(tool)
      activity.setText('')
      break
    }
    case 'final': {
      const text = String(e.text ?? '')
      pushLine(green(`✔ ${fmtClock(Number(e.ts ?? Date.now()))} final`))
      if (text.trim() !== '') log.addChild(new Markdown(text, 1, 0, MARKDOWN_THEME))
      loader.stop()
      loader.setMessage(dim('idle — type a prompt'))
      activity.setText('')
      break
    }
    case 'error':
      pushLine(red(`✖ error: ${String(e.message)}`))
      loader.stop()
      loader.setMessage(dim('idle — type a prompt'))
      break
    case 'aborted':
      pushLine(yellow('⏹ aborted'))
      loader.stop()
      loader.setMessage(dim('idle — type a prompt'))
      break
    case 'followup':
      pushLine(yellow(`↻ after-turn follow-up r${String(e.round ?? '')}: ${String(e.text ?? '').slice(0, 120)}`))
      break
    case 'task_notification':
      pushLine(yellow(`✉ task-notification r${String(e.round ?? '')}: ${String(e.text ?? '').slice(0, 120)}`))
      break
    case 'budget_continue':
      pushLine(yellow(`🎯 budget continue r${String(e.round ?? '')}: ${String(e.text ?? '').slice(0, 120)}`))
      break
    case 'approval_created':
      pushLine(yellow(`🔒 approval requested · ${String(e.tool ?? '')}`))
      break
    case 'approval_decided':
      pushLine(
        String(e.decision) === 'allow'
          ? green(`🔓 approved ${String(e.via ?? '')}`)
          : red(`⛔ denied ${String(e.via ?? '')}`),
      )
      break
    case 'kill':
      pushLine(red(`🛑 KILL SWITCH — ${String(e.runsAborted)} run(s) aborted, ${String(e.approvalsDenied)} approval(s) denied`))
      break
    default:
      break
  }
  tui.requestRender()
}

async function watchEvents(): Promise<void> {
  try {
    const res = await fetch(`${base}/events`)
    if (!res.body) throw new Error('no event stream body')
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              handleEvent(JSON.parse(line.slice(6)) as Record<string, unknown>)
            } catch {
              /* malformed event frame — ignore */
            }
          }
        }
      }
    }
    pushLine(yellow('event stream closed — desk went down? restarting watch…'))
    await new Promise((r) => setTimeout(r, 2_000))
    void watchEvents()
  } catch {
    pushLine(red(`desk unreachable on ${base} — start the desk with \`npm run dev\` first`))
    await new Promise((r) => setTimeout(r, 3_000))
    void watchEvents()
  }
}

// ── Status header (polled every 5s) ─────────────────────────────────────────
type StatusSnap = {
  dryRun: boolean
  brain: string
  caps: { dailyUsedUsd: number; dailyMaxUsd: number; perTradeMaxUsd: number }
  activeRuns: number
  pendingApprovals: number
  realizedPnlUsd: number
  unrealizedPnlUsd: number | null
  openPositions: number
}

async function refreshHeader(): Promise<void> {
  try {
    const { ok, body } = await deskFetch('/status')
    if (!ok) return
    const s = body as StatusSnap
    header.setText(
      `${s.dryRun ? yellow('🧪 DRY RUN') : green('⚡ LIVE')} · ${bold(s.brain)} · ` +
        `day $${s.caps.dailyUsedUsd}/$${s.caps.dailyMaxUsd} · ` +
        `PnL ${green(`$${s.realizedPnlUsd}`)}${s.unrealizedPnlUsd === null ? '' : dim(` (unreal $${s.unrealizedPnlUsd})`)} · ` +
        `${s.openPositions} pos · ${cyan(`${s.activeRuns} run(s)`)} · ${yellow(`${s.pendingApprovals} pending`)}`,
    )
    tui.requestRender()
  } catch {
    /* desk down — the event stream already reports it */
  }
}

// ── Approvals (same gate as Telegram, via POST /approvals) ───────────────────
async function loadApprovals(): Promise<void> {
  try {
    const { ok, body } = await deskFetch('/approvals')
    pending.length = 0
    if (Array.isArray(body)) {
      for (const a of body as Array<Record<string, unknown>>) {
        pending.push({
          reqId: String(a.reqId),
          tool: String(a.tool),
          summary: String(a.summary),
          danger: String(a.danger),
        })
      }
    }
    renderApprovals()
  } catch {
    /* desk down — event watch will surface it */
  }
}

function findApproval(prefix: string | undefined): PendingApproval | undefined {
  if (pending.length === 0) return undefined
  if (prefix === undefined || prefix === '') return pending[0]
  return pending.find((a) => a.reqId.startsWith(prefix))
}

async function decide(approval: PendingApproval | undefined, allow: boolean): Promise<void> {
  if (!approval) {
    pushLine(yellow('no pending approval to decide (or id prefix not found)'))
    return
  }
  try {
    const res = await fetch(`${base}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reqId: approval.reqId, allow }),
    })
    if (res.status === 404) pushLine(yellow('approval already expired (timeout = deny) — nothing to do'))
    else if (res.ok) pushLine(`${allow ? green('🔓 allow sent') : red('⛔ deny sent')} · ${approval.reqId.slice(0, 8)}`)
    else pushLine(red(`approve failed: HTTP ${res.status}`))
  } catch (err) {
    pushLine(red(`approve failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  await loadApprovals()
}

// ── Editor: prompts + slash commands ─────────────────────────────────────────
editor.onSubmit = (raw: string) => {
  const text = raw.trim()
  if (text === '') return
  editor.addToHistory(text)
  editor.setText('')

  if (text === '/quit' || text === '/q') {
    tui.stop()
    process.exit(0)
  }
  if (text === '/clear') {
    while (log.children.length > 0) log.removeChild(log.children[0]!)
    tui.requestRender()
    return
  }
  if (text === '/kill') {
    pushLine(red('🛑 sending KILL SWITCH — aborts runs + denies approvals'))
    void deskFetch('/kill', { method: 'POST' }).then((r) => {
      if (!r.ok) pushLine(red(`kill failed: HTTP ${r.status}`))
    })
    return
  }
  if (text === '/plan' || text.startsWith('/plan ')) {
    const task = text.slice('/plan'.length).trim()
    if (task === '') {
      pushLine(yellow('what should I plan? usage: /plan <task>'))
      return
    }
    pushLine(bold(`📋 plan-first: ${task}`))
    // The desk reads the [plan] marker — same loop as the Telegram /plan command.
    void deskFetch('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[plan] ${task}` }),
    }).then((r) => {
      if (!r.ok) {
        const msg = (r.body as { error?: string } | null)?.error ?? `HTTP ${r.status}`
        pushLine(red(`plan rejected: ${msg}`))
      }
    })
    return
  }
  if (text === '/rewind' || text.startsWith('/rewind ')) {
    const arg = text.slice('/rewind'.length).trim()
    if (arg === '') {
      pushLine(bold('⏪ thread checkpoints'))
      void deskFetch('/thread/checkpoints').then((r) => {
        const body = r.body as { checkpoints?: Array<{ ts: number; preview: string }>; error?: string } | null
        if (!r.ok) return pushLine(red(body?.error ?? `HTTP ${r.status}`))
        const checkpoints = body?.checkpoints ?? []
        if (checkpoints.length === 0) return pushLine(dim('no checkpoints yet'))
        for (const checkpoint of [...checkpoints].reverse()) {
          pushLine(`  ${new Date(checkpoint.ts).toLocaleString()} · "${checkpoint.preview}"`)
        }
      })
      return
    }
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1) {
      pushLine(yellow('usage: /rewind [n]'))
      return
    }
    void deskFetch('/thread/rewind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n }),
    }).then((r) => {
      const body = r.body as { ok?: boolean; text?: string; error?: string } | null
      pushLine(r.ok && body?.ok ? green(body.text ?? 'rewound') : red(body?.error ?? `HTTP ${r.status}`))
    })
    return
  }
  if (text === '/y' || text.startsWith('/y ') || text === '/n' || text.startsWith('/n ')) {
    const [cmd, ...rest] = text.split(/\s+/)
    const prefix = rest.join(' ') || undefined
    void decide(findApproval(prefix), cmd === '/y')
    return
  }
  if (text.startsWith('/')) {
    // Unknown to the local shell may be an operator-authored /skill. The desk
    // resolves it at the shared ingress choke point; a non-skill slash remains
    // ordinary prompt text by design.
    pushLine(bold(`❯ ${text}`))
    void deskFetch('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => {
      if (!r.ok) {
        const msg = (r.body as { error?: string } | null)?.error ?? `HTTP ${r.status}`
        pushLine(red(`prompt rejected: ${msg}`))
      }
    })
    return
  }

  pushLine(bold(`❯ ${text}`))
  void deskFetch('/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then((r) => {
    if (!r.ok) {
      const msg = (r.body as { error?: string } | null)?.error ?? `HTTP ${r.status}`
      pushLine(red(`prompt rejected: ${msg}`))
    }
  })
}

tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop()
    process.exit(0)
  }
  return undefined
})

// ── Boot ─────────────────────────────────────────────────────────────────────
tui.setFocus(editor)
tui.start()
pushLine(bold('🧭 Frog-to-Toad Agent TUI'))
void watchEvents()
void refreshHeader()
const headerPoll = setInterval(() => void refreshHeader(), 5_000)
const approvalPoll = setInterval(() => void loadApprovals(), 2_000)
headerPoll.unref?.()
approvalPoll.unref?.()

// The approval/danger types are structural; keep the import alive for tsc.
export type { Component }

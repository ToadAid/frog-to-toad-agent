/** Core dashboard JS: helpers, hash-routed tabs, Desk tab logic (unchanged
 * from v1), SSE feed + global run status. Tab-specific loaders live in tabsJs. */
export const CORE_JS = String.raw`
const $ = (id) => document.getElementById(id)
const fmtUsd = (p) => p >= 1 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.toPrecision(3)
const sign = (v) => (v >= 0 ? '+' : '') + v.toFixed(2)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const ago = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
// markdown-lite: escape first, then fences/bold/code — never raw HTML from the model
function mdLite(s) {
  let out = esc(s)
  out = out.replace(/\`\`\`(\w*)\n([\s\S]*?)\`\`\`/g, (m, _l, code) => '<pre>' + code.replace(/\n$/, '') + '</pre>')
  out = out.replace(/\`([^\`\n]+)\`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  out = out.replace(/\n/g, '<br>')
  return out
}

const TAB_IDS = ['desk', 'chat', 'charts', 'research', 'kronos', 'settings']
const tabLoaded = {}
function currentTab() {
  const h = (location.hash || '#/desk').replace('#/', '')
  return TAB_IDS.includes(h) ? h : 'desk'
}
function showTab(name) {
  for (const id of TAB_IDS) {
    const el = $('tab-' + id)
    if (el) el.hidden = id !== name
  }
  for (const a of $('tabs').children) a.classList.toggle('active', a.getAttribute('href') === '#/' + name)
  const loader = LOADERS[name]
  if (loader && !tabLoaded[name]) { tabLoaded[name] = true; loader() }
}
window.addEventListener('hashchange', () => showTab(currentTab()))

// ── Status snapshot (shared by Desk + Settings) ──
async function refresh() {
  try {
    const s = await (await fetch('/status')).json()
    $('mode').textContent = s.dryRun ? '🧪 DRY RUN' : '⚡ LIVE'
    $('mode').className = 'badge ' + (s.dryRun ? 'dry' : 'live')
    $('brain').textContent = s.brain
    $('uptime').textContent = ago(Date.now() - s.uptimeSec * 1000)
    $('runs').textContent = s.activeRuns
    $('appr').textContent = s.pendingApprovals
    $('capused').textContent = '$' + fmtUsd(s.caps.dailyUsedUsd)
    $('capmax').textContent = '$' + fmtUsd(s.caps.dailyMaxUsd)
    $('ptmax').textContent = '$' + fmtUsd(s.caps.perTradeMaxUsd)
    const pct = s.caps.dailyMaxUsd > 0 ? (s.caps.dailyUsedUsd / s.caps.dailyMaxUsd) * 100 : 0
    const bar = $('capbar')
    bar.style.width = Math.min(100, pct) + '%'
    bar.className = pct >= 100 ? 'maxed' : pct >= 70 ? 'hot' : ''
    const rp = $('rpnl')
    rp.textContent = '$' + sign(s.realizedPnlUsd)
    rp.className = s.realizedPnlUsd > 0 ? 'up' : s.realizedPnlUsd < 0 ? 'down' : 'na'
    const up = $('upnl')
    if (s.unrealizedPnlUsd === null || s.unrealizedPnlUsd === undefined) {
      up.textContent = '–'
      up.className = 'na'
    } else {
      up.textContent = '$' + sign(s.unrealizedPnlUsd)
      up.className = s.unrealizedPnlUsd >= 0 ? 'up' : 'down'
    }

    drawSpark(s.pnlHistory ?? [])
    const ex = s.exec ?? {}
    $('exec').innerHTML = ex.opens === undefined ? '' :
      '📈 execution: <b>' + ex.opens + '</b> opens (<b>' + (ex.liveOpens ?? 0) + '</b> live) · <b>' +
      (ex.closes ?? 0) + '</b> closes · avg size <b>' + (ex.avgOpenUsd == null ? '–' : '$' + fmtUsd(ex.avgOpenUsd)) +
      '</b> · largest <b>' + (ex.largestOpenUsd == null ? '–' : '$' + fmtUsd(ex.largestOpenUsd)) + '</b>'

    const ta = s.taSignals ?? { graded: 0 }
    const taEl = $('taacc')
    if (ta.graded === 0) {
      taEl.textContent = 'no graded signals yet'
      taEl.className = 'na'
    } else {
      const cls = ta.hitRatePct >= 50 ? 'up' : 'down'
      taEl.innerHTML = ta.graded + ' graded · <b class="' + cls + '">' + ta.hitRatePct +
        '% beat bench</b> · avg move ' + sign(ta.avgMovePct ?? 0) + '%' +
        (ta.avgAlphaPct === null || ta.avgAlphaPct === undefined ? '' : ' · avg α ' + sign(ta.avgAlphaPct) + '%')
      taEl.className = 'stat'
    }

    $('npos').textContent = s.positions.length
    $('posnone').style.display = s.positions.length ? 'none' : ''
    $('posrows').innerHTML = s.positions.map((p) => {
      const pnlCls = p.unrealizedPnlUsd === null ? 'na' : p.unrealizedPnlUsd >= 0 ? 'up' : 'down'
      const pnl = p.unrealizedPnlUsd === null ? '–' : '$' + sign(p.unrealizedPnlUsd)
      const title = p.tokenAddress ? ' title="' + esc(p.tokenAddress) + '"' : ''
      return '<tr' + title + '><td>' + esc(p.symbol) + '</td><td>' + (+p.qty.toPrecision(6)) +
        '</td><td>$' + fmtUsd(p.avgEntryUsd) + '</td><td>' +
        (p.markUsd === null ? '<span class="na">–</span>' : '$' + fmtUsd(p.markUsd)) +
        '</td><td>' + (p.valueUsd === null ? '<span class="na">–</span>' : '$' + fmtUsd(p.valueUsd)) +
        '</td><td class="' + pnlCls + '">' + pnl + '</td></tr>'
    }).join('')

    const grades = s.recentGrades ?? []
    $('gradenone').style.display = grades.length ? 'none' : ''
    $('graderows').innerHTML = grades.map((g) => {
      const move = (g.movePct >= 0 ? '+' : '') + g.movePct + '%'
      const alpha = g.alphaPct === null || g.alphaPct === undefined ? '<span class="na">–</span>'
        : (g.alphaPct >= 0 ? '+' : '') + g.alphaPct + '%'
      const res = g.hit === null ? '<span class="na">held</span>'
        : g.hit ? '<span class="hit">✅ beat bench</span>' : '<span class="miss">❌ under bench</span>'
      return '<tr><td>' + ago(g.entryTs) + ' ago</td>' +
        '<td><b>' + esc(g.symbol) + '</b> ' + esc(g.signal) + '</td>' +
        '<td>$' + fmtUsd(g.entryPrice) + '</td><td>$' + fmtUsd(g.gradedPrice) + '</td>' +
        '<td class="' + (g.movePct >= 0 ? 'up' : 'down') + '">' + move + '</td>' +
        '<td>' + alpha + '</td><td>' + res + '</td></tr>'
    }).join('')

    $('lednone').style.display = s.recentLedger.length ? 'none' : ''
    $('ledrows').innerHTML = s.recentLedger.map((e) => {
      const addr = e.tokenAddress ? ' <span class="na">(' + esc(e.tokenAddress.slice(0, 6)) + '…' + esc(e.tokenAddress.slice(-4)) + ')</span>' : ''
      return '<tr><td>' + ago(e.ts) + ' ago</td><td>' + esc(e.type) + (e.dryRun ? ' 🧪' : ' ⚡') +
        '</td><td>' + esc(e.symbol ?? '–') + addr + '</td><td>' + (e.qty != null ? +e.qty.toPrecision(6) : '–') +
        '</td><td>' + (e.entryUsd != null ? '$' + fmtUsd(e.entryUsd) : '–') +
        '</td><td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.rationale ?? '') + '</td></tr>'
    }).join('')
  } catch { /* next poll retries */ }
}

// ── Approvals: detail view + desktop answers (same gate as Telegram) ──
const answered = new Map()
async function refreshApprovals() {
  let list = []
  try {
    list = await (await fetch('/approvals')).json()
  } catch { return }
  $('napr').textContent = list.filter((a) => !answered.has(a.reqId)).length
  $('aprnone').style.display = list.length ? 'none' : ''
  $('aprlist').innerHTML = list.map((a) => {
    if (answered.has(a.reqId)) return '<div class="apr"><div class="done">' + esc(a.tool) + ' ' + esc(answered.get(a.reqId)) + '</div></div>'
    const left = Math.max(0, (a.timeoutSec ?? 0) - (a.ageSec ?? 0))
    return '<div class="apr">' +
      '<span class="tool">' + esc(a.tool) + '</span> <span class="danger-' + esc(a.danger) + '">' + esc(a.danger) + '</span>' +
      '<span class="meta"> · #' + esc(a.reqId) + ' · waiting ' + (a.ageSec ?? 0) + 's of ' + (a.timeoutSec ?? '?') + 's (timeout = DENY)</span>' +
      '<div class="sum">' + esc(a.summary) + '</div>' +
      '<div class="btns"><button class="yes" data-req="' + esc(a.reqId) + '" data-allow="1">✅ Approve</button>' +
      '<button class="no" data-req="' + esc(a.reqId) + '" data-allow="0">❌ Deny</button></div></div>'
  }).join('')
}

$('aprlist').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button')
  if (!btn) return
  const reqId = btn.dataset.req
  const allow = btn.dataset.allow === '1'
  if (allow && !confirm('APPROVE ' + reqId + '? The tool will execute for real if the desk is LIVE.')) return
  try {
    const r = await fetch('/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reqId, allow }),
    })
    answered.set(reqId, (await r.json()).ok ? (allow ? '✅ approved' : '❌ denied') : 'expired/unknown')
  } catch {
    answered.set(reqId, 'request failed')
  }
  refreshApprovals()
})

// ── SSE feed + global run status ──
const feed = $('feed')
const MAX_FEED = 40
function pushEvent(e) {
  $('feednone').style.display = 'none'
  const li = document.createElement('li')
  const time = new Date(e.ts ?? Date.now()).toLocaleTimeString()
  const detail = e.tool ? esc(e.tool)
    : e.kind === 'final' ? esc(String(e.text ?? '').slice(0, 60))
    : e.kind === 'error' ? esc(String(e.message ?? '').slice(0, 60))
    : e.kind === 'run_started' ? esc(e.agent ?? '') + ' → chat ' + esc(e.chatId ?? '')
    : e.kind === 'kill' ? esc(e.runsAborted + ' runs, ' + e.approvalsDenied + ' approvals')
    : e.kind === 'desk_state' ? esc('→ ' + e.state + ' (' + (e.reason ?? '') + ')')
    : e.kind === 'kronos_started' ? esc(e.symbol + ' ' + e.interval + ' — runner started')
    : e.kind === 'kronos_result' ? esc(e.symbol + ' ' + (e.ok ? '✅' : '❌') + ' — see Kronos tab')
    : ''
  li.innerHTML = '<span class="t">' + time + '</span><span class="k k-' + esc(e.kind) + '">' + esc(e.kind) +
    '</span><span class="m">' + detail + '</span>'
  feed.prepend(li)
  while (feed.children.length > MAX_FEED) feed.removeChild(feed.lastChild)

  if (e.kind === 'run_started') runStatus('frog is working…')
  if (e.kind === 'final' || e.kind === 'error' || e.kind === 'aborted') {
    runStatus('')
    if (typeof chatAfterRun === 'function') chatAfterRun()
  }
  if (e.kind === 'kronos_started') runStatus('kronos runner started — up to 5 min')
  if (e.kind === 'kronos_result') { runStatus(''); if (typeof kronosDone === 'function') kronosDone(e) }
}
let runstatusTimer
function runStatus(text) {
  const el = $('runstatus')
  el.textContent = text
  clearTimeout(runstatusTimer)
  if (text !== '') runstatusTimer = setTimeout(() => { el.textContent = '' }, 120000)
}

function drawSpark(points) {
  const svg = $('spark')
  const label = $('sparklabel')
  if (!points || points.length < 2) {
    svg.innerHTML = points && points.length === 1
      ? '<line x1="0" y1="15" x2="100" y2="15" stroke="#7b8499" stroke-dasharray="2 2"/><circle cx="100" cy="15" r="2" fill="#7b8499"/>'
      : ''
    label.textContent = points && points.length === 1 ? 'one close so far: ' + sign(points[0].realizedUsd) : 'realized P&L by day — closes will draw the line'
    return
  }
  const vals = points.map((p) => p.realizedUsd)
  const min = Math.min(0, ...vals)
  const max = Math.max(0, ...vals)
  const span = max - min || 1
  const x = (i) => (i / (vals.length - 1)) * 100
  const y = (v) => 28 - ((v - min) / span) * 26 // 0..28 with 1px padding; baseline = $0
  const zero = y(0)
  const path = vals.map((v, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(2) + ',' + y(v).toFixed(2)).join(' ')
  const last = vals[vals.length - 1]
  const color = last >= 0 ? '#34d399' : '#f87171'
  svg.innerHTML =
    '<line x1="0" y1="' + zero.toFixed(2) + '" x2="100" y2="' + zero.toFixed(2) + '" stroke="#232a3a" stroke-width=".5"/>' +
    '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.2"/>' +
    '<circle cx="100" cy="' + y(last).toFixed(2) + '" r="1.8" fill="' + color + '"/>'
  label.textContent = 'realized P&L by day (' + vals.length + ' closing day' + (vals.length === 1 ? '' : 's') + '), now ' + sign(last) + ' — dashed line = $0'
}

$('killbtn').onclick = async () => {
  if (!confirm('🛑 Abort all active runs and DENY all pending approvals?')) return
  const btn = $('killbtn')
  btn.disabled = true
  try {
    const r = await (await fetch('/kill', { method: 'POST' })).json()
    $('killresult').innerHTML = '<span class="down">aborted ' + r.runsAborted + ' run(s), denied ' + r.approvalsDenied + ' approval(s)</span>'
  } catch {
    $('killresult').innerHTML = '<span class="na">kill failed — is the desk up?</span>'
  }
  btn.disabled = false
}

function connect() {
  const es = new EventSource('/events')
  es.onopen = () => { $('conn').textContent = '● live'; $('conn').className = 'conn on' }
  es.onerror = () => { $('conn').textContent = '● offline'; $('conn').className = 'conn off' }
  es.onmessage = (m) => { try { pushEvent(JSON.parse(m.data)) } catch {} }
}

refresh()
setInterval(refresh, 4000)
refreshApprovals()
setInterval(refreshApprovals, 2000)
connect()
`
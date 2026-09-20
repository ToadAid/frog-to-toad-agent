/** Tab loaders: Chat, Charts, Research, Kronos, Settings. Each loads its own
 * endpoint, renders, and offers a refresh button. Charts needs the vendored
 * lightweight-charts build served at /vendor/lwc.js (no CDN — localhost only). */
export const TABS_JS = String.raw`
// ── Chat tab ─────────────────────────────────────────────────────────────────
let currentChatId = null
let pendingImage = null // {base64, mime, name}

async function loadThreads() {
  let v
  try { v = await (await fetch('/threads')).json() } catch { return }
  const sel = $('chatselect')
  if (!v.chats.length) {
    sel.innerHTML = '<option>(no transcripts yet)</option>'
    return
  }
  sel.innerHTML = v.chats.map((c) =>
    '<option value="' + c.chatId + '"' + (c.chatId === v.chatId ? ' selected' : '') + '>' +
    (c.isAdmin ? '★ admin' : 'chat ' + c.chatId) + ' · ' + c.messages + ' recs</option>').join('')
  currentChatId = v.chatId
  renderChat(v.messages)
}

async function loadChat(chatId) {
  currentChatId = chatId
  try {
    const v = await (await fetch('/threads?chat=' + chatId)).json()
    renderChat(v.messages)
  } catch { /* keep old log */ }
}

function renderChat(messages) {
  const log = $('chatlog')
  $('chatnone') && ($('chatnone').style.display = messages.length ? 'none' : '')
  if (!messages.length) { log.innerHTML = '<div class="empty">no transcript for this chat yet — say something</div>'; return }
  log.innerHTML = messages.map((m) => {
    const meta = new Date(m.ts).toLocaleTimeString() + (m.imageCount ? ' · <span class="imgbadge">🖼 ' + m.imageCount + ' image(s)</span>' : '')
    let body = ''
    if (m.role === 'assistant') {
      body = mdLite(m.content || '')
      if (m.tools && m.tools.length) {
        body += '<div class="tools">' + m.tools.map((t) => '<span>🔧 ' + esc(t) + '</span>').join('') + '</div>'
      }
    } else if (m.role === 'user') {
      body = mdLite(m.content)
    } else {
      body = esc(String(m.content).slice(0, 140))
    }
    return '<div class="msg ' + esc(m.role) + '"><div class="meta">' + esc(m.role) + ' · ' + meta + '</div>' + body + '</div>'
  }).join('')
  log.scrollTop = log.scrollHeight
}

function chatAfterRun() {
  // A run just finished — the transcript has new turns; refresh the open chat.
  if (currentChatId !== null) loadChat(currentChatId)
}

async function sendChat() {
  const box = $('chatinput')
  const text = box.value.trim()
  if (text === '' || text.length > 4000) return
  const btn = $('chatsend')
  btn.disabled = true
  const body = { text }
  if (pendingImage) { body.imageBase64 = pendingImage.base64; body.imageMime = pendingImage.mime }
  try {
    const r = await fetch('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      runStatus('send failed: ' + (err.error ?? r.status))
    } else {
      box.value = ''
      clearPendingImage()
      runStatus('sent — the frog is thinking…')
      setTimeout(() => { if (currentChatId !== null) loadChat(currentChatId) }, 1500)
    }
  } catch { runStatus('send failed — is the desk up?') }
  btn.disabled = false
}

function clearPendingImage() {
  pendingImage = null
  $('imgbtn').textContent = '🖼 image'
}

$('imgbtn').onclick = () => $('imgpick').click()
$('imgpick').onchange = () => {
  const f = $('imgpick').files[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    const dataUri = String(reader.result ?? '')
    const m = dataUri.match(/^data:([^;]+);base64,(.*)$/)
    if (!m) { runStatus('could not read that image'); return }
    pendingImage = { base64: m[2], mime: m[1], name: f.name }
    $('imgbtn').textContent = '🖼 ' + f.name.slice(0, 16) + ' ✓'
  }
  reader.readAsDataURL(f)
}
$('chatsend').onclick = sendChat
$('chatinput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendChat() }
})
$('chatselect').addEventListener('change', (ev) => loadChat(Number(ev.target.value)))
$('chatrefresh').onclick = () => { loadThreads() }

// ── Charts tab ───────────────────────────────────────────────────────────────
let chartsBuilt = null
let currentChartSymbol = null

function buildCharts() {
  if (chartsBuilt) return chartsBuilt
  const LWC = window.LightweightCharts
  if (!LWC || typeof LWC.createChart !== 'function') return null
  const base = {
    layout: { background: { type: 'solid', color: '#11151f' }, textColor: '#7b8499', fontSize: 10 },
    grid: { vertLines: { color: '#1a202e' }, horzLines: { color: '#1a202e' } },
    rightPriceScale: { borderColor: '#232a3a' },
    timeScale: { borderColor: '#232a3a' },
    autoSize: true,
  }
  const candle = LWC.createChart($('candlechart'), base)
  const rsi = LWC.createChart($('rsichart'), { ...base, rightPriceScale: { borderColor: '#232a3a', scaleMargins: { top: 0.15, bottom: 0.15 } } })
  const macd = LWC.createChart($('macdchart'), base)
  chartsBuilt = { candle, rsi, macd }
  // sync crosshair + time range across the three panes
  const sync = (src, a, b) => src.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (r) { a.timeScale().setVisibleLogicalRange(r); b.timeScale().setVisibleLogicalRange(r) }
  })
  sync(candle, rsi, macd)
  sync(rsi, candle, macd)
  sync(macd, candle, rsi)
  return chartsBuilt
}

function asPoints(arr) { return (arr ?? []).filter((p) => p !== null) }

async function loadChart() {
  const symbol = $('chsymbol').value.trim() // sent verbatim — 0x… addresses are case-significant
  if (symbol === '') { $('charterr').textContent = 'enter a ticker or a Base contract address first'; return }
  const interval = $('chinterval').value
  $('charterr').textContent = ''
  let v
  try {
    const r = await fetch('/chart?symbol=' + encodeURIComponent(symbol) + '&interval=' + interval)
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      $('charterr').textContent = 'chart unavailable: ' + (err.error ?? r.status)
      return
    }
    v = await r.json()
  } catch { $('charterr').textContent = 'chart unavailable — is the desk up?'; return }
  currentChartSymbol = symbol
  renderChart(v)
}

function renderChart(v) {
  // fresh series every load (a re-render must not stack duplicates)
  if (chartsBuilt) {
    chartsBuilt.candle.remove()
    chartsBuilt.rsi.remove()
    chartsBuilt.macd.remove()
    chartsBuilt = null
  }
  const c = buildCharts()
  if (!c) {
    $('charterr').textContent =
      'vendor chart lib not served — drop the pinned lightweight-charts standalone build at vendor/lightweight-charts.standalone.production.js (see BUILD_LIST §12.9)'
    return
  }
  const LWC = window.LightweightCharts
  const candles = v.candles.map((k) => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close }))
  const main = c.candle.addSeries(LWC.CandlestickSeries, { upColor: '#34d399', downColor: '#f87171', borderVisible: false, wickUpColor: '#34d399', wickDownColor: '#f87171' }, 0)
  main.setData(candles)
  const line = (color) => c.candle.addSeries(LWC.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0)
  line('#60a5fa').setData(asPoints(v.ema20)) // EMA20
  line('#fbbf24').setData(asPoints(v.ema50)) // EMA50
  line('#3f4a63').setData(asPoints(v.boll.upper))
  line('#3f4a63').setData(asPoints(v.boll.lower))
  const bM = line('#2c3547')
  bM.applyOptions({ lineStyle: 2 })
  bM.setData(asPoints(v.boll.mid))

  const rsiS = c.rsi.addSeries(LWC.LineSeries, { color: '#a78bfa', lineWidth: 1, priceLineVisible: false }, 0)
  rsiS.setData(asPoints(v.rsi))

  const hist = c.macd.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, 0)
  hist.setData(asPoints(v.macd.histogram).map((p) => ({ time: p.time, value: p.value, color: p.value >= 0 ? '#1d5c45' : '#7f2d33' })))
  line('#60a5fa').setData(asPoints(v.macd.line)) // macd line (reuses the color; separate pane)
  line('#fbbf24').setData(asPoints(v.macd.signal))

  c.rsi.timeScale().fitContent()
  c.candle.timeScale().fitContent()
  c.macd.timeScale().fitContent()
  renderDossier(v.dossier, v)
}

function renderDossier(d, v) {
  // contract charts disclose the exact pool — same-ticker-different-contract is everywhere
  const poolLine = v && v.pairAddress
    ? ' · pool <span class="stat">' + esc(v.label ?? '') + ' ' + esc(short6(v.pairAddress)) + '</span>' +
      (v.liquidityUsd != null ? ' · $' + fmtUsd(v.liquidityUsd) + ' liquidity' : '')
    : ''
  const chips = []
  const cls = (s) => s === 'bullish' ? 'bull' : s === 'bearish' ? 'bear' : ''
  if (d.emaStack) chips.push('<span class="chip ' + cls(d.emaStack) + '">EMA20/50 ' + esc(d.emaStack) + '</span>')
  if (d.rsi14 !== null) chips.push('<span class="chip ' + (d.rsi14 < 30 ? 'bull' : d.rsi14 > 70 ? 'bear' : '') + '">RSI ' + d.rsi14.toFixed(1) + '</span>')
  if (d.macd) chips.push('<span class="chip ' + cls(d.macd.cross === 'bullish' ? 'bullish' : d.macd.cross === 'bearish' ? 'bearish' : '') + '">MACD ' + esc(d.macd.cross) + '</span>')
  if (d.bollinger) chips.push('<span class="chip' + (d.bollinger.squeeze ? ' warn' : '') + '">BB width ' + d.bollinger.bandwidthPct.toFixed(1) + '%' + (d.bollinger.squeeze ? ' SQUEEZE' : '') + '</span>')
  if (d.volumeTrend !== 'insufficient') chips.push('<span class="chip">vol ' + esc(d.volumeTrend) + '</span>')
  chips.push('<span class="chip">24h ' + (d.change24hPct === null ? '–' : sign(d.change24hPct) + '%') + '</span>')
  $('dossier').innerHTML =
    '<div>' + chips.join('') + ' <span class="stat">close $' + fmtUsd(d.close) + ' · source ' + esc(d.source) + (d.closeOnly ? ' (close-only)' : '') + ' · ' + d.candles + ' candles</span>' + poolLine + '</div>' +
    '<div class="notes">' + (d.notes ?? []).map((n) => '<div>· ' + esc(n) + '</div>').join('') + '</div>'
}

/** Case-significant identity helper — 0xab…ef → 0xab…ef. */
function short6(a) { return typeof a === 'string' && a.startsWith('0x') ? a.slice(0, 6) + '…' + a.slice(-4) : a }

function setInputOptions(input, values) {
  // merge into the existing datalist (majors stay; record symbols join them)
  const dl = $(input.getAttribute('list'))
  if (!dl) return
  const have = new Set(Array.from(dl.children).map((o) => o.value))
  for (const v of values) {
    if (!have.has(v)) { const o = document.createElement('option'); o.value = v; dl.appendChild(o); have.add(v) }
  }
}

// ── Research tab ─────────────────────────────────────────────────────────────

async function loadResearch() {
  let v
  try { v = await (await fetch('/research')).json() } catch { return }
  const f = v.fng
  $('fngbox').innerHTML = f
    ? '<b class="' + (f.value <= 25 ? 'down' : f.value >= 75 ? 'up' : '') + '">' + f.value + '</b> · ' + esc(f.classification) +
      ' <span class="na">(yesterday ' + (f.yesterday ?? '–') + ', week avg ' + (f.weekAvg ?? '–') + ')</span>'
    : '<span class="na">feed unavailable</span>'
  const chains = v.topChains ?? []
  $('tvlrows').innerHTML = chains.map((c) => {
    const ch = c.changePct7d
    return '<tr><td>' + esc(c.name) + '</td><td>$' + fmtUsd(c.tvl) + '</td><td class="' + (ch == null ? 'na' : ch >= 0 ? 'up' : 'down') + '">' + (ch == null ? '–' : sign(ch) + '% 7d') + '</td></tr>'
  }).join('') || '<div class="empty">feed unavailable</div>'
  const st = v.stablecoins
  $('stablesbox').innerHTML = st
    ? (st.total ?? '–') + ' total · 7d flow ' + (st.flow7dPct == null ? '–' : '<b class="' + (st.flow7dPct >= 0 ? 'up' : 'down') + '">' + sign(st.flow7dPct) + '%</b>')
    : '<span class="na">feed unavailable</span>'
  const news = v.news ?? []
  $('newsbox').innerHTML = news.length
    ? news.map((n) => '<div style="padding:3px 0;border-bottom:1px solid #1a202e"><a href="' + esc(n.link) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">' + esc(n.title.slice(0, 90)) + '</a> <span class="na" style="font:10px var(--mono)">' + esc(n.source) + (n.publishedAt ? ' · ' + ago(n.publishedAt) : '') + '</span></div>').join('')
    : '<div class="empty">no news items</div>'
  const jr = v.journal ?? []
  $('journalbox').innerHTML = jr.length
    ? jr.map((j) => '<div style="padding:4px 0;border-bottom:1px solid #1a202e"><b>' + esc(j.symbol) + '</b> <span class="na">' + ago(j.ts) + ' ago</span>' +
        (j.grade ? ' <span class="chip ' + (j.grade === 'good-process' ? 'bull' : 'bear') + '">' + esc(j.grade) + '</span>' : '') +
        '<div style="font-size:12px">' + esc(String(j.decision ?? '').slice(0, 160)) + '</div>' +
        (j.lesson ? '<div style="font-size:11.5px;color:var(--accent)">💡 ' + esc(j.lesson.slice(0, 160)) + '</div>' : '') + '</div>').join('')
    : '<div class="empty">journal is empty</div>'
  const ls = v.lessons
  $('lessonsbox').innerHTML = ls ? '<pre style="background:#0b0e14;border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font:11.5px var(--mono);white-space:pre-wrap">' + esc(ls) + '</pre>' : '<div class="empty">no lessons distilled yet</div>'
}

// ── Kronos tab ───────────────────────────────────────────────────────────────
async function loadKronos() {
  let v
  try { v = await (await fetch('/kronos')).json() } catch { return }
  // datalist: majors + every symbol already in the records (deduped) — the
  // input itself accepts anything a feed can serve, incl. 0x… addresses
  const inp = $('kronsym')
  setInputOptions(inp, [...(v.majors ?? []), ...new Set((v.records ?? []).map((r) => r.symbol))])
  if (inp.value === '') inp.value = 'BTC'
  const a = v.accuracy ?? {}
  const accParts = []
  if (a.issued) {
    accParts.push('<b>' + a.issued + '</b> issued · <b>' + a.graded + '</b> graded' +
      (a.inBandPct != null ? ' · <b class="' + (a.inBandPct >= 50 ? 'up' : 'down') + '">' + a.inBandPct + '% in-band</b>' : '') +
      (a.hitRatePct != null ? ' · ' + a.hitRatePct + '% direction' : ''))
  }
  $('kronacc').innerHTML =
    'lane: <b class="' + (v.laneReady ? 'up' : 'down') + '">' + (v.laneReady ? 'runner present' : 'runner NOT found (kronos-server/run.sh missing)') + '</b>' +
    (accParts.length ? ' · ' + accParts.join('') : ' · no forecasts graded yet')
  const recs = v.records ?? []
  $('kronnone').style.display = recs.length ? 'none' : ''
  $('kronrows').innerHTML = recs.map((r) => {
    const graded = r.gradedAt !== undefined && r.gradedAt !== null
    const move = r.movePct == null ? '–' : (r.movePct >= 0 ? '+' : '') + r.movePct.toFixed(2) + '%'
    const ident = r.label ? esc(r.label) + ' · ' + esc(short6(r.pairAddress)) : esc(r.symbol)
    return '<tr><td>' + ago(r.issuedAt) + ' ago</td><td><b>' + ident + '</b> ' + esc(r.interval) + '</td><td>+' + r.horizonCandles + '</td>' +
      '<td>$' + fmtUsd(r.issuedPrice) + '</td><td>$' + fmtUsd(r.p50) + '</td>' +
      '<td>$' + fmtUsd(r.bandLow) + ' – $' + fmtUsd(r.bandHigh) + '</td>' +
      '<td>' + (r.pUp == null ? '–' : Math.round(r.pUp * 100) + '%') + '</td>' +
      '<td class="' + (r.movePct >= 0 ? 'up' : 'down') + '">' + move + '</td>' +
      '<td>' + (graded ? '✅ graded' : '<span class="na">pending</span>') + '</td></tr>'
  }).join('')
}

async function runKronosNow() {
  const btn = $('kronrun')
  btn.disabled = true
  $('kronerr').textContent = ''
  const symbol = $('kronsym').value.trim() // sent verbatim — 0x… addresses are case-significant
  if (symbol === '') {
    $('kronerr').textContent = 'enter a ticker or a Base contract address first'
    btn.disabled = false
    return
  }
  try {
    const r = await fetch('/kronos/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbol,
        interval: $('kronint').value,
        predLen: Number($('kronlen').value) || undefined,
      }),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      $('kronerr').textContent = 'could not start: ' + (err.error ?? r.status)
    }
  } catch { $('kronerr').textContent = 'could not start — is the desk up?' }
  btn.disabled = false
}

function kronosDone(e) {
  // result landed — refresh the records table; show errors inline
  loadKronos()
  if (e && e.ok === false && $('kronerr')) $('kronerr').textContent = String(e.text ?? '').slice(0, 300)
}

// ── Settings tab ─────────────────────────────────────────────────────────────
async function loadSettings() {
  let v
  try { v = await (await fetch('/settings')).json() } catch { return }
  const lines = [
    ['dry run', v.dryRun ? 'YES — no orders will be signed' : 'NO (real mode)'],
    ['execution mode', v.executionMode],
    ['brain', v.brain + (v.provider ? ' · provider ' + v.provider : '') + ' · model ' + v.model],
    ['baseUrl', v.baseUrl ?? '–'],
    ['limits', 'perTrade $' + fmtUsd(v.limits.perTradeUsdMax) + ' · daily $' + fmtUsd(v.limits.dailyUsdMax) + ' · approval timeout ' + v.limits.approvalTimeoutSec + 's'],
    ['timezone', v.timezone],
    ['admin chat', v.adminConfigured ? 'configured' : 'NOT configured — rituals + approvals dead'],
    ['status port', v.statusPort],
  ]
  $('cfglines').innerHTML = lines.map((l) => '<div class="cfgline">' + esc(l[0]) + ' : <b>' + esc(String(l[1])) + '</b></div>').join('')
  const ds = v.deskState
  $('dsline').innerHTML = 'state: <b class="' + (ds.state === 'ACTIVE' ? 'up' : ds.state === 'HALTED' ? 'down' : '') + '">' + esc(ds.state) + '</b>' +
    ' · since ' + ago(ds.since) + ' ago' + (ds.reason ? ' · ' + esc(ds.reason) : '')
  $('docline').innerHTML =
    'cheap gate: <b class="' + (v.doctor.cheapOk ? 'up' : 'down') + '">' + (v.doctor.cheapOk ? 'healthy' : 'unhealthy') + '</b>' +
    ' · hands: <b class="' + (v.doctor.handsOpen ? 'up' : 'down') + '">' + (v.doctor.handsOpen ? 'OPEN' : 'CLOSED (run npm run doctor)') + '</b>' +
    (v.doctor.lastTestGreenAt ? ' · last full green ' + ago(v.doctor.lastTestGreenAt) + ' ago' : ' · no full run recorded')
}

async function setDeskState(state) {
  const label = state === 'HALTED' ? '🛑 HALT the desk (every trade refused until you resume)?' : '▶️ RESUME trading (state back to ACTIVE)?'
  if (!confirm(label)) return
  try {
    const r = await fetch(state === 'HALTED' ? '/halt' : '/resume', { method: 'POST' })
    const j = await r.json().catch(() => ({}))
    $('dsresult').textContent = j.ok ? 'state → ' + j.deskState.state : 'failed'
  } catch { $('dsresult').textContent = 'failed — is the desk up?' }
  setTimeout(loadSettings, 400)
}

// ── Loader registry (referenced by CORE_JS's showTab) ──
const LOADERS = {
  desk: () => {},
  chat: () => { loadThreads() },
  charts: () => { initChartsTab() },
  research: () => { loadResearch() },
  kronos: () => { loadKronos() },
  settings: () => { loadSettings() },
}

function initChartsTab() {
  const inp = $('chsymbol')
  if (inp.getAttribute('data-seeded') !== '1') {
    // datalist sugar only — the input accepts anything the feeds can serve
    setInputOptions(inp, ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'ARB', 'OP', 'PEPE', 'MOG'])
    inp.setAttribute('data-seeded', '1')
    if (inp.value === '') inp.value = 'BTC'
  }
  loadChart()
}

function chartOnEnter(ev) { if (ev.key === 'Enter') { ev.preventDefault(); loadChart() } }

$('chrefresh').onclick = loadChart
$('chinterval').onchange = loadChart
$('chsymbol').onchange = loadChart
$('chsymbol').addEventListener('keydown', chartOnEnter)
$('kronsym').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); runKronosNow() } })
$('resrefresh').onclick = () => loadResearch()
$('kronrefresh').onclick = () => loadKronos()
$('kronrun').onclick = runKronosNow
$('haltbtn').onclick = () => setDeskState('HALTED')
$('resumebtn').onclick = () => setDeskState('ACTIVE')
`
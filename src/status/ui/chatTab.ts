/** Chat tab — a face on the /prompt lane: transcript read-back, send box,
 * chart-screenshot upload (vision lane), live run status from SSE. Same loop,
 * same approval gate, same admin identity as a Telegram message. */
export const CHAT_TAB_HTML = String.raw`
  <div class="panel">
    <button class="refbtn" id="chatrefresh">↻ refresh</button>
    <h2>Chat — the frog's own channel <span class="stat">(runs as the admin · same approval gate as Telegram)</span></h2>
    <div id="chatlist"><select id="chatselect"></select></div>
    <div id="chatlog"><div class="empty" id="chatnone">no transcript yet</div></div>
    <div id="runstatus"></div>
    <div id="composer">
      <input type="file" id="imgpick" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
      <button id="imgbtn" title="Attach a chart screenshot — rides the same vision lane as a Telegram photo">🖼 image</button>
      <textarea id="chatinput" placeholder="Talk to the frog… (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="chatsend">Send</button>
    </div>
  </div>
`

export const CHARTS_TAB_HTML = String.raw`
  <div class="panel" style="margin-bottom:12px">
    <div class="chartctl">
      <h2 style="margin:0">Charts — human-readable candles + the frog's readings</h2>
      <input id="chsymbol" list="chsymbols" value="BTC" placeholder="BTC or 0x… Base contract" spellcheck="false"
             title="any ticker a feed can serve, or a Base ERC-20 contract address (pinpoint)">
      <datalist id="chsymbols"></datalist>
      <select id="chinterval"><option value="hourly">1h candles</option><option value="daily">1d candles</option></select>
      <button id="chrefresh">↻ load</button>
    </div>
    <div id="charterr"></div>
    <div id="candlechart"></div>
    <div class="stat" style="margin:4px 2px">RSI(14)</div>
    <div id="rsichart"></div>
    <div class="stat" style="margin:4px 2px">MACD(12,26,9)</div>
    <div id="macdchart"></div>
  </div>
  <div class="panel" id="dossierwrap">
    <h2>The frog's dossier — mechanical readings, no advice</h2>
    <div id="dossier"><div class="empty">load a chart to see the readings</div></div>
  </div>
`

export const RESEARCH_TAB_HTML = String.raw`
  <div class="panel" style="margin-bottom:12px">
    <button class="refbtn" id="resrefresh">↻ refresh</button>
    <h2>Research — everything the frog sees</h2>
    <div class="grid">
      <div>
        <h2>Fear &amp; Greed</h2>
        <div id="fngbox" class="stat">loading…</div>
        <h2 style="margin-top:14px">Chain TVL (DefiLlama)</h2>
        <table><tbody id="tvlrows"></tbody></table>
        <h2 style="margin-top:14px">Stablecoin flows</h2>
        <div id="stablesbox" class="stat">–</div>
      </div>
      <div>
        <h2>News (keyless feeds)</h2>
        <div id="newsbox" class="stat">loading…</div>
        <h2 style="margin-top:14px">Trade journal (newest first)</h2>
        <div id="journalbox" class="stat">empty</div>
      </div>
    </div>
  </div>
  <div class="panel">
    <h2>Distilled lessons (nightly reviewer, sample-gated)</h2>
    <div id="lessonsbox"><div class="empty">no lessons distilled yet</div></div>
  </div>
`

export const KRONOS_TAB_HTML = String.raw`
  <div class="panel" style="margin-bottom:12px">
    <button class="refbtn" id="kronrefresh">↻ refresh</button>
    <h2>Kronos forecast lane — quantile bands from the vendored foundation model</h2>
    <div id="kronacc" class="stat">loading…</div>
    <div id="kronform" style="margin-top:10px">
      <div id="kronosform">
        <input id="kronsym" list="kronsyms" value="BTC" placeholder="BTC or 0x… Base contract" spellcheck="false"
               title="any ticker a feed can serve, or a Base ERC-20 contract address (pinpoint — the exact pool wins)">
        <datalist id="kronsyms"></datalist>
        <select id="kronint"><option value="hourly">hourly</option><option value="daily">daily</option></select>
        <input id="kronlen" type="number" min="1" max="120" value="12" title="bars ahead (1-120)">
        <button id="kronrun">🔮 Run forecast</button>
        <span class="stat" id="kronhint">runner may take up to 5 min (first run downloads weights)</span>
      </div>
    </div>
    <div id="kronerr" style="color:var(--red);font:12px var(--mono);margin-top:8px"></div>
  </div>
  <div class="panel">
    <h2>Forecast records (newest first) — every issued forecast is graded at horizon</h2>
    <table>
      <thead><tr><th>Issued</th><th>Symbol</th><th>H</th><th>Now</th><th>p50</th><th>Band p25–p75</th><th>P(up)</th><th>Move</th><th>Grade</th></tr></thead>
      <tbody id="kronrows"></tbody>
    </table>
    <div class="empty" id="kronnone">no forecasts issued yet</div>
  </div>
`

export const SETTINGS_TAB_HTML = String.raw`
  <div class="panel" style="margin-bottom:12px">
    <h2>Config — read-only (the .env stays manual; the wizard is the writer)</h2>
    <div id="cfglines"></div>
  </div>
  <div class="panel" style="margin-bottom:12px">
    <h2>Trading state machine — principal-owned, persisted across restarts</h2>
    <div class="stat" id="dsline" style="margin-bottom:10px"></div>
    <button class="statebtn halt" id="haltbtn">🛑 HALT</button>
    <button class="statebtn resume" id="resumebtn">▶️ RESUME</button>
    <span class="stat" id="dsresult" style="margin-left:12px"></span>
    <div class="stat" style="margin-top:10px">HALT refuses every trade (exits can still land in stables while REDUCING; a manual close is always yours). RESUME returns to ACTIVE — all guards, caps and approvals still apply.</div>
  </div>
  <div class="panel">
    <h2>Doctor gate</h2>
    <div class="stat" id="docline"></div>
  </div>
`
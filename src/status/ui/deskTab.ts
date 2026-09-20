/** Desk tab — the original dashboard body, unchanged (§12.9 keeps the working
 * surface as the home tab; tabs ADD, they don't redesign). */
export const DESK_TAB_HTML = String.raw`
  <div class="row" style="margin-bottom:12px">
    <div class="panel" style="flex:1;min-width:300px">
      <h2>Daily cap</h2>
      <div class="stat"><b id="capused">$0</b> of <b id="capmax">$0</b></div>
      <div class="capbar"><div id="capbar" style="width:0%"></div></div>
      <div class="stat" style="margin-top:6px">realized P&amp;L: <b id="rpnl" class="na">$0.00</b> · unrealized: <b id="upnl" class="na">–</b></div>
      <div class="stat" style="margin-top:4px">🎯 TA track record: <b id="taacc" class="na">no graded signals yet</b></div>
      <svg id="spark" preserveAspectRatio="none" viewBox="0 0 100 30"></svg>
      <div class="stat" style="margin-top:2px" id="sparklabel"></div>
    </div>
    <div class="panel" style="flex:1;min-width:300px">
      <h2>Kill switch</h2>
      <div class="stat" style="margin-bottom:10px">Aborts every active run and DENIES every pending approval. The desk stays up; nothing new gets executed until you release it.</div>
      <button id="killbtn">🛑 KILL ALL</button><span id="killresult"></span>
      <div class="stat" style="margin-top:10px" id="exec"></div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:12px">
    <h2>Pending approvals (<span id="napr">0</span>)</h2>
    <div id="aprlist"><div class="empty" id="aprnone">no pending approvals</div></div>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Positions (<span id="npos">0</span>)</h2>
      <table>
        <thead><tr><th>Token</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Value</th><th>P&amp;L</th></tr></thead>
        <tbody id="posrows"></tbody>
      </table>
      <div class="empty" id="posnone">no open positions</div>
    </div>
    <div class="panel">
      <h2>Live activity</h2>
      <ul id="feed"></ul>
      <div class="empty" id="feednone">waiting for events…</div>
    </div>
  </div>

  <div class="panel" style="margin-top:12px">
    <h2>Signal track record — graded vs benchmark (newest first)</h2>
    <table>
      <thead><tr><th>When</th><th>Signal</th><th>Entry</th><th>Graded</th><th>Move</th><th>α vs bench</th><th>Result</th></tr></thead>
      <tbody id="graderows"></tbody>
    </table>
    <div class="empty" id="gradenone">no graded signals yet — the daily grader needs 24h and a price</div>
  </div>

  <div class="panel" style="margin-top:12px">
    <h2>Recent ledger</h2>
    <table>
      <thead><tr><th>Time</th><th>Type</th><th>Token</th><th>Qty</th><th>Entry</th><th>Rationale</th></tr></thead>
      <tbody id="ledrows"></tbody>
    </table>
    <div class="empty" id="lednone">ledger is empty</div>
  </div>
`
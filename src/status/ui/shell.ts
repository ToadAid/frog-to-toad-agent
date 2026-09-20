/** Shell: CSS + topbar + tab nav. The Desk tab keeps its original layout —
 * tabs ADD surfaces, they don't redesign the working one. Hash-routed so a
 * refresh lands back on the same tab. */
export const SHELL_CSS = String.raw`
  :root {
    --bg: #0b0e14; --panel: #11151f; --panel2: #161b28; --line: #232a3a;
    --text: #d7dce6; --dim: #7b8499; --green: #34d399; --red: #f87171;
    --amber: #fbbf24; --accent: #60a5fa; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    padding: 16px; max-width: 1100px; margin: 0 auto;
  }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: .5px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .topbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
  .badge { font-family: var(--mono); font-size: 12px; padding: 3px 10px; border-radius: 999px; font-weight: 700; }
  .badge.dry { background: #14352a; color: var(--green); border: 1px solid #1d5c45; }
  .badge.live { background: #3a1518; color: var(--red); border: 1px solid #7f2d33; animation: pulse 1.5s infinite; }
  .badge.brain { background: #14203a; color: var(--accent); border: 1px solid #274a7d; font-weight: 500; }
  @keyframes pulse { 50% { opacity: .55; } }
  .stat { font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .stat b { color: var(--text); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--dim); margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--dim); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; padding: 4px 8px 6px 0; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid #1a202e; font-family: var(--mono); font-size: 12.5px; }
  tr:last-child td { border-bottom: none; }
  .up { color: var(--green); } .down { color: var(--red); } .na { color: var(--dim); }
  .capbar { height: 8px; border-radius: 4px; background: var(--panel2); overflow: hidden; margin: 6px 0 4px; }
  .capbar > div { height: 100%; background: var(--accent); border-radius: 4px; transition: width .5s; }
  .capbar > div.hot { background: var(--amber); } .capbar > div.maxed { background: var(--red); }
  #feed { list-style: none; font-family: var(--mono); font-size: 12px; max-height: 260px; overflow-y: auto; }
  #feed li { padding: 3px 0; border-bottom: 1px solid #1a202e; display: flex; gap: 8px; }
  #feed li:last-child { border-bottom: none; }
  #feed .t { color: var(--dim); flex-shrink: 0; }
  #feed .k { flex-shrink: 0; width: 92px; font-weight: 700; }
  .k-run_started { color: var(--accent); } .k-tool_call { color: var(--amber); }
  .k-final { color: var(--green); } .k-error, .k-aborted, .k-kill { color: var(--red); }
  .k-tool_result { color: var(--dim); } .k-turn, .k-hello { color: var(--dim); }
  .k-desk_state { color: var(--amber); font-weight: 700; }
  .k-kronos_started { color: var(--accent); } .k-kronos_result { color: var(--accent); }
  #feed .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--dim); font-style: italic; font-size: 12.5px; padding: 6px 0; }
  #killbtn {
    background: #3a1518; color: var(--red); border: 1px solid #7f2d33; border-radius: 8px;
    font: 700 13px var(--mono); padding: 10px 22px; cursor: pointer; letter-spacing: 1px;
  }
  #killbtn:hover { background: #55191e; }
  #killbtn:disabled { opacity: .5; cursor: default; }
  #killresult { font-family: var(--mono); font-size: 12px; margin-left: 12px; }
  .conn { font-size: 11px; font-family: var(--mono); }
  .conn.on { color: var(--green); } .conn.off { color: var(--red); }
  .apr { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 8px 0; background: var(--panel2); }
  .apr .tool { font-family: var(--mono); font-weight: 700; font-size: 13px; }
  .apr .sum { font-size: 12.5px; margin: 4px 0 8px; word-break: break-word; }
  .danger-trade { color: var(--red); font-weight: 700; }
  .danger-write { color: var(--amber); font-weight: 700; }
  .danger-readonly { color: var(--dim); }
  .apr .meta { font-family: var(--mono); font-size: 11px; color: var(--dim); }
  .apr .btns { display: flex; gap: 8px; margin-top: 8px; }
  .apr button { flex: 1; border-radius: 6px; font: 700 12px var(--mono); padding: 7px 0; cursor: pointer; }
  .apr .yes { background: #14352a; color: var(--green); border: 1px solid #1d5c45; }
  .apr .no { background: #3a1518; color: var(--red); border: 1px solid #7f2d33; }
  .apr .done { color: var(--dim); font-family: var(--mono); font-size: 12px; text-align: center; }
  #spark { width: 100%; height: 54px; display: block; margin-top: 8px; }
  .hit { color: var(--green); } .miss { color: var(--red); }

  /* ── Tab shell (§12.9) ── */
  .tabs { display: flex; gap: 4px; margin: 4px 0 14px; flex-wrap: wrap; }
  .tabs a {
    color: var(--dim); text-decoration: none; font: 600 12.5px var(--mono);
    padding: 7px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer;
  }
  .tabs a:hover { background: var(--panel2); color: var(--text); }
  .tabs a.active { background: var(--panel); border-color: var(--line); color: var(--accent); }
  .tabpage[hidden] { display: none !important; }
  .refbtn {
    background: var(--panel2); color: var(--dim); border: 1px solid var(--line); border-radius: 6px;
    font: 600 11px var(--mono); padding: 4px 10px; cursor: pointer; float: right;
  }
  .refbtn:hover { color: var(--text); }
  .chip { display: inline-block; font: 600 11px var(--mono); padding: 2px 8px; border-radius: 999px; margin: 2px 4px 2px 0; background: var(--panel2); border: 1px solid var(--line); }
  .chip.bull { color: var(--green); } .chip.bear { color: var(--red); } .chip.warn { color: var(--amber); }

  /* Chat tab */
  #chatlist { font: 12px var(--mono); }
  #chatlist select { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font: 12.5px var(--mono); max-width: 340px; }
  #chatlog { display: flex; flex-direction: column; gap: 10px; max-height: 480px; overflow-y: auto; padding: 4px 2px; }
  .msg { max-width: 86%; border-radius: 10px; padding: 8px 12px; font-size: 13px; word-break: break-word; }
  .msg .meta { font: 10.5px var(--mono); color: var(--dim); margin-bottom: 3px; }
  .msg.user { align-self: flex-end; background: #14203a; border: 1px solid #274a7d; }
  .msg.assistant { align-self: flex-start; background: var(--panel2); border: 1px solid var(--line); }
  .msg.assistant .tools { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
  .msg.assistant .tools span { font: 10px var(--mono); color: var(--amber); background: #221d10; border: 1px solid #4a3a15; border-radius: 6px; padding: 1px 6px; }
  .msg.system, .msg.tool { align-self: center; background: transparent; color: var(--dim); font: 11px var(--mono); padding: 2px 8px; }
  .msg pre { background: #0b0e14; border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow-x: auto; font: 11.5px var(--mono); margin: 6px 0; }
  .msg code { font-family: var(--mono); font-size: 12px; }
  #composer { display: flex; gap: 8px; margin-top: 10px; align-items: flex-end; }
  #composer textarea {
    flex: 1; background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 8px;
    font: 13px/1.4 var(--mono); padding: 9px 10px; resize: vertical; min-height: 42px;
  }
  #composer button {
    background: #14203a; color: var(--accent); border: 1px solid #274a7d; border-radius: 8px;
    font: 700 12px var(--mono); padding: 10px 16px; cursor: pointer;
  }
  #composer button:disabled { opacity: .5; cursor: default; }
  #imgpick { font: 11px var(--mono); color: var(--dim); }
  #runstatus { font: 11px var(--mono); color: var(--accent); margin-top: 6px; min-height: 16px; }
  .imgbadge { font: 10px var(--mono); color: var(--accent); }

  /* Charts tab */
  .chartctl { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .chartctl select, .chartctl button {
    background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 6px;
    font: 12.5px var(--mono); padding: 6px 10px;
  }
  .chartctl button { background: #14203a; color: var(--accent); border-color: #274a7d; cursor: pointer; }
  #candlechart { height: 340px; }
  #rsichart { height: 110px; }
  #macdchart { height: 130px; }
  #dossier .notes { margin-top: 6px; }
  #dossier .notes div { font: 12px var(--mono); color: var(--dim); padding: 2px 0; }
  #charterr { color: var(--red); font: 12px var(--mono); margin: 10px 0; }

  /* Kronos tab */
  #kronosform { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  #kronosform select, #kronosform input, #kronosform button {
    background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 6px;
    font: 12.5px var(--mono); padding: 6px 10px;
  }
  #kronosform button { background: #14203a; color: var(--accent); border-color: #274a7d; cursor: pointer; }
  #kronosform input { width: 90px; }

  /* Settings tab */
  .cfgline { font: 12.5px var(--mono); color: var(--dim); padding: 4px 0; border-bottom: 1px solid #1a202e; }
  .cfgline b { color: var(--text); }
  .statebtn {
    border-radius: 8px; font: 700 12px var(--mono); padding: 9px 18px; cursor: pointer;
  }
  .statebtn.halt { background: #3a1518; color: var(--red); border: 1px solid #7f2d33; }
  .statebtn.resume { background: #14352a; color: var(--green); border: 1px solid #1d5c45; }
  .statebtn:disabled { opacity: .5; cursor: default; }
`

export const TOPBAR_HTML = String.raw`
  <div class="topbar">
    <h1>🐸 FROG-TO-TOAD AGENT</h1>
    <span id="mode" class="badge dry">…</span>
    <span id="brain" class="badge brain">…</span>
    <span class="stat">up <b id="uptime">–</b></span>
    <span class="stat">runs <b id="runs">0</b></span>
    <span class="stat">approvals <b id="appr">0</b></span>
    <span class="conn off" id="conn">● offline</span>
  </div>
  <nav class="tabs" id="tabs">
    <a href="#/desk">Desk</a>
    <a href="#/chat">Chat</a>
    <a href="#/charts">Charts</a>
    <a href="#/research">Research</a>
    <a href="#/kronos">Kronos</a>
    <a href="#/settings">Settings</a>
  </nav>
  <div id="runstatus"></div>
`

# FEATURE LIST — Frog-to-Toad Agent

> What the desk CAN do, by version. One page for the principal; file-level
> detail lives in `BUILD_LIST.md` (the building log) and the code itself.
> Verified state: **285/285 tests green, tsc clean** (2026-09-03).
> The desk runs in tmux (`desk`), dashboard http://127.0.0.1:8787, brain GLM
> via ollama, Telegram-first (@tobycoder_bot), Base mainnet wallet lane.

---

## v0.1 — The talking desk

The core loop, alive and safe:

- **Brain** — pluggable LLM client (zai/glm, openai, ollama presets; `LLM_PROVIDER`), streaming agent loop with per-agent system prompts (`agents/*.md`), tool calling, run interruption.
- **Telegram front door** — private desk (chat-id allowlist, deny-default), admin = the only approver; group privacy mode with @mention addressing; commands `/status /positions /agents /help /stop`.
- **Read-only market tools** — prices via redundant feed chain, candles, Fear & Greed sentiment, market search (DexScreener), token lookup by address.
- **Dry-run trading + approval cards** — every trade is quoted (`swap_quote`), then an approval card in Telegram (admin-only, auto-deny on timeout, deny-default); caps in CODE: $50/trade, $200/day, max open positions, blocked symbols/addresses, token allowlist.
- **Journal + memory** — every run journals; nightly reviewer distills lessons; per-agent memory.
- **Scheduler** — cron prompts run as the orchestrator in the admin chat, through the same loop and gates.

## v0.2 — The hardened research desk

Numbers-first opinions that leave a track record:

- **Address-first token identity** — non-major tokens trade ONLY by contract address; the desk never guesses an asset.
- **Feed redundancy** — CoinGecko → Binance → Coinbase chain on a shared circuit breaker; a dead feed is skipped for 5 min, never stalls a call.
- **Technical analysis engine** — numbers-first TA (EMA/SMA/RSI/ATR/Bollinger + more), signals with explicit numbers, no vibes.
- **TA signal grading** — every signal is graded later: hit/miss, move %, alpha vs BTC. Opinions become a measurable record.
- **Long-tail TA + position guardian** — hourly guardian watches open positions (stop/tp drift, stale positions).
- **TradingAgents steals** — alpha grading (vs BTC), bear-pass (every trade argued AGAINST before approval), mood read.
- **Chainlink onchain feeds** — the staple fallback when web feeds disagree (oracle sanity checks on majors).
- **Temporal awareness** — the desk knows the real current time/date (principal's timezone).
- **Kronos forecast lane** — foundation-model price bands, published with horizons, graded nightly. Open lane: any ticker the feeds serve, or a Base ERC-20 contract address pinpointed to its most liquid DexScreener pool (grading prices from the record's own pool — no horoscopes).
- **Self-audit lane** — the desk audits itself on demand (safety rails, ledger honesty).

## v0.3 — Real money + the living desk

- **External wallet lane** — signer lives in a separate MCP process; keys stay there, never in the agent or chat. Tool registration is deny-by-default. The public release bundles no Coinbase signer while its current AgentKit dependency tree has unresolved high-severity advisories.
- **AgentKit gotchas hardened at the source** — plain-content `{"success":false}` failures read as failures (the phantom-ledger fix), formatted-units stamped on balance replies, provider-namespaced allowlists, spawn-without-shell.
- **Desktop dashboard v2** — localhost-only tabbed workbench (§12.9): Desk (positions, PnL, approvals with full detail, kill switch, SSE live events), **Chat** (same loop + approval gate as Telegram, transcript read-back, image upload → vision lane), **Charts** (Binance klines + Base contract pools, vendored lightweight-charts candles + EMA/Bollinger overlays, RSI/MACD subpanels, the frog's TaDossier verdict under the chart), **Research** (signals track record, journal + lessons, news, F&G, TVL, stablecoins), **Kronos** (forecast records + accuracy + run-now button), **Settings** (read-only config + doctor + HALT/RESUME). No CDN, no secrets, one self-contained HTML.
- **Desk TUI** — terminal chat over the same localhost endpoints: same loop, same approvals, same gates.
- **Living Telegram** — progress drafts (one live bubble edited through run events), typing indicators, markdown rendering.
- **Continuity** — `USER.md` / `DESK.md` workspace memory the desk grows and CORRECTS (add/replace/remove, char caps, frozen-snapshot injection, mid-run nudges). It can unlearn a wrong fact.
- **Market news lane** — 4 RSS outlets, cross-post dedupe, freshness filter, circuit breaker.
- **Strategy backtesting** — deterministic simulator, anti-lookahead (signal on close i, fill at open i+1), fees+slippage both sides, 4 built-in strategies, honest metrics vs buy&hold. "One backtest is a LOOK, not a gate."

## v0.4 — The desk speaks first + the Nautilus armor

The desk informs FIRST (not an answer machine), then got a risk engine:

- **Morning brief** (cron) — deterministic digest: positions + PnL, Fear & Greed with zone framing, top headlines, Kronos record. No LLM in the ritual path.
- **Proactive sentinel** — speaks only when worth the shoulder-tap: F&G crossing into extremes, majors moving ≥5%/24h, stablecoin flow shifts; 12–24h cooldowns.
- **Onchain lane** — DefiLlama TVL (Base spotlighted) + stablecoin mint/burn flows.
- **Forecast grading** — Kronos bands judged nightly (in-band? direction?).
- **Trading state machine** (Nautilus steal) — ACTIVE / REDUCING / HALTED, persisted, survives restarts; principal-only (`/halt` `/reduce` `/resume`); corrupt state file fails CLOSED to HALTED; kill switch halts too.
- **Denial codes** — every guard refusal carries a stable code (`TRADING_HALTED`, `PER_TRADE_CAP_EXCEEDED`, `DAILY_CAP_EXCEEDED`, `MAX_OPEN_POSITIONS`, `SYMBOL_BLOCKED`, `ADDRESS_BLOCKED`, `NOT_ALLOWLISTED`, `INSUFFICIENT_BALANCE`, `PRECISION_EXCEEDED`, `INVALID_NOTIONAL`).
- **Boot reconciliation** — ledger vs wallet on every boot; phantom position = fail-closed HALTED + admin ping; inflated = warn. (Caught its own first parser bug on its maiden live run.)
- **Honest fills** — ledger records the ACTUAL fill (onchain balance delta > server quote > estimate), with tx hashes and the slippage floor.
- **Instrument precision + funding gate** — decimals honored (no silent truncation), $1 dust floor, wallet balance checked BEFORE an approval card goes out.
- **Watchdog** — the desk watches ITSELF: brain reachability + ritual staleness (silent scheduler = alert), separate from the market-watching sentinel.
- **Rotating state backups** — ledger + desk state keep 3 generations under `data/backups/`, rotated every boot.
- **Fail-closed portfolio view** — the view reports its own integrity (corrupt ledger lines, orphan closes, clamped closes); a hole flags every consumer (dashboard, morning brief ⚠️) instead of silently showing 0.
- **Signal lifecycle** — signals walk legal states (PROPOSED → ACTIVE → CLOSED); CLOSED is terminal, so grading is idempotent by STATE, not string-matching; full audit trail in `data/signals/lifecycle.jsonl`.
- **Approval-card throttle** — max 3 cards pending + 5s minimum between cards; a runaway loop can't spam the principal's phone, and an un-sent card is a denied card.
- **Onchain token audit (`token_audit`)** — keyless Base security reads the market lanes can't see: LP burn % on the pair LP, live owner() renounce read, mint-in-verified-source scan, upgradeable-proxy detection, top-10 holder concentration. Missing data is a flag, never assumed clean; verdict applies to the exact address only.

## The armor, in one place (how it's protected)

1. Caps in code, not prompts ($50/trade, $200/day, max positions)
2. Every trade: guard precheck → oracle sanity → approval card (admin-only, auto-deny, deny-default)
3. Trading state machine — principal-owned, fail-closed
4. Signer in a separate process; keys stay in that server's private environment, never in chat
5. Kill switch: aborts runs, denies approvals, HALTS trading (persists)
6. Ledger is append-only truth; positions/PnL derived by folding it; reconciled against the wallet at boot; backed up before every boot
7. Status server binds 127.0.0.1 only
8. Dry-run rollback = one env line (`DRY_RUN=true`)

## In the forge (next versions)

- **v0.5 ✅ shipped 2026-09-03** — all 8 Nautilus steals cut; 302/302 tests green; ledger integrity, signal lifecycle, approval throttle live on the desk.
- **v0.6 — the frog gets hands (Phase 12): 12.0 doctor gate ✅ → 12.1 sandboxed workspace ✅ → 12.2 subagent scouts ✅ → 12.3 safe exec ✅ → 12.4 coding ability ✅ → 12.5 browser tool ✅ → 12.6 Codex web-login brain ✅ (`BRAIN=glm|codex`, `npm run desk login`, keyfile chmod 600; 401/401 tests 2026-09-03) → 12.6b brain setup menu ✅ (`desk login` = codex/zai/ollama/openai picker; wizard writes switches only, keys pasted by hand; THREAD_MESSAGES 80, memory caps env-tunable; 413/413 tests) → 12.7 onboarding wizard ✅ (`npm run onboard` — fresh box → talking frog: checklist, masked token + chat-id discovery, brain menu, systemd unit, boot watch, doctor, handshake ping; restoreThreads wired; 458/458 tests 2026-09-03). Remaining: 12.8 packaging + multi-platform installer (last).**
- **Also queued**: 12.9 Dashboard v2 — tabbed workbench (Proma steal): Charts tab (vendored lightweight-charts + our ta.ts overlays — human-readable candles), Chat tab on the /prompt lane incl. chart-screenshot upload → vision lane, Research tab (signals/lessons/news/sentiment/TVL), Kronos tab (forecasts + accuracy), Settings tab (read-only + HALT/RESUME); tax/honeypot simulation (the last audit-gap item — needs a sim lane); desk lifecycle CLI + systemd --user unit.

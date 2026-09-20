# Cobo Agentic Wallet — one-time onboarding runbook

> Do this ONCE, whenever you're ready to stand up the second safe. Everything
> here is done by YOU (the wallet owner) at a terminal — none of it is
> autonomous, none of it touches mainnet funds until you choose Stage C.
> Keys end up in `cobo-wallet-server/.env` ONLY — never the agent's `.env`.

---

## What you need before starting

- [ ] A **Cobo invitation code** for Agentic Wallet (request it from Cobo / your Cobo contact — onboarding cannot start without it)
- [ ] Your phone, to install the **Cobo Agentic Wallet app** (this is where pacts get activated — it is the second human approval layer above the desk's Telegram gate)
- [ ] The agent repo checked out, for example: `/path/to/frog-to-toad-agent`

## What exists already (no action needed)

- `cobo-wallet-server/venv/` — Python venv with the official `cobo-agentic-wallet[mcp]` server installed (v0.1.40, fastmcp stdio)
- `cobo-wallet-server/run.sh` — launcher: loads `.env`, execs `python -m cobo_agentic_wallet.mcp`
- Desk-side bridge (`src/mcp/bridge.ts`) — verified live against the real Cobo server (tools/list OK, 2026-09-02)

---

## Stage A — install + onboard (terminal, ~10 min)

```bash
# 1. Install the caw CLI (standalone binary)
curl -fsSL https://raw.githubusercontent.com/CoboGlobal/cobo-agentic-wallet/master/install.sh | bash
export PATH="$HOME/.cobo-agentic-wallet/bin:$PATH"   # add to ~/.bashrc too
caw --version

# 2. Onboard — interactive wizard, needs the invitation code
caw onboard --wait --invitation-code <YOUR-INVITATION-CODE>
# (run through several phases until wallet status becomes "active")
```

## Stage B — pair the wallet owner (phone + terminal)

The **owner pairing** is what makes you the human in the loop forever after:
every pact the desk submits waits for YOUR activation in the app.

```bash
# 3. Generate an 8-digit pairing token
caw wallet pair --code-only

# 4. On your phone: install the "Cobo Agentic Wallet" app, enter the token

# 5. Confirm pairing is complete
caw wallet pair-status
```

## Stage C — testnet rehearsal (free, recommended before anything real)

```bash
# 1. Get a Sepolia address
caw address list

# 2. Claim testnet ETH from the built-in faucet
caw faucet deposit --token-id SETH --address <your-seth-address>

# 3. Wait for it to land
caw wallet balance
```

Then do one full pact + transfer cycle by hand, so you know the machinery:

```bash
caw pact submit \
  --intent "Test ETH transfer on Sepolia" \
  --execution-plan "Transfer 1 ETH on Sepolia for testing." \
  --policies '[{"name":"allow-transfer","type":"transfer","rules":{"effect":"allow","when":{"chain_in":["SETH"],"token_in":[{"chain_id":"SETH","token_id":"SETH"}]},"deny_if":{"amount_gt":"1"}}}]' \
  --completion-conditions '[{"type":"tx_count","threshold":"1"}]'

# Approve the pact in the app when it arrives, then:
caw pact status --pact-id <PACT_ID>
caw tx transfer --pact-id <PACT_ID> --dst-address 0x1111…1111 --token-id SETH --amount 0.01 --chain-id SETH
```

Try an oversized amount too — you'll see the policy denial come back with
`code / reason / suggestion`. That's the same denial shape the desk's LLM
reads and adapts to.

## Stage D — credentials into the server's env

```bash
caw wallet current --show-api-key     # note api_url, api_key, wallet_uuid

cd /path/to/frog-to-toad-agent/cobo-wallet-server
cp .env.example .env
# edit .env: AGENT_WALLET_API_KEY=…   (api_url default is already correct)
chmod 600 .env
```

Keep the `AGENT_WALLET_INCLUDE_TOOLS` preset as shipped — it deliberately
excludes `contract_call`, `message_sign`, `payment`, and `create_delegation`.

## Stage E — flip the desk gate (testnet allowlist first)

Edit the desk's `.env`:

```env
DRY_RUN=false
EXECUTION_MODE=cobo-mcp
MCP_COMMAND=bash cobo-wallet-server/run.sh
# First flip: OBSERVER ONLY — nothing can move, even in real mode
MCP_ALLOWED_TOOLS=list_wallets,get_wallet,get_balance,list_transaction_records,get_audit_logs
```

Boot the desk (`npm run dev`) and confirm the log line:
`wallet lane: registered [mcp_list_wallets, …], skipped … not on the allowlist`.

Ask the orchestrator in Telegram: *"what's our Cobo wallet balance?"* — it
should call `mcp_get_balance` and answer. Nothing can move: `transfer_tokens`
is not on the allowlist.

## Stage F — widen to transfers (testnet first)

```env
MCP_ALLOWED_TOOLS=list_wallets,get_wallet,list_wallet_addresses,get_balance,submit_pact,get_pact,list_pacts,transfer_tokens,estimate_transfer_fee,get_transaction_record_by_request_id,list_transaction_records,get_audit_logs
```

Restart. On testnet, run one desk-driven transfer end-to-end: the desk
submits the pact → **you approve it in the app** → the desk executes within
the pact's policy → you see it in `get_audit_logs`. After that rehearsal,
mainnet is a policy decision, not a code change.

## Rollback (any time, one line)

```env
DRY_RUN=true
```

The wallet server stops being spawned, the desk returns to simulation, and
nothing on the Cobo side changes.

---

## Known boundaries (recorded 2026-09-02)

- **No swaps on this lane.** Cobo has no native swap tool; `swap_execute`
  refuses with an explanation. Swaps run on the Coinbase lane
  (`EXECUTION_MODE=coinbase-mcp`).
- **`contract_call` is excluded** until a DEX router + calldata encoder is
  deliberately wired — the desk never fires opaque calldata.
- The Cobo lane's MCP tool names surface in the desk as `mcp_<name>`
  (e.g. `mcp_transfer_tokens`); agents' frontmatter tool lists must name
  them that way.
- Standing gates still apply before MAINNET funds: ~30 graded signals with
  positive expectancy vs BTC, the wallet-sizing conversation, and the
  dashboard approval-detail view.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Missing API key. Set AGENT_WALLET_API_KEY…` | `.env` missing/not sourced — check `cobo-wallet-server/.env` exists and `run.sh` is the MCP_COMMAND |
| Tool listed by server but not registered by desk | It's not in `MCP_ALLOWED_TOOLS` (deny-by-default) — add it explicitly |
| `wallet.json`/pairing confusion | Pairing state lives with the `caw` CLI (`caw wallet pair-status`), not in the desk |
| venv missing after clone | `cd cobo-wallet-server && python3 -m venv venv && ./venv/bin/pip install 'cobo-agentic-wallet[mcp]'` |
| Pact sits in PENDING_APPROVAL | That's the design — activate it in the Cobo Agentic Wallet app, then `get_pact` shows ACTIVE |

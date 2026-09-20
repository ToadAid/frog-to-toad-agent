#!/usr/bin/env bash
# Cobo Agentic Wallet MCP stdio server launcher.
#
# Loads keys from cobo-wallet-server/.env (NEVER the agent's .env), then execs
# the official Cobo MCP server (`python -m cobo_agentic_wallet.mcp`) from the
# pinned venv. stdout is the MCP protocol — everything else must go to stderr.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "[cobo-wallet-server] venv missing — run: python3 -m venv venv && ./venv/bin/pip install 'cobo-agentic-wallet[mcp]'" >&2
  exit 1
fi

# Load .env into this process only (keys never enter the desk process).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export AGENT_WALLET_API_URL="${AGENT_WALLET_API_URL:-https://api.agenticwallet.cobo.com}"
# Tool narrowing lives in .env (AGENT_WALLET_INCLUDE_TOOLS) — see .env.example.

exec ./venv/bin/python -m cobo_agentic_wallet.mcp

# Frog-to-Toad Agent

A Telegram-controlled trading agent frog. Talks like a trader, thinks with
your choice of LLM brain, and never signs a live order until you tell it to.

## Fresh box → talking frog

```bash
git clone https://github.com/ToadAid/frog-to-toad-agent.git
cd frog-to-toad-agent
./install.sh --check
./install.sh
```

The first public release targets Linux with Node.js 24+. The installer is a
small, non-root wrapper around the locked npm install and the existing
resume-safe onboarding wizard. It never reads secrets or enables live trading.
See the full [installation and update manual](docs/installation.md), including
the equivalent manual `npm ci && npm run onboard` path.

The wizard walks the whole first run:

1. **Telegram bot token** — create a bot with [@BotFather](https://t.me/BotFather),
   paste it with masked input (never printed, never logged), verified live via
   `getMe`.
2. **Your Telegram identity** — send your bot a message and the wizard records
   both the private admin chat and your distinct sender user ID (or asks for both manually).
3. **Brain** — the same menu as `npm run desk login`: Codex (ChatGPT
   web-login OAuth, no API key), Z.ai GLM, Ollama (local), or OpenAI.
   API keys are always pasted into `.env` by hand — the wizard never touches secrets.
4. **`.env`** — written for you; `DRY_RUN=true` is forced on a fresh install.
5. **systemd --user unit** — rendered from `deploy/frog-to-toad-agent.service`,
   enabled, linger attempted best-effort (Linux only for now).
6. **First boot** — watched to the `frog-to-toad-agent is live.` marker, doctor gate
   reported.
7. **Handshake** — a ping lands in your chat; press `/start` and talk to the frog.

Resume-safe: rerun `npm run onboard` any time — existing `.env` values are
kept unless you replace them.

## Manual fallbacks (the wizardless path)

- Telegram: configure `TELEGRAM_ADMIN_CHAT_ID` for the private conversation and
  `TELEGRAM_PRINCIPAL_USER_ID` for your Telegram account's positive sender ID.
- Brains: see `docs/codex-brain.md` and the `.env.example` presets.
- Controls: `npm run desk status | start | stop | restart | logs | follow | login | onboard`.
- `npm run doctor` — full pre-flight (tsc + tests) that opens the hands gate
  for 7 days; the cheap gate runs at every boot.

## Community-agent core

This branch carries the reusable agent runtime from the donor desk without its
perps, LP, sniper, paper-execution, or other trading-specific lanes. The core
now includes:

- plan-first runs (`/plan <task>`) with read-only planning and a separate
  approval before execution;
- bounded after-turn follow-ups, task notifications, token-budget
  continuations, transcript checkpoints, and `/rewind`;
- session-memory extraction, optional memory-carried compaction, magic
  documents, and background memory consolidation;
- operator-editable output styles, typed agent mailboxes, and isolated
  subagent/skill execution with narrowing-only tool lists.

### Skills

Put each playbook at `skills/<name>/SKILL.md`. A user-invocable playbook can be
typed directly as `/<name> [arguments]` in Telegram or the TUI. Skills with
`context: fork` run in a fresh context and do not read or append the parent
transcript. `allowed-tools` can only remove tools from the agent's existing
allowlist; it never grants authority. Unknown slash commands remain ordinary
prompt text.

### Optional CodeGraph repo eyes

Repository inspection is read-only and grants no execution or approval
authority. The reviewed binary is checksum-pinned in `codegraph.lock.json` and
installed locally rather than trusting a different global version:

```bash
npm run codegraph:bootstrap
npm run codegraph:status
```

CodeGraph is optional. A missing or mismatched binary is reported honestly as
unavailable/error while the main runtime remains usable.

## Community and license

Frog-to-Toad Agent is community software released under the [MIT License](LICENSE).
See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and report
security issues privately as described in [SECURITY.md](SECURITY.md).

## Safety rails

- `DRY_RUN=true` is the default — every order is simulated. Flipping to live
  requires an external MCP wallet lane (see `.env.example`); wallet keys live
  ONLY in that separate signer process, never in the agent `.env`, chat, or logs.
- The public release does not bundle the Coinbase AgentKit signer because its
  current dependency tree has unresolved high-severity advisories. Bring a
  separately reviewed compatible MCP server or use the Cobo onboarding path.
- Approval is principal-only (`TELEGRAM_PRINCIPAL_USER_ID`); an unsent approval card
  is a denied card.
- Local command execution requires a functioning Bubblewrap namespace, not just an
  installed `/usr/bin/bwrap`. If the host kernel refuses that namespace,
  `exec_run` fails closed with an explicit sandbox-unavailable error; it never
  falls back to unsandboxed execution.
- Actor authority is carried through planning, skills, subagents, memory, and
  mailbox delivery. Approval of a guest-originated plan does not turn that
  guest into the principal.

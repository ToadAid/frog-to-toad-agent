# Installation

## Supported release target

The first public release supports Linux on x64 or arm64 with:

- Git;
- Bubblewrap (`bwrap`) for isolated tool execution;
- Node.js 24 or newer and npm;
- a normal, non-root login account;
- a reachable `systemd --user` manager for unattended operation;
- a Telegram bot token and your Telegram chat/user IDs;
- one supported brain: Codex login, Z.ai, OpenAI-compatible API, or Ollama.

macOS and Windows are not packaged yet. The runtime can be started manually on
other systems, but the public installer and background-service setup are Linux
only for this release.

Install Bubblewrap with your distribution's package manager before running the
installer—for example, `sudo apt install bubblewrap` on Debian/Ubuntu or
`sudo dnf install bubblewrap` on Fedora.

## Install from a trusted checkout

Clone the public repository, inspect the installer if desired, and run it from
an interactive terminal:

```bash
git clone https://github.com/ToadAid/frog-to-toad-agent.git
cd frog-to-toad-agent
./install.sh --check
./install.sh
```

The installer deliberately stays small. It checks the platform and required
commands, verifies Node.js 24+, requires the committed dependency lock, runs
`npm ci`, and hands control to the existing resume-safe onboarding wizard.

It does **not** use `sudo`, install operating-system packages, enable live
trading, install CodeGraph, or read secrets. Telegram and brain credentials are
entered only inside onboarding. A fresh configuration is forced to
`DRY_RUN=true`.

## What onboarding configures

The wizard:

1. verifies the Telegram bot token without printing it;
2. binds both the private admin chat and the principal's distinct sender ID;
3. configures the selected LLM brain;
4. creates or updates the ignored local `.env`;
5. installs and enables the per-user systemd unit on Linux;
6. boots the agent and checks its doctor state;
7. sends a Telegram handshake and optionally runs the full doctor.

The wizard and installer are safe to rerun. Existing configuration values are
kept unless the operator explicitly replaces them.

The installed user service is `frog-to-toad-agent.service` and its default log
is `/tmp/frog-to-toad-agent.log`. Existing donor installations that set
`TRADING_DESK_DIR` remain compatible; new installations should use
`FROG_TO_TOAD_DIR` if a root override is needed.

If you ran the donor-era systemd unit, retire it once before onboarding the
community release so two bot processes cannot poll Telegram at the same time:

```bash
systemctl --user disable --now trading-desk.service
npm run onboard
```

## Manual installation

If the installer cannot be used, the equivalent dependency/onboarding path is:

```bash
npm ci
npm run onboard
```

For a foreground development run instead of systemd:

```bash
npm run dev
```

## Verify the installation

```bash
npm run desk status
npm run doctor
```

Useful operational commands:

```bash
npm run desk logs
npm run desk follow
npm run desk restart
```

The dashboard and TUI bind to the local machine. Start the TUI with:

```bash
npm run tui
```

## Optional CodeGraph repo eyes

CodeGraph is not required for the agent to run. To install the reviewed,
checksum-pinned local binary and initialize the repository index:

```bash
npm run codegraph:bootstrap
npm run codegraph:status
```

A missing or mismatched CodeGraph installation degrades honestly without
granting execution authority or stopping the main runtime.

## Updating

Stop the service, update the trusted checkout, reinstall the exact dependency
lock, rerun onboarding if configuration or the unit changed, and restart:

```bash
npm run desk stop
git pull --ff-only
npm ci
npm run onboard
npm run desk restart
```

Never commit `.env`, `data/`, external-wallet credentials, or Codex OAuth
state. Those paths are ignored and must remain local to the operator's machine.

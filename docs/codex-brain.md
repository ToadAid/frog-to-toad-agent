# The Codex brain — ChatGPT web-login OAuth (§12.6)

The desk can think with a second brain: **OpenAI Codex models**, authenticated
the way the Codex CLI does it — you log in ONCE with your ChatGPT account in a
browser, and the tokens live in a local keyfile. No API key, no `sk-…`, no
billing surprises from the API-key lane.

> The same pick is offered inside the first-run wizard: `npm run onboard`
> (§12.7). This doc is the manual path.

## One-time login

```bash
npm run desk login
```

This is the **brain setup menu** — pick any of the four lanes:

1. **Codex** — ChatGPT web-login → OAuth keyfile (the lane this doc is about)
2. **Z.ai** — GLM via API key (the desk's default brain; key pasted by hand)
3. **Ollama** — local models, no key, no internet (the command probes
   `127.0.0.1:11434` and lists your pulled models)
4. **OpenAI** — standard API key lane

In every lane the wizard writes only NON-SECRET switches (`BRAIN`,
`LLM_PROVIDER`, `LLM_MODEL`) into `.env`. **API keys are always pasted by you
into `.env` by hand** — wizard code never touches secrets, same discipline as
the keyfile. Scripted (non-TTY) runs skip the menu and do the Codex login
directly.

For the Codex pick specifically:

- A browser window opens at `auth.openai.com` (a loopback server on
  `127.0.0.1:1455` catches the redirect; if the browser doesn't open, paste the
  printed URL into any browser — works headless too).
- Tokens land in `data/state/codex-auth.json`, **chmod 600**, gitignored.
  Same discipline as an external wallet signer: NEVER in the agent `.env`, NEVER in
  chat, never printed.
- Safe to run while the desk is live — the client re-reads the keyfile, so a
  fresh login is picked up without a restart.
- Re-running it anytime just re-forges the keyfile. It never touches
  `~/.codex/auth.json` (the Codex CLI's own copy) — the desk keeps its own
  tokens so the two can't invalidate each other's refresh.

## Switching brains

In `.env`:

```bash
BRAIN=codex   # Codex models via the ChatGPT keyfile (needs npm run desk login)
BRAIN=glm     # default — the LLM_PROVIDER lane (zai / openai / ollama / custom)
```

`CODEX_MODEL` overrides the model (default `gpt-5.6-sol`; use
`gpt-5.6-terra` for balanced everyday work or `gpt-5.6-luna` for the fastest,
lowest-cost lane). ChatGPT-login model availability changes over time; see the
[current Codex model list](https://learn.chatgpt.com/docs/models).
Flip with `npm run desk restart`. The boot log always states which brain is
loaded, and `npm run desk status` / the dashboard show it too.

The old `LLM_PROVIDER=codex` preset (Responses API with a standard API key) is
unchanged — that's the API-**key** lane; `BRAIN=codex` is the web-**login**
lane. Pick one, they don't mix.

## What happens when the token dies mid-run

- Access tokens refresh **silently** (the CLI's policy: proactively when close
  to expiry, and one refresh-and-retry if the server answers 401).
- If the refresh token itself is dead (expired, revoked, logged out elsewhere),
  the desk fails **loud** with the fix in the message:
  `Codex refresh token rejected … — re-auth needed: npm run desk login`.
- Nothing else moves: safety rails, caps, halt state and approvals are
  untouched, and the error shows up in the admin chat like any other run error.
  Run `npm run desk login`, done.

## Chart vision

The codex brain takes images on the same lane the GLM brain uses — send a
chart screenshot to the desk on Telegram and it reaches the model as an
`input_image` on the Responses wire (the desk's vision lane was built
provider-agnostic in the §12.5 bonus).

## Doctor & watchdog

- The doctor's brain stage checks the **keyfile locally** (present + valid or
  refreshable) — no network call, no `/models` probe.
- The watchdog alerts the admin chat if the keyfile is missing or dead:
  `codex brain keyfile missing or dead — run: npm run desk login`.

# D0 — Sandbox Sovereignty

Canonical Frog parent: `7b2d844f56b6629c55ee75986e2542d6df1a005f`
Pinned donor: `ToadAid/trading-desk@e8707787149354af7be60bdf7e1b8b1bc9af647d`

## Law

**The Frog owns the laboratory. The principal owns promotion into the organism.**

Inside `data/sandbox/`, the Frog may write experimental code, tests, notes,
strategy-parameter files, and candidate skills under `data/sandbox/skills/`.
It may inspect its current source mirror and run only principal-allowlisted
commands.

Those rights stop at the sandbox boundary.

## Mechanical boundary

`exec_run` remains deny-default and never invokes a shell. D0 additionally
requires `/usr/bin/bwrap` and executes with:

- `--unshare-all` — no host network namespace;
- host root read-only;
- `/home` hidden behind tmpfs;
- only the Frog sandbox writable at `/tmp`;
- `data/sandbox/repo/` remounted read-only;
- scrubbed child environment;
- bounded output, timeout, and append-only execution receipts.

Missing Bubblewrap means refusal. There is no fallback host exec.

## Source mirror

At boot, `data/sandbox/repo/` is refreshed from an explicit tracked-file
allowlist. State, credentials, wallet data, lockfiles, and arbitrary host files
are excluded. Workspace writes refuse `repo/**`; coding snapshots/diffs
exclude the mirror.

## Candidate skills

A file under `data/sandbox/skills/` is a candidate skill, not a canonical
runtime skill. It is not automatically loaded into tracked `skills/`, agent
allowlists, prompts, or production wiring.

Promotion remains:

sandbox artifact → tests/evidence → diff → review → tracked branch → exact-head
green CI → explicit principal authorization → merge.

The Frog may improve capability. It may not self-grant permissions, risk,
wallet authority, infrastructure authority, or production code authority.

## Runtime truth

`runtime_status` exposes current brain/provider/model, DRY_RUN vs LIVE,
trading state, hands state, and doctor health without reading `.env`.

## Non-effects

D0 does not change A0 approval law, A1 finite simulated treasury, A2
principal-owned wake cadence, live wallet authority, risk ceilings, graduation,
or skill-promotion authority.

**The Frog may earn resources. The Frog may not earn sovereignty.**

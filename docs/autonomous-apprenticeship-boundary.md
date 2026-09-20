# Frog-to-Toad A0 — Autonomous Apprenticeship Boundary

## Purpose

A0 removes the human from exactly one simulated decision seam so the Frog can
begin learning to act without being steered. It does **not** grant live-money
autonomy and it does not disable the desk's safety architecture.

## Constitutional rule

A guarded tool call may bypass the human approval card only when **all** of the
following are true:

1. `AUTONOMOUS_DRY_RUN=true` was explicitly configured by the operator.
2. `DRY_RUN=true` is still in force.
3. The tool name is exactly `swap_execute`.
4. The registered danger class is exactly `trade`.

If any condition is false, the original approval path remains authoritative.
`AUTONOMOUS_DRY_RUN=true` together with `DRY_RUN=false` is an invalid config and
boot is refused.

## Authority explicitly NOT granted

A0 does not auto-approve raw MCP transfers, ERC-20 approvals, spend permissions,
workspace writes, command execution, future guarded tools, or any live wallet
operation. The Frog cannot enlarge this exception through prompting or memory.

A0 also does not modify the desk trading state machine, code-level trade guard,
address-first identity, oracle sanity checks, precision/funding checks, ledger,
external signer boundary, kill switch, or reconciliation behavior.

## What A0 does not build yet

- no autonomous wake/exploration scheduler
- no finite simulated treasury
- no expedition/epoch journal
- no graduation evaluator
- no live funding

Those are separate reviewed cuts after this approval seam proves clean.

## Acceptance evidence

The focused tests must prove:

- the exact DRY_RUN `swap_execute` exception can execute without a human gate;
- autonomous mode defaults off;
- a different guarded tool is still denied without a gate;
- `swap_execute` is still denied if `DRY_RUN=false` even in a malformed in-memory config;
- the real config loader refuses `AUTONOMOUS_DRY_RUN=true` with `DRY_RUN=false`;
- the complete inherited test suite and TypeScript check remain green.

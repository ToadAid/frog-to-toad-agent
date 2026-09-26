# Governed Capability Runtime Integration

This document tracks the narrow integration of `@toadaid/agent-capabilities` into the Frog-to-Toad Agent runtime.

The capability library has already passed its deterministic clean-room V1 proof. Runtime integration preserves its core laws: installed is not authorized, saved state is not permission, delegation only narrows, and uncertain mutation outcomes are never blindly retried.

## A0-W1 — Durable run persistence gate

Status: implemented by this cut.

The host runtime owns persistence and concurrency. Capability envelopes remain opaque data to this store.

The persistence gate provides:

- one in-process serialization queue per run;
- an O_EXCL cross-process run lock with an ownership token;
- durable temp-file + fsync + atomic rename writes;
- a monotonic per-run fencing token so a superseded worker cannot keep writing governed state;
- exact compare-and-swap on the expected stored head SHA;
- SHA-256 sealed stored heads and canonical payload hashes;
- hashed run/slot path identities so untrusted IDs cannot escape the runtime-owned state root;
- fail-closed lock behavior: a stale or malformed lock is not permission to steal it.

The fence is a host-writer fence, not provider authority. Runtime tool execution must still recheck the current fence immediately before H1 start. External mutation replay remains governed by X1; this store does not claim a provider understands the local fencing token.

## A0-W2 — Paused interrupt restart contract

Status: next cut.

When an OPEN P10 human interrupt is bound to P4 revision N, process restart must passively reload that exact paused capsule. The supervisor must not advance it to N+1 before the interrupt is resolved and its resume proof is created. Only after that proof exists may the run checkpoint/resume.

## A0-W3 — Narrow read-only capability slice

Status: pending A0-W1 and A0-W2.

First real slice should enable only bounded research/workspace evidence and typed human interruption. Browser mutation, persistent authenticated sessions, review fixes, workspace restore, secret materialization, stealth, wallet/trading, and Git mutation remain blocked.

### Distribution note

`ToadAid/frog-to-toad-agent` is a public install surface while `@toadaid/agent-capabilities` remains private during alpha. Do not add a mandatory private Git dependency to this public package. The first deployed adapter may use a private/operator installation seam; public dependency wiring waits until the capability SDK is deliberately published or otherwise made anonymously installable.

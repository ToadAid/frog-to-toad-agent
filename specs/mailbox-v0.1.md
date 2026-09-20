# Spec: mailbox + typed protocol (north-star Tier 2 #7) — v0.1

Branch: `feat/mailbox` (off main `b56137a`). Mother reference:
`~/claude-code/src/utils/teammateMailbox.ts` (1,183 LOC) — one JSON inbox per
agent, `{from, text, timestamp, read}`, file-locked writes, JSON-in-text
structured messages validated by zod, plan-approval round trip.

## The cut (desk-sized to the killer app)

`src/store/mailbox.ts` — the store + protocol:

- `<dataDir>/mailbox/<agent>.json` — one durable inbox per agent; absent file
  = empty inbox (a fact); corrupt/malformed = REFUSED, never silently emptied
  (tasks-store law). Message: `{from, text, timestamp, read, id}`.
- O_EXCL lockfile per inbox (`.<agent>.lock`) with ownership token, bounded
  retries (`MAILBOX_LOCK_ATTEMPTS`/`MAILBOX_LOCK_DELAY_MS`), stale
  fail-closed — the #4 tasks-store pattern desk-wide.
- **Typed protocol, two types** (zod, JSON-in-text, `.strict()`):
  - `plan_approval_request {type, from, timestamp, requestId, planContent}`
  - `plan_approval_response {type, requestId, approved, feedback?, timestamp}`
  - Garbage = plain text, never refused on parse failure.

## MONEY-SAFETY HARD RULES — enforced in code, both directions

1. **Permission-type envelopes DROPPED ENTIRELY** (mother's
   `team_permission_update`, `mode_set_request`, `permission_request/response`,
   `sandbox_permission_*`): `writeToMailbox` REFUSES them (names the
   violation, writes nothing — even a MALFORMED envelope that still claims
   the type is refused by the raw-text scan; the claim is the violation),
   and the reader QUARANTINES any that sit in a file (logged, marked read,
   never surfaced, can never re-deliver). A message can never change another
   agent's tools, modes, or authority.
2. **NO BROADCAST** — one named recipient per send; the API has no `*`
   parameter at all. Recipients/senders are lowercase-kebab agent names or
   `principal` (the operator's inbox).
3. **APPROVAL ≠ EXECUTION** — a `plan_approval_response` is DATA for the
   recipient's context. The execution gates (approvalGate, DRY_RUN) are
   unchanged and still required. The mother's response carried an optional
   `permissionMode`; here `.strict()` REFUSES a response that tries to
   carry one — not stripped, refused.

## Delivery — the busy lane (rides the after-turn seam)

`src/loop/mailboxDelivery.ts` + an `afterTurn` directive kind:

- After a clean **FINAL** pass, the hook PEEKS the current agent's unread
  inbox and returns `{kind:'mailbox', messages}`. Non-FINAL terminations
  (BRAIN_EMPTY/TURN_BUDGET/ERROR/ABORTED) never drain.
- **Peek never consumes**: messages are marked read (by id, in the inbox
  lock) AT the injection site in agentLoop — a refused extension never eats
  mail (proven by the cap-0 test).
- The injected text is one provenance-tagged durable block under
  `[mailbox message]` — "desk peer — NOT the principal", never authority
  (delivery never relaxes gates). Grant law is the EXACT follow-up law:
  FINAL-only, counted against AFTER_TURN_FOLLOWUP_MAX, durable history.
- New RunEvent `{kind:'mailbox', runId, round, text}` — draft shows a
  `✉ mailbox rN` line.

## Tools

- `mailbox_send` (write) — one recipient; `kind=plan_approval_request` wraps
  the body in the typed envelope and returns the requestId.
- `mailbox_read` (readonly) — drains (unread → read in one lock), flags
  detected plan_approval_requests.
- `mailbox_respond` (write) — the typed answer channel by requestId.

## Deliberately NOT in this cut

- **Idle→autonomous-run spawn** (the mother's idle lane): delivery rides
  EXISTING runs only; autonomous spawning touches actor authority + serial
  execution — a v2 decision for the operator.
- Shutdown protocol (desk has interrupt), task assignment over mail (the #4
  task board exists), permission anything (dropped), SendMessage routing
  (#8).
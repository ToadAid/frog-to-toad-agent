# A2 — Durable Autonomous Wake Loop

A2 gives the Frog a clock. It does not give the Frog more authority.

> The principal owns cadence. The frog owns only what it does inside an already authorized wake.

## Explicit opt-in

There is deliberately no default wake schedule.

```text
APPRENTICESHIP_WAKE_CRON=<5-field cron in USER_TIMEZONE>
```

Blank/unset means no autonomous apprenticeship clock.

A configured wake cron is valid only when:

- it is exactly five cron fields (minute granularity);
- `AUTONOMOUS_DRY_RUN=true`;
- `DRY_RUN=true`;
- `APPRENTICESHIP_SEED_USD` is already valid under A1;
- `TELEGRAM_ADMIN_CHAT_ID` exists so the scheduled run has an authorized conversation lane.

A2 never enables live execution.

## Reuse the inherited scheduler

A2 does **not** create a second cron engine.

The existing `Scheduler` and `data/scheduled_tasks.json` remain the timing layer.
A2 reserves one fixed runtime-owned task id:

```text
frog-apprenticeship-wake
```

At boot, external config is normalized into that task **before** scheduler jobs
are armed. Changing the cron replaces the persisted task. Clearing the env var
removes it on the next restart.

The task is marked `permanent`. Agent-facing `schedule_delete` cannot remove it.

## The frog cannot grow its own clock

When `AUTONOMOUS_DRY_RUN=true`, `schedule_create` and `schedule_delete` are
force-added to `guardedTools` even if `GUARDED_TOOLS` is supplied as an env
override.

A0 still auto-allows only the exact DRY_RUN `swap_execute` exception. Therefore
schedule mutation stays on the human approval path.

The principal changes the apprenticeship clock externally, not by letting the
frog schedule more copies of itself.

## Claim before effect

Reminder-grade cron metadata is not enough for autonomous execution.

For each local cron minute, A2 derives a timezone-bound slot such as:

```text
2026-09-04T07:36
```

Before the agent run begins, A2 creates:

```text
data/apprenticeship/wake-claims/<slot>.claim
```

using filesystem `O_EXCL` (`wx`) with mode `0600`.

That claim is the no-duplicate boundary. If the file already exists, the wake is
classified `duplicate` and no agent run starts.

The claim is never automatically reclaimed.

## Crash / restart law

A2 promises **at-most-once automatic execution per local wake slot**, not magical
exactly-once execution.

If the process crashes:

- before claim: no autonomous agent effect was authorized for that slot;
- after claim but before/during completion: outcome is ambiguous, so the claim
  remains and that slot is **not retried automatically**;
- after completion: the completed receipt remains durable;
- later cron slots are independent and may run normally.

There is no blind retry and no recurring missed-slot catch-up.

This deliberately prefers a lost learning opportunity over duplicate autonomous
effects.

## Append-only wake receipts

Wake lifecycle evidence is appended to:

```text
data/apprenticeship/wake-receipts.jsonl
```

Events are:

- `claimed`
- `completed`
- `failed`
- `skipped`

`completed` is written only after the queued agent run settles without either
`RunSummary.aborted=true` or an emitted `RunEvent.kind="error"`. The agent loop
normally returns those conditions as data rather than throwing, so the cron
transport converts them into strict failures before A2 writes its terminal
receipt.

The claim file is authoritative for duplicate prevention. The JSONL stream is
the human/audit evidence.

If receipt writing fails after the claim, execution is refused. If the agent run
finishes but the completion receipt fails, the slot still remains claimed and
is not retried.

## Trading-state boundary

The external desk state remains principal-owned.

- `HALTED`: the claimed wake is recorded as skipped; no agent run starts.
- `REDUCING`: the wake may think/research, but existing trade guards remain in force.
- `ACTIVE`: ordinary A0/A1 rules apply.

A2 does not add an agent tool for changing desk state.

## Wake behavior

The fixed wake prompt tells the orchestrator to:

1. inspect `portfolio_get` first;
2. inspect current market evidence;
3. use existing research / token-audit / risk-review protocol;
4. take only actions already authorized by A0/A1 and existing desk guards;
5. accept `WALK AWAY` as a valid outcome;
6. never alter cadence, limits, permissions, code, wallets, or live-mode settings;
7. report what was observed, chosen, and still unknown.

The prompt is advisory. Hard authority remains in code-level gates.

## Deliberate exclusions

A2 does **not** add:

- expedition IDs or a full expedition lifecycle;
- epoch sealing;
- autonomous close/rotation lifecycle;
- realistic slippage/fee modeling;
- a performance/graduation evaluator;
- catch-up execution for downtime;
- claim reclamation;
- risk/permission growth from profit;
- live funding or live autonomy.

Those remain separate reviewed cuts.

# A1 — Finite Simulated Treasury

Frog-to-Toad apprenticeship capital is finite.

> The frog may be given resources. The frog may not invent resources or earn sovereignty.

## Authority boundary

A1 does **not** widen A0 approval authority.

Autonomous execution is still allowed only when all A0 conditions hold:

1. `AUTONOMOUS_DRY_RUN=true`
2. `DRY_RUN=true`
3. tool name is exactly `swap_execute`
4. tool danger class is exactly `trade`

Live money remains human-governed and external-signer-only.

## Explicit resource grant

There is intentionally no default bankroll.

`AUTONOMOUS_DRY_RUN=true` refuses boot unless the principal explicitly sets:

```text
APPRENTICESHIP_SEED_USD=<positive finite amount>
```

The amount is a resource grant, not an authority grant. Increasing it never increases
permissions, wallet access, tool scope, risk ceilings, or live execution authority.

## One monetary truth

A1 does not create `balance.json`, a simulator database, or a second trade ledger.

The existing append-only trade ledger remains canonical. A1 adds two optional fields
to apprenticeship cash events:

- `capitalPool: "apprenticeship"`
- `notionalUsd`

Treasury is derived every time:

```text
seed
- apprenticeship open notionals
+ apprenticeship close notionals
= available simulated cash
```

Unmarked historical dry-run entries are ignored. This prevents the imported desk's
old paper-trade history from silently creating or consuming Frog-to-Toad capital.

Malformed apprenticeship entries fail closed. A live entry in the apprenticeship
capital namespace also fails closed.

## A1 execution shape

A1 only authorizes **entry deployment from a stable-source treasury**.

The inherited swap tool records every execution as an `open`, even when its source
asset could conceptually be a held risk asset. Until a later position-management cut
adds an exact close/rotation lifecycle, autonomous non-stable-source execution is
therefore refused rather than mis-accounted.

Readonly quotes remain available. `portfolio_get` reports current apprenticeship cash.

At execution time, autonomous A1 never trusts the model-supplied `estNotionalUsd`
as monetary truth. The executor re-fetches the stable source asset price and derives:

```text
authoritative debit = fromAmount × current source USD price
```

That derived debit is used by the trade guard, dust check, treasury gate, ledger
`notionalUsd`, and remaining-cash report. If the source price is unavailable,
execution fails closed.

A1 also refuses to trust model-supplied `expectedToAmount` or `estEntryPriceUsd`
as autonomous ledger truth. Using the fresh destination reference price and the
desk's existing **placeholder** impact function, execution derives the simulated
quantity and an effective entry price whose cost basis reconciles exactly to the
authoritative cash debit.

This is an accounting-conservation rule, **not** a claim of realistic fills,
fees, or slippage. Fill realism remains a later experiment-design cut.

## Persistence

The balance survives restart because it is reconstructed from the durable ledger.
No mutable in-memory balance is authoritative.

## Deliberate exclusions

A1 does **not** add:

- a scheduler or wake loop,
- an epoch seal,
- mark-to-market equity,
- autonomous closes, stop-losses, rotations, or position management,
- fees/slippage realism changes,
- a performance grader,
- a graduation rule,
- live funding,
- leverage or borrowing,
- permission growth from profit.

The future position-management cut must write exact close cash proceeds back into the
same ledger namespace before the treasury may credit them.

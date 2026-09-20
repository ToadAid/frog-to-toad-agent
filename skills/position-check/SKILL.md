---
description: Review open positions: P&L, thesis still valid, exits defined
when_to_use: When asked to check positions, or before/after volatile market moves
---
# Position check

1. Read the ledger: `portfolio_get` then `portfolio_history` with limit 20.
2. For each open position, state: entry, current price (`market_price`), unrealized P&L, and days held.
3. For each position ask: is the ORIGINAL thesis (see `journal_read`) still valid?
4. Flag anything without a defined exit — a position without an invalidation level is not a trade, it's a hope.
5. Summarize: keep / trim / close recommendations with reasons. Do not execute anything.
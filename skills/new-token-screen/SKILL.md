---
description: Full screening workflow before trading a new token
when_to_use: When the principal asks about buying a token not yet in the portfolio
---
# New token screen

Run this BEFORE proposing any trade in a token the desk hasn't traded:

1. **Identity**: `market_token_search` — a ticker can map to many contracts. Show the
   human the candidate CONTRACT ADDRESSES and get them to confirm the exact one.
2. **Screen the asset**: `token_safety_scan` on that contract address — the auditor's
   red-flag checklist. Verdict must be GO or CAUTION to proceed, and it applies to
   that address only.
3. `market_price` on the quote asset (usually USDC/ETH) to size the trade.
4. Propose: asset (ticker + contract), size (within caps), entry rationale, invalidation level.
5. Hand to risk-guardian for veto review, then executor quotes it (address included).

Any NO-GO verdict ends the workflow. Do not negotiate with red flags.
A confirmed contract is the only identity that carries a GO verdict.
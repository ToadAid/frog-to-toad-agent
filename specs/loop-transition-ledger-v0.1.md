# Loop transition ledger v0.1

> Tier 2 #12 of the mother-repo north-star list. Ports the INTENT of the
> mother's `src/query.ts` terminal-reason model (the `Terminal` union its
> `queryLoop` returns — 14 named reasons including `completed`, `max_turns`,
> `model_error`, `aborted_streaming`, `aborted_tools`, `hook_stopped`,
> `stop_hook_prevented`, `prompt_too_long`) to the desk's `RunTermination`.
> Authority: **NONE** — the audit record's vocabulary widens; no behavior
> changes on any path that does not hit a guard.

## The defect this cut removes

The desk's 5-value `RunTermination` could not distinguish **finished** from
**guard fired**. Two bounds were masked:

| Exit site | Before | After |
| --- | --- | --- |
| Clean pass, hook asked, **follow-up cap refused** | `FINAL` | `FINAL_FOLLOWUP_CAP` |
| Turn-cap synthesis, **declared target still open** (continuation cap spent / diminishing returns) | `TURN_BUDGET` | `TURN_BUDGET_BUDGET_CAP` |

## The widened union (desk-native; the mother's reasons for machinery we
don't have — image_error, prompt_too_long, stop_hook_prevented, mcp,
content-replacement — are deliberately not copied)

```ts
export type RunTermination =
  | 'FINAL'                  // clean final pass, nothing asked
  | 'FINAL_FOLLOWUP_CAP'     // clean pass; hook asked; the follow-up cap refused
  | 'BRAIN_EMPTY'            // empty reply after the single bounded retry
  | 'TURN_BUDGET'            // turn-cap synthesis (no budget, or budget spent to ~90%)
  | 'TURN_BUDGET_BUDGET_CAP' // continuation cap/diminishing fired with the target still open
  | 'ABORTED'                // all three abort sites, one semantic
  | 'ERROR'                  // run-level catch or unknown agent
```

Semantics kept honest:
- A working turn where the brain returns a final TEXT reply ends the pass as
  `FINAL` **even with the target still open** — the brain choosing to stop is
  a finish, not a guard outcome (the guard only fires when a bound refuses).
- The seam still observes a cap-refused pass as a plain clean `FINAL`
  (the refusal happens after the hook fired) — only the terminal record is
  renamed.

## Files

1. `src/types.ts` — the union widens 5 → 7 (the `final` RunEvent already
   carries `termination`; no new event kinds needed).
2. `src/loop/tokenBudget.ts` — `COMPLETION_THRESHOLD` (0.9) exported; the
   ledger needs it to ask "was the target met?".
3. `src/loop/agentLoop.ts` — two assignment sites: the reserved-synthesis
   turn (ledger check against `state.tokensOut`) and the final-emit site
   (rename on cap refusal). The pass-through selection includes the new
   value so it survives to the summary.
4. `src/telegram/draft.ts` — `formatRunFinal` arms: `FINAL_FOLLOWUP_CAP`
   renders like a plain finish; `TURN_BUDGET_BUDGET_CAP` renders the
   turn-budget notice.
5. `src/memory/conversationEpisodes.ts` — `TERMINATIONS` set and
   `ConversationRunClosureV1['termination']` widen ADDITIVELY (validator
   accepts more; garbage still fails closed; no migration needed).

## Laws honored

- Default path byte-for-byte: runs that never touch a guard terminate with
  the same values as before (the whole existing suite is that proof).
- The seam laws are untouched: FINAL-only extension, follow-up cap, budget
  continuations, abort-wins — only the NAMES the audit record carries
  changed, plus the two previously-masked guard outcomes now visible.
- No budget re-arm, no new authority, no event-schema change.
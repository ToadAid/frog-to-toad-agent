# QueryDeps DI seam v0.1

> Tier 2 #16 of the mother-repo north-star list. Ports the mother repo's
> `src/query/deps.ts` (QueryDeps) seam to the desk's `runAgentTurns`. Authority:
> **NONE** — plumbing only; default path is byte-for-byte today's behavior.

## What this cut is

`runAgentTurns` (the turn engine inside `src/loop/agentLoop.ts`) is not exported
and calls three module-level functions directly (`maybeAutocompact`,
`microcompactThread`, `randomUUID`). Tests can only reach it through `startRun`
dragging the full Telegram/registry/tool scaffolding. The seam makes those
dependencies injectable so the loop is unit-testable without module spies —
the enabler for Tier 2 #12 (loop transition ledger: deterministic runIds in
audit assertions) and #13 (withhold-then-recover error staging).

## Mother vs desk

| Mother (`src/query/deps.ts`) | Desk |
| --- | --- |
| `callModel: typeof queryModelWithStreaming` | NOT NEEDED — the desk already has this seam: `StartRunOptions.llm` (mockable via `createMockLlmClient`). Documented, not duplicated. |
| `autocompact: typeof autoCompactIfNeeded` | `autocompact: typeof maybeAutocompact` (the same seam the session-memory consumer rides) |
| `microcompact: typeof microcompactMessages` | `microcompact: typeof microcompactThread` |
| `uuid: () => string` | `uuid: typeof randomUUID` — both call sites (`runId` at startRun, `conversationRunId` in runAgentTurns) |
| `productionDeps()` factory + `params.deps ?? productionDeps()` | same shape: `StartRunOptions.deps?`, default `productionDeps()` |

Scope stays as narrow as the mother's ("intentionally narrow to prove the
pattern"): 3 injected deps + 1 documented-already. Follow-up PRs (#12, #13) add
consumers; further deps (afterTurn, queue ops) only when a consumer exists.

## Shape

```ts
export type QueryDeps = {
  autocompact: typeof maybeAutocompact
  microcompact: typeof microcompactThread
  uuid: typeof randomUUID
}
export function productionDeps(): QueryDeps
```

- `StartRunOptions.deps?: QueryDeps` — optional, undefined = production.
- `startRun` resolves `const deps = opts.deps ?? productionDeps()`; uses
  `deps.uuid()` for `runId` and passes deps through to `runAgentTurns`
  (which uses `deps.uuid()` for `conversationRunId`, `deps.autocompact(...)`
  at the run-start compaction point, `deps.microcompact(...)` in the
  post-append compact).
- Signatures use `typeof <real fn>` so they can never drift from production.
- NO new npm deps. No behavior change: the default resolution path is the
  identical code, and every existing call site keeps working unchanged.

## Laws honored

- Authority: none — the seam injects only test doubles for I/O-shaped
  functions; it grants no hands, widens no allowlist, touches no store.
- Fail-open surface: a broken injected dep fails exactly like the real one
  would (same call sites, same catch blocks).
- The desk's no-module-spy discipline stays: tests inject through the
  StartRunOptions seam, never `vi.spyOn` a module.
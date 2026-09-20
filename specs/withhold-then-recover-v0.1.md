# Spec: withhold-then-recover error staging (north-star Tier 2 #13) — v0.1

Branch: `feat/withhold-recover` (off main `d179be9`). Mother reference:
`~/claude-code/src/query.ts` — withheld `max_output_tokens` ladder
(escalating retry → multi-turn recovery with per-stage counters → surface
`yield lastMessage` only when recovery exhausts), and the death-spiral law
"Skip stop hooks when the last message is an API error".

## The defect this cuts

Today a recoverable brain failure (rate limit, 5xx, timeout, context
overflow) goes straight to the consumer as a terminal `❌` —
`emit({kind:'error'})` fires on the first throw past the client's own
in-call 3-attempt ladder, and the run terminates ERROR. The mother stages
this: withhold the error, run a bounded single-shot recovery ladder, surface
only when recovery exhausts.

## Design (desk-native, rides the #145 DI seam)

```
classifyRecoverableLlmError(err) → 'TRANSIENT'         // 429/5xx, timeout, network
                                 | 'CONTEXT_OVERFLOW'  // 413, "context length", "prompt too long"
                                 | null                // auth, 4xx, everything else → surface NOW
```

Pure exported function over the client's REAL error spellings
(`LLM HTTP <status>: …`, `LLM request failed after 3 attempts: …`,
`TimeoutError`).

**The ladder** — wrapped around the ONE brain call site (`llm.complete` in
the turn loop; the autocompact summarizer call at `maybeAutocompact` is out
of scope):

- `TRANSIENT` → backoff (`RECOVERY_BACKOFF_MS` env, default 2000, clamped
  ≥ 0; tests set 0) → retry the SAME request **once**.
- `CONTEXT_OVERFLOW` → `deps.microcompact(messages)` (the #145 seam) →
  retry **once** only if it evicted something. No relief, no retry.
- Each stage has ONE run-scoped counter, single-shot: max 2 withheld extra
  brain calls per run, ever. Exhaustion (counter spent, no relief)
  **rethrows** — the error surfaces through the UNCHANGED run-level catch as
  a terminal ERROR. No new termination value: an unrecovered brain failure
  was, is, and stays ERROR.

**Withheld** — while a stage runs, the consumer sees nothing except one new
audit event `{kind:'recovering', runId, stage, error}`. The Telegram draft
explicitly ignores it (consumer-silent); dashboards/audit see it. The event
fires only when a recovery stage actually runs — a fatal or no-relief error
is never withheld and never marked.

**Abort law**: an aborted run never recovers — the wrapper rethrows when
`controller.signal.aborted`, so ABORTED stays ABORTED.

**Retry rebuilds the request**: `microcompact` replaces slots in `messages`
in place; the synthesis request is a spread copy, so the retry rebuilds
request messages from the (possibly compacted) `messages`.

## Death-spiral law (documented, already enforced)

The mother's "skip stop hooks when the last message is an API error" is
enforced by construction here: recovery lives INSIDE the turn loop; a run
that exhausts still terminates via the normal catch, the seam observes it
(`fireAfterTurnHooks` runs for errored runs) but never extends it — the
follow-up grant is FINAL-only. No hook behavior changes.

## What is deliberately NOT ported

- The mother's escalating max-output-tokens retry (8k→64k): the desk's
  client has its own budget; a second output-size knob is not this cut.
- Multi-turn recovery meta-messages ("Resume directly — no apology…"): our
  retry replays the identical context; there is nothing for the brain to
  resume from.
- `prompt_too_long` → reactiveCompact: autocompact already exists at run
  start; microcompact relief is the proportionate desk answer.

## Files

- `src/types.ts` — `LlmRecoveryStage` + `recovering` RunEvent arm.
- `src/loop/agentLoop.ts` — `classifyRecoverableLlmError`, backoff knob,
  run-scoped counters, `completeWithRecovery` wrapper (the one call site).
- `src/telegram/draft.ts` — explicit `recovering` ignore case.
- `tests/recover.test.ts` — 10 tests (see below).

## Tests (10, all deterministic via the #145 deps seam)

1. TRANSIENT withheld → retried once → clean FINAL (no error event).
2. TRANSIENT repeats → exhausted → terminal ERROR, exactly one withheld mark.
3. CONTEXT_OVERFLOW with microcompact relief → retried → clean FINAL.
4. CONTEXT_OVERFLOW with NO relief → no retry, surfaces immediately, no mark.
5. Fatal 401 → surfaces immediately, no mark.
6. `TimeoutError` → TRANSIENT, recovered.
7. Two stages are independent counters — both may recover in one run.
8. Stage counter does not reset — second overflow exhausts.
9. Classifier table test against production error spellings.
10. Draft consumer silent on `recovering` (no error card, no extra line).
# Community core donor port handoff

Checkpoint date: 2026-09-14

Resume pass: 2026-09-19

The required implementation and verification work below was completed on the
resume pass: the exact autonomous DRY_RUN exception was restored with
fail-closed audit hooks; Telegram/TUI direct slash skills were wired; the
CodeGraph fixture was adapted while retaining the reviewed 1.6.0 pin; actor
context now reaches plan-first runs with a guest non-escalation regression;
community documentation and a tested public installer were added; and the full
suite passed (91 files, 1,251 tests). Any remote push/PR remains an operator
step.

Branch: `feat/community-agent-core-port`

Donor ref: `donor/main` fetched from `ToadAid/trading-desk`

Base: Frog-to-Toad `master` after PR #48 (`41bd8bb`)

## Landed on this branch

- After-turn lifecycle v1/v2 with bounded follow-up passes and away summaries.
- Plan-first mode.
- Magic documents, including background refresh off the response path.
- Dream/background memory consolidation.
- Task-notification envelopes.
- Token-budget continuations.
- Transcript checkpoints, `/rewind`, and preserved-segment relinking.
- Session-memory extraction and memory-carried compaction (compaction opt-in).
- Batched `memory_save` and eviction-carousel correction.
- Query dependency-injection seam.
- Named loop terminal reasons.
- Bounded withhold-then-recover LLM error staging.
- Operator-editable output styles.
- Typed mailbox with permission-envelope refusal; autonomous mailbox wake was
  deliberately not wired.
- Markdown skill loader, model-invocable `skill` tool, prompt listing, isolated
  fork/tool-narrowing runtime support.
- Read-only CodeGraph repo-eyes files and tool registration (integration still
  needs its final test pass; see below).

The donor's final generic `agentLoop.ts` was used to reconcile the interdependent
runtime features. Existing Frog-to-Toad actor provenance and guest-readonly
logic are present in that loop.

## Deliberately not ported

- Perps, LP, sniper, swing, Avantis, paper execution, or other donor trading
  lanes.
- Autonomous mailbox wake (`bc8139f` / earlier branch form). Mailbox delivery
  remains tied to an existing run.
- Any permission/mode/authority propagation through mailbox, skills, memory,
  or output styles.

## Required next work (completed on the resume pass)

1. Restore and test Frog-to-Toad's exact autonomous DRY_RUN exception in the
   upgraded loop: `allowsAutonomousDryRunTrade` may bypass a human card only
   for `swap_execute` when both `autonomousDryRun` and `dryRun` are true. Keep
   all new approval audit hooks fail-closed.
2. Finish direct slash-skill routing for Telegram/TUI. The model `skill` tool,
   listing, isolated context, and tool narrowing are already present.
3. Finish CodeGraph integration:
   - the new test still contains one donor assertion about `install.sh`, which
     this repository does not have; adapt it to the package bootstrap scripts;
   - decide whether the checked-in pin remains 1.6.0 (the currently available
     global binary reports 1.4.1; runtime must degrade honestly until bootstrap).
4. Audit `startPlanFirstRun` and every ingress path for the current
   `TurnActorContext`; plan approval must never turn a guest into principal.
5. Run `npm run check`, targeted new tests, then the full `npm test`. Fix donor
   fixture assumptions without importing missing trading lanes.
6. Add/update README and `.env.example` community-facing documentation.
7. Review `git diff master...HEAD`, commit any fixes, push, and open the PR.

## Verification commands

```sh
npm run check
npm test -- --run tests/afterTurnSeamV2.test.ts tests/tokenBudget.test.ts tests/rewind.test.ts tests/sessionMemory.test.ts tests/recover.test.ts tests/outputStyles.test.ts tests/mailbox.test.ts tests/magicDocs.test.ts
npm test
git diff --check
```

## Safety invariants to re-check before PR

- Unknown and guest actors receive readonly tools only.
- Skills intersect/narrow an agent's effective tools and never grant tools.
- Isolated skill forks never read or append the parent transcript.
- Memory, output styles, task notifications, and mailbox messages are advisory
  data and never authority.
- Permission-shaped mailbox envelopes are refused/quarantined.
- Rewind is exact-private-principal only and serialized with the chat run queue.
- Autonomous mailbox wake stays disabled.
- Live trades remain approval-gated; the only exception is the existing exact
  simulated `swap_execute` apprenticeship rule described above.

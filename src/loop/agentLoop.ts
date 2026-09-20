import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import type {
  AgentDef,
  ApprovalRequest,
  ChatMessage,
  LlmRecoveryStage,
  RunEvent,
  RunSummary,
  RunTermination,
  TelegramSender,
  ToolDef,
  TurnActorContext,
} from '../types.js'
import type { LlmClient } from '../llm/client.js'
import { toToolDef } from '../llm/toolschema.js'
import type { AgentRegistry } from '../agents/registry.js'
import { buildSystemPrompt } from '../agents/prompts.js'
import { markdownToTelegramHtml } from '../telegram/render.js'
import type { AnyToolSpec, ToolRegistry, ToolContext } from '../tools/registry.js'
import * as interrupt from './interrupt.js'
import { appendToThread, autocompactSplit, autocompactThresholds, persistTranscriptNote, getThread, microcompactThread, type Thread } from './context.js'
import { recordCheckpoint } from './rewind.js'
import { AFTER_TURN_FOLLOWUP_PREFIX, fireAfterTurnHooks, followupMax } from './afterTurn.js'
import {
  sessionMemoryCompactionEnabled,
  sessionMemoryCompactionKeep,
  trySessionMemoryCompaction,
  waitForSessionMemoryFlush,
} from './sessionMemory.js'
import { injectTaskNotification, buildTaskNotification, type TaskNotification } from './taskNotification.js'
import { injectMailboxMessages } from './mailboxDelivery.js'
import { markMessagesRead } from '../store/mailbox.js'
import {
  COMPLETION_THRESHOLD,
  TOKEN_BUDGET_PREFIX,
  checkTokenBudget,
  createBudgetTracker,
  parseTokenBudget,
} from './tokenBudget.js'
import { log } from '../log.js'
import { allowsAutonomousDryRunTrade } from '../safety/autonomousDryRun.js'
import {
  attributeUserMessageForModel,
  mayMutateDesk,
  mayMutatePrincipalMemory,
  mayProjectPrincipalUser,
  systemInternalActor,
} from '../telegram/actor.js'

const TOOL_RESULT_MAX_CHARS = 8_000
const FINAL_SYNTHESIS_INSTRUCTION =
  'Turn budget reached. Finish from evidence already collected. Do not start new work or promise future tool calls. ' +
  'If unfinished, report exactly what remains and where durable state was saved.'
const TURN_BUDGET_TEXT =
  '⏳ Run reached its bounded turn budget. Workspace/transcript state is preserved; no work was discarded.'

// ── Withhold-then-recover (north-star Tier 2 #13) ───────────────────────────
// Mother pattern (query.ts's withheld max-output-tokens ladder): a recoverable
// brain failure is WITHHELD from the consumer while a single-shot recovery
// stage runs; only when recovery exhausts does the error surface — through the
// UNCHANGED run-level catch, as a terminal ERROR. Two classes, one counter
// each, per run (the ladder is bounded by law, never a retry loop).

/**
 * Pure classifier over the brain's thrown errors. null = surface immediately
 * (auth, malformed request — anything not clearly the provider's fault).
 * TRANSIENT: rate limit / 5xx / timeout / network blip (the client's own
 * in-call 3-attempt ladder has already run by the time these throw).
 * CONTEXT_OVERFLOW: the provider refused the prompt size — microcompact
 * relieves it.
 */
export function classifyRecoverableLlmError(err: unknown): LlmRecoveryStage | null {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  if (
    /HTTP 413\b|context (length|window)|prompt (is )?too long|maximum context|too many tokens|input (is )?too long|exceeds the maximum/i.test(
      msg,
    )
  ) {
    return 'CONTEXT_OVERFLOW'
  }
  if (
    /HTTP 429\b|HTTP 5\d\d\b|TimeoutError|timed out|fetch failed|ECONN|network|request failed after \d+ attempts/i.test(
      msg,
    )
  ) {
    return 'TRANSIENT'
  }
  return null
}

/** Backoff before a recovery retry, in ms (env knob; tests set 0). */
function recoveryBackoffMs(): number {
  const raw = Number(process.env['RECOVERY_BACKOFF_MS'])
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_000
}

export type ApprovalGateFn = (
  req: ApprovalRequest,
  chatId: number,
  signal: AbortSignal,
) => Promise<'allow' | 'deny' | 'timeout' | 'no_channel'>

/**
 * Server-side structured tool-result observation.
 *
 * This is deliberately separate from ChatMessage/tool text: large typed
 * evidence can be consumed by trusted desk code without being serialized into
 * the model context or transcript. Observing data grants no tool/trading
 * authority and cannot change the tool's danger classification.
 */
export type ToolDataCaptureEvent = {
  readonly runId: string
  readonly toolCallId: string
  readonly tool: string
  readonly agent: string
  readonly depth: number
  readonly chatId: number
  readonly data: unknown
}

export type StartRunOptions = {
  cfg: Config
  agentRegistry: AgentRegistry
  toolRegistry: ToolRegistry
  llm: LlmClient
  send: TelegramSender
  chatId: number
  agentName: string
  userText: string
  /** Code-owned origin and, for Telegram, exact sender identity. */
  actor?: TurnActorContext
  /** Images (data URIs) attached to THIS user message only — vision brains. */
  userImages?: string[]
  /** Delegation depth: 0 = top-level run. Subagents cannot spawn further. */
  depth?: number
  /**
   * Scout fan-out law (PR 5): this run may reach READONLY tools only — a
   * scout observes, never mutates, even if its agent frontmatter lists
   * write/trade tools. Enforced at the loop, not the tool.
   */
  readonlyTools?: boolean
  /**
   * Skills law: this run may reach ONLY these named tools, INTERSECTED with
   * the agent's own allowlist. A playbook may be LESS able than the base
   * agent — never more (a skill list is a narrowing filter, never a grant).
   * Enforced at the loop, like readonlyTools.
   */
  toolAllowlist?: string[]
  /**
   * Thread isolation seam (context: fork). 'chat' (default) = the durable
   * thread keyed by chatId, as always. 'isolated' = a FRESH context: the run
   * starts with NO prior history, never reads the parent's thread, never
   * appends its internal turns into data/transcript/<parentChatId>.jsonl as
   * principal conversation, and persists no run note into the parent
   * transcript — the child's only return path is its final result as the ONE
   * parent tool result. Depth/approval/toolAllowlist laws still apply.
   */
  threadMode?: 'chat' | 'isolated'
  /** Telegram approval gate (Phase 3). Absent ⇒ guarded tools are denied. */
  approvalGate?: ApprovalGateFn
  onEvent?: (e: RunEvent) => void
  /**
   * Trusted server-side structured-result capture. Tool `data` never enters
   * the LLM/tool text merely because this callback is present. Future visual
   * projection code can consume exact evidence here without a second fetch.
   *
   * Capture is observational: callback failure is logged and cannot turn a
   * successful readonly tool into authority or mutate its text result.
   */
  onToolData?: (event: ToolDataCaptureEvent) => void | Promise<void>
  /**
   * QueryDeps DI seam (Tier 2 #16, the mother-repo src/query/deps.ts pattern):
   * I/O-shaped turn-engine dependencies, injectable so tests drive the loop
   * with fakes instead of module spies. Undefined = production. `callModel`
   * is NOT here — the desk already injects the brain via `llm` above; the
   * mother's callModel dep is filled by that existing seam.
   */
  deps?: QueryDeps
  /**
   * Mailbox wake lane (#7b): wired by the bot for normal runs — mailbox_send
   * calls it after a successful write so an idle recipient can be woken with
   * one fresh read-only run. Absent on wake runs themselves: a mail-woken run
   * cannot wake another (the chain cap, enforced at the wiring).
   */
  mailboxWake?: (to: string, from: string) => Promise<
    'spawned' | 'deduped' | 'budget' | 'disabled' | 'unknown-agent' | 'empty'
  >
}

/**
 * The loop's non-brain I/O dependencies, typed against the REAL functions so
 * the signatures can never drift (`typeof fn`). Scope intentionally narrow —
 * the three call sites inside the turn engine; #12/#13 add consumers, not
 * more deps, until one exists.
 */
export type QueryDeps = {
  autocompact: typeof maybeAutocompact
  microcompact: typeof microcompactThread
  uuid: typeof randomUUID
}

export function productionDeps(): QueryDeps {
  return {
    autocompact: maybeAutocompact,
    microcompact: microcompactThread,
    uuid: randomUUID,
  }
}

export type RunHandle = {
  runId: string
  signal: AbortSignal
  abort: () => void
  done: Promise<RunSummary>
}

/**
 * One agent run: system prompt → user message → LLM/tool turn loop.
 *
 * Invariants (learned the hard way by every agent that looped forever):
 *  - every tool_call_id gets exactly one tool reply (synthetic on abort)
 *  - tool calls execute sequentially — approvals stay unambiguous
 *  - deny/block results are tool RESULTS, not throws — the model reacts
 *  - nothing throws out of the loop; errors come back in the RunSummary
 */
export function startRun(opts: StartRunOptions): RunHandle {
  const deps = opts.deps ?? productionDeps()
  const runId = deps.uuid().slice(0, 8)
  const depth = opts.depth ?? 0
  // Only top-level runs register in the interrupt map (keyed by chatId) —
  // subagents get their own controller and inherit the parent's abort.
  const controller = depth === 0 ? interrupt.register(opts.chatId, runId) : new AbortController()

  const done = runAgentTurns(opts, runId, controller, depth, deps).finally(() => {
    if (depth === 0) interrupt.release(opts.chatId, controller)
  })

  return { runId, signal: controller.signal, abort: () => controller.abort(), done }
}

async function runAgentTurns(
  opts: StartRunOptions,
  runId: string,
  controller: AbortController,
  depth: number,
  deps: QueryDeps = productionDeps(),
): Promise<RunSummary> {
  const started = Date.now()
  // P4 durable conversation identity is a full UUID, separate from the short
  // operator-facing runId. Never use the 8-hex display id as a long-lived key.
  const conversationRunId = deps.uuid()
  const { cfg, agentRegistry, toolRegistry, llm, chatId, onEvent } = opts
  // Thread isolation (context: fork): an isolated run builds its context from
  // an EMPTY thread and never touches the parent chat's durable thread or
  // transcript — fresh context is the contract, not a courtesy.
  const isolated = opts.threadMode === 'isolated'
  const agent = agentRegistry.get(opts.agentName)
  if (!agent) {
    return finish(runId, opts.agentName, started, {
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      aborted: false,
      termination: 'ERROR',
      text: `unknown agent '${opts.agentName}'`,
    })
  }

  const emit = (e: RunEvent) => onEvent?.(e)
  /** The seam's view of the run as it stands right now (per-pass summary). */
  const hooksCtx = () => ({
    cfg,
    chatId,
    agent: opts.agentName,
    userText: opts.userText,
    actor: opts.actor,
    summary: finish(runId, opts.agentName, started, state),
    llm,
    send: opts.send,
    onEvent,
  })
  const state: RunState = {
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    aborted: false,
    termination: 'FINAL',
    text: '',
  }
  let emptyRetries = 0
  // Withhold-then-recover (Tier 2 #13): one recovery per STAGE per run — the
  // counters are what bounds the ladder (max 2 withheld extra brain calls),
  // and what makes exhaustion surface through the unchanged catch.
  let transientRecovered = 0
  let overflowRecovered = 0
  emit({ kind: 'run_started', runId, agent: agent.name, chatId })

  try {
    // An isolated run (context: fork) starts from NOTHING — never
    // getThread(parentChatId), so the parent's conversation history cannot
    // leak into the child's provider context.
    const thread: Thread = isolated ? { chatId, messages: [] } : getThread(cfg, chatId)
    await deps.autocompact(opts, thread)
    // The ONE append seam for this run: chat mode appends to the durable
    // thread and persists to the transcript; isolated mode stays in memory
    // only — the child's internal turns are not principal conversation, die
    // with the run, and the parent tool result is the durable audit record.
    const appendThread = (message: ChatMessage): void => {
      if (isolated) thread.messages.push(message)
      else appendToThread(cfg, thread, message, { conversationRunId })
    }
    const allTools = toolRegistry.forAgent(agent)
    const readonlyActor = !mayMutateDesk(opts.actor)
    let tools = opts.readonlyTools === true || readonlyActor
      ? allTools.filter((t) => t.danger === 'readonly')
      : allTools
    if (opts.toolAllowlist !== undefined) {
      const allow = new Set(opts.toolAllowlist)
      tools = tools.filter((t) => allow.has(t.name))
    }
    let toolDefs: ToolDef[] = tools.map((t) => toToolDef(t.name, t.description, t.input))

    /**
     * The ONE brain call site, with the withheld ladder wrapped around it
     * (Tier 2 #13). On a recoverable failure the error is withheld from the
     * consumer — one `recovering` event marks the audit — and the SAME request
     * is retried once: TRANSIENT after a short backoff; CONTEXT_OVERFLOW after
     * microcompact relieves the live provider context (retry only if something
     * was actually evicted — no relief, no retry). The retry rebuilds the
     * request messages so a microcompact that replaced slots in `messages` is
     * visible to the synthesis copy too. Exhaustion (stage counter spent, or
     * no relief) rethrows — the run-level catch surfaces it unchanged.
     */
    const completeWithRecovery = async (
      finalSynthesis: boolean,
    ): Promise<Awaited<ReturnType<typeof llm.complete>>> => {
      const attempt = () =>
        llm.complete({
          messages: finalSynthesis
            ? [...messages, { role: 'user', content: FINAL_SYNTHESIS_INSTRUCTION }]
            : messages,
          tools: finalSynthesis ? [] : toolDefs,
          signal: controller.signal,
        })
      try {
        return await attempt()
      } catch (err) {
        if (controller.signal.aborted) throw err // an aborted run never recovers — ABORTED stays ABORTED
        const stage = classifyRecoverableLlmError(err)
        if (stage === null) throw err
        if (stage === 'TRANSIENT') {
          if (transientRecovered > 0) throw err // single-shot: exhausted
          transientRecovered++
        } else {
          if (overflowRecovered > 0) throw err // single-shot: exhausted
          const relief = deps.microcompact(messages)
          if (relief.evicted === 0) throw err // no relief, no retry
          overflowRecovered++
          log.info(
            `run ${runId}: context overflow — microcompact evicted ${relief.evicted} tool result(s) (${relief.bytesSaved} chars), retrying`,
          )
        }
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`run ${runId}: ${stage} brain failure withheld — recovering (${message})`)
        emit({ kind: 'recovering', runId, stage, error: message })
        await new Promise<void>((resolve) => setTimeout(resolve, recoveryBackoffMs()).unref?.())
        return await attempt()
      }
    }

    const roster = depth === 0 && !isolated ? agentRegistry.roster(agent.name) : ''
    const systemPrompt = buildSystemPrompt(agent, cfg, roster, {
      userText: opts.userText,
      runStartAsOf: started,
    }, opts.actor)

    // History stores PLAIN TEXT (an image note) — the actual pixels ride only
    // on this run's fresh user message (see sanitizeForProvider). Otherwise
    // every later turn re-uploads megabytes of base64 for a stale image.
    const imageNote =
      opts.userImages !== undefined && opts.userImages.length > 0
        ? `\n\n[sent ${opts.userImages.length} image(s) with this message]`
        : ''
    // A checkpoint is recorded before the work it may undo: /rewind [n] can
    // always drop exactly this run's prompt and everything after it. Depth 0
    // only — subagent runs are not rewindable units (they belong to their
    // parent run), and the per-chat run queue serializes checkpoint vs rewind.
    if (depth === 0 && !isolated) recordCheckpoint(cfg, chatId, opts.userText)
    appendThread({ role: 'user', content: opts.userText + imageNote, ...(opts.actor ? { actor: opts.actor } : {}) })

    const freshMessageIndex = thread.messages.length - 1
    const threadForRun = thread.messages.map((message, index) =>
      index === freshMessageIndex && opts.actor === undefined
        ? message
        : attributeUserMessageForModel(message),
    )
    if (opts.userImages !== undefined && opts.userImages.length > 0) {
      const last = threadForRun[threadForRun.length - 1]
      if (last?.role === 'user') {
        threadForRun[threadForRun.length - 1] = { ...last, images: opts.userImages }
      }
    }
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...threadForRun]

    // Pass loop (after-turn seam v2, the mother-repo stopHooks generator
    // shape): each pass is one full bounded turn sequence. After a clean FINAL
    // pass, hooks get their say; a followUp directive injects one user-role
    // message and grants exactly one more pass, up to the follow-up cap.
    // Bounded by law: only FINAL passes continue, and a follow-up never
    // re-arms a budget the run spent (BRAIN_EMPTY / TURN_BUDGET / ERROR /
    // ABORTED are never extended).
    // Token budget (mother port): parsed from the TOP-LEVEL user text only —
    // subagents (depth > 0) never budget-continue (mother agentId law → desk
    // depth law). A declared budget lets the run self-continue past the turn
    // cap, one working turn per grant, until ~90% of the target or diminish.
    const budget = depth === 0 && !isolated ? parseTokenBudget(opts.userText) : null
    const budgetTracker = createBudgetTracker()

    // The reserved synthesis turn is not a fixed index anymore: a budget
    // continuation pushes the cap forward WITHIN its pass. The tracker and
    // the follow-up counter are run-scoped — budget accounting and the
    // follow-up cap survive across passes.
    let followUpsUsed = 0
    while (true) {
      // Pass-local authority: the agent's own bound opens every pass. A budget
      // grant may extend THE PASS THAT EARNED IT (below), but a follow-up pass
      // starts fresh at maxTurns — a grant never silently enlarges the next
      // pass. Budget accounting (budgetTracker) stays run-scoped above.
      let turnCap = agent.maxTurns
      for (let turn = 1; turn <= turnCap; turn++) {
        controller.signal.throwIfAborted()
        state.turns += 1
        emit({ kind: 'turn', runId, turn: state.turns })

        const finalSynthesis = turn === turnCap

        // The budget checkpoint sits BEFORE the reserved synthesis request: a
        // `continue` decision skips synthesis entirely, injects the nudge as
        // durable provenance-tagged history, and grants exactly one more
        // working turn — the next synthesis checkpoint re-checks. A `stop`
        // decision falls through to the normal synthesis turn (TURN_BUDGET).
        if (finalSynthesis && budget !== null && !controller.signal.aborted) {
          const decision = checkTokenBudget(budgetTracker, depth !== 0, budget, state.tokensOut)
          if (decision.action === 'continue') {
            const injected = `${TOKEN_BUDGET_PREFIX} ${decision.nudgeMessage}`
            log.info(
              `run ${runId}: token budget continuation #${decision.continuationCount} — ${decision.pct}% (${decision.turnTokens} / ${decision.budget})`,
            )
            emit({ kind: 'budget_continue', runId, round: decision.continuationCount, text: injected })
            appendThread({ role: 'user', content: injected })
            // A durable message is not an injected message until the current
            // brain can see it: the same string enters the LIVE provider
            // context too, so the granted working turn actually reads it.
            messages.push({ role: 'user', content: injected })
            // One WORKING turn per grant: cap advances by two — turn+1 runs as
            // a normal turn (tools live), turn+2 is the next synthesis
            // checkpoint where the tracker re-checks.
            turnCap = turn + 2
            continue
          }
          if (decision.completionEvent?.diminishingReturns) {
            log.info(`run ${runId}: token budget early stop — diminishing returns at ${decision.completionEvent.pct}%`)
          }
        }
        const res = await completeWithRecovery(finalSynthesis)
        state.tokensIn += res.usage?.in ?? 0
        state.tokensOut += res.usage?.out ?? 0

        const assistant = res.message

        // Empty final (no text, no tool calls) = the brain burned its budget on
        // thinking (GLM quirk, seen live 2026-09-03: a vision question came back
        // empty at maxTokens 4096). One silent retry — the reply is NOT appended,
        // so the retry sees the identical context.
        if (
          (!assistant.tool_calls || assistant.tool_calls.length === 0) &&
          !assistant.content &&
          !controller.signal.aborted
        ) {
          if (emptyRetries < 1 && !finalSynthesis) {
            emptyRetries++
            log.warn(`run ${runId}: brain returned empty content (turn ${turn}) — retrying once`)
            continue
          }
          state.termination = 'BRAIN_EMPTY'
          state.text = ''
          break
        }

        // The retry allowance is for consecutive empty replies, not the whole
        // run. Any useful assistant turn starts a fresh bounded empty sequence.
        emptyRetries = 0

        // The reserved final call is synthesis-only. Even if a provider ignores
        // the empty tool list and emits a tool call, never execute or persist an
        // unpaired call from this non-mutating finalization turn.
        if (finalSynthesis) {
          // Terminal-reason ledger (Tier 2 #12): synthesis at the cap is a
          // plain budget stop only when the declared target (if any) was
          // met — a bound refusing one more continuation with the target
          // still open is a guard outcome and gets its own reason.
          state.termination =
            budget !== null && state.tokensOut < budget * COMPLETION_THRESHOLD
              ? 'TURN_BUDGET_BUDGET_CAP'
              : 'TURN_BUDGET'
          if (assistant.content) {
            messages.push({ role: 'assistant', content: assistant.content })
            appendThread({ role: 'assistant', content: assistant.content })
            state.text = assistant.content
          } else {
            state.text = TURN_BUDGET_TEXT
          }
          break
        }

        messages.push(assistant)
        if (assistant.content || (assistant.tool_calls?.length ?? 0) > 0) {
          appendThread(assistant)
        }

        if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
          state.text = assistant.content ?? ''
          break
        }

        // Sequential tool execution — never parallel, so approvals stay unambiguous.
        for (const call of assistant.tool_calls) {
          if (controller.signal.aborted) {
            const interrupted = { role: 'tool' as const, tool_call_id: call.id, content: '[interrupted by user]' }
            messages.push(interrupted)
            appendThread(interrupted)
            continue
          }
          state.toolCalls++
          const result = await executeToolCall(opts, {
            call,
            agent,
            tools,
            restrictTools: (names) => {
              const allow = new Set(names)
              tools = tools.filter((t) => allow.has(t.name))
              toolDefs = tools.map((t) => toToolDef(t.name, t.description, t.input))
            },
            runId,
            depth,
            controller,
            emit,
          })
          messages.push({ role: 'tool', tool_call_id: call.id, content: result })
          // Pairing invariant (the §'every tool_call_id gets exactly one tool
          // reply' law, durable edition): the assistant tool_use was ALREADY
          // appended to the thread before execution, so its result must land
          // there too — abort or not. An abort mid-execute that skips this
          // append leaves a durable unpaired tool_use: the next run in this
          // chat replays it raw and the provider 400s, and a restart's
          // repairThreadToolPairs silently drops the whole turn (audit loss).
          // On an interrupted call the result is the synthetic
          // '[interrupted by user]' from executeToolCall — a valid pair.
          appendThread({ role: 'tool', tool_call_id: call.id, content: result })
        }

        // appendToThread microcompacts the durable Thread view. Compact this
        // run's separate provider context as well, after the complete call/result
        // batch is present, preserving ids and the newest outputs verbatim.
        deps.microcompact(messages)

        // Memory nudge (the Hermes pattern): every N turns, remind the agent its
        // workspace memory exists — a durable fact gets saved mid-run, not lost
        // at end-of-run. Nudges live in THIS run's message array only (never the
        // persisted thread) so they don't pollute conversation history.
        if (
          cfg.memoryNudgeInterval > 0 &&
          turn % cfg.memoryNudgeInterval === 0 &&
          turn < agent.maxTurns &&
          tools.some((t) => t.name === 'memory_save')
        ) {
          messages.push({
            role: 'user',
            content:
              '[memory nudge] If this run surfaced a durable fact — a feed quirk, a principal preference, a mistake worth correcting — save it now with memory_save (self/desk/user). ' +
              'If nothing durable surfaced, just carry on.',
          })
        }
      }

      if (controller.signal.aborted) {
        state.aborted = true
        state.termination = 'ABORTED'
        emit({ kind: 'aborted', runId })
        // v1 parity: hooks observe an aborted run too (the away card on a
        // stopped scheduled run). ABORTED is never extended.
        if (depth === 0 && !isolated) await fireAfterTurnHooks(hooksCtx())
        break
      }

      const termination =
        state.termination === 'BRAIN_EMPTY' ||
        state.termination === 'TURN_BUDGET' ||
        state.termination === 'TURN_BUDGET_BUDGET_CAP'
          ? state.termination
          : 'FINAL'

      // After-turn seam v2: hooks speak after every top-level pass (v1
      // parity). The follow-up GRANT is narrower: only a clean FINAL pass,
      // only top-level, within the follow-up cap — a spent budget never
      // re-arms and subagents never fire the seam.
      //
      // FINAL MEANS TERMINAL: `final` is emitted exactly once, when the run
      // is truly ending. A granted follow-up continues the pass loop without
      // a final in between — `followup` always precedes the one terminal
      // `final`. An aborted run never emits `final` at all.
      if (depth !== 0) {
        emit({ kind: 'final', runId, text: state.text, termination })
        break
      }
      const directive = isolated ? { kind: 'observe' as const } : await fireAfterTurnHooks(hooksCtx())

      // ABORT WINS BEFORE PERSISTENCE: the seam awaited async hooks, so an
      // abort may have landed during that await. Re-check it BEFORE anything
      // is emitted or persisted — a directive from an aborted run never
      // becomes durable history. The seam already fired this pass, so it
      // must NOT fire again.
      if (controller.signal.aborted) {
        state.aborted = true
        state.termination = 'ABORTED'
        emit({ kind: 'aborted', runId })
        break
      }

      if (
        termination !== 'FINAL' ||
        followUpsUsed >= followupMax() ||
        directive.kind === 'observe'
      ) {
        // Terminal-reason ledger (Tier 2 #12): a clean pass that ends here
        // because the cap REFUSED a hook's extension is a guard outcome, not
        // a plain finish — the summary must say which bound said no. The
        // seam already observed this pass as a plain clean FINAL (the
        // refusal happens after it fired), so this only renames the end.
        const finalTermination =
          termination === 'FINAL' && directive.kind !== 'observe'
            ? ('FINAL_FOLLOWUP_CAP' as const)
            : termination
        state.termination = finalTermination
        emit({ kind: 'final', runId, text: state.text, termination: finalTermination })
        break
      }
      // Three inject kinds, one grant law: a followUp carries the hook's own
      // ask under the after-turn mark; a taskNotification carries a worker
      // report as an envelope under the task-notification mark; a mailbox
      // directive carries the agent's inbox messages under the mailbox mark
      // (Tier 2 #7 — a desk peer's words, never the principal's). All are
      // provenance-tagged user-role history, all count against the cap.
      const injected =
        directive.kind === 'taskNotification'
          ? injectTaskNotification(directive.notification)
          : directive.kind === 'mailbox'
            ? injectMailboxMessages(directive.messages)
            : `${AFTER_TURN_FOLLOWUP_PREFIX} ${directive.text}`
      followUpsUsed += 1
      if (directive.kind === 'mailbox') {
        // The grant is real: consume the mail HERE, after the cap check —
        // a refused extension never ate anything (the peek/consume law).
        void markMessagesRead(cfg, opts.agentName, directive.messages.map((m) => m.id))
      }
      emit(
        directive.kind === 'taskNotification'
          ? { kind: 'task_notification', runId, round: followUpsUsed, text: injected }
          : directive.kind === 'mailbox'
            ? { kind: 'mailbox', runId, round: followUpsUsed, text: injected }
            : { kind: 'followup', runId, round: followUpsUsed, text: injected },
      )
      // Provenance law: the injected message is durable thread history, marked
      // so the brain always knows the principal did not write it.
      const hookActor = systemInternalActor(
        chatId,
        mayProjectPrincipalUser(opts.actor),
        mayMutateDesk(opts.actor),
        mayMutatePrincipalMemory(opts.actor),
      )
      const hookMessage: ChatMessage = { role: 'user', content: injected, actor: hookActor }
      appendThread(hookMessage)
      messages.push(attributeUserMessageForModel(hookMessage))
      emptyRetries = 0
    }
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      state.aborted = true
      state.termination = 'ABORTED'
      emit({ kind: 'aborted', runId })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`run ${runId} (${opts.agentName}) failed: ${message}`)
      emit({ kind: 'error', runId, message })
      state.termination = 'ERROR'
      state.text = `⚠️ ${message}`
    }
    // v1 parity: the seam fires for every top-level run, whatever the
    // termination — an errored or aborted run is observed, never extended.
    if (depth === 0 && !isolated) await fireAfterTurnHooks(hooksCtx())
  }

  // An isolated child persists NOTHING into the parent chat's transcript —
  // not even a run-summary note. The parent's tool result (envelope → result)
  // is the durable provenance/audit record for a fork playbook.
  if (!isolated) {
    persistTranscriptNote(cfg, chatId, {
      // The terminal note carries the same full P4 binding as every message.
      // Legacy pre-P4 summaries have only runId and remain explicitly unbound.
      conversationRunId,
      runId,
      agent: opts.agentName,
      summary: {
        turns: state.turns,
        toolCalls: state.toolCalls,
        aborted: state.aborted,
        termination: state.termination,
      },
    })
  }

  return finish(runId, opts.agentName, started, state)
}

type RunState = {
  turns: number
  toolCalls: number
  tokensIn: number
  tokensOut: number
  aborted: boolean
  termination: RunTermination
  text: string
}

function finish(
  runId: string,
  agent: string,
  started: number,
  state: RunState,
): RunSummary {
  return {
    runId,
    agent,
    turns: state.turns,
    toolCalls: state.toolCalls,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    durationMs: Date.now() - started,
    aborted: state.aborted,
    termination: state.termination,
    finalText: state.text,
  }
}

// Autocompact (the coder-repo autoCompact pattern): when the thread has
// saturated its window, summarize the older portion into ONE compact-boundary
// message before this run needs it. Fails OPEN — a summarizer error or empty
// reply leaves the thread untouched (the old tail-drop still bounds it).
// The transcript already holds every original message; the boundary is an
// in-memory overlay, persisted as a note so restores see it too.
const AUTOCOMPACT_PROMPT =
  'You are compacting a Frog-to-Toad Agent conversation. Summarize the following messages into a terse brief ' +
  'the desk can act from: durable facts, principal decisions, open items, and any prices/levels/thresholds worth ' +
  'remembering. User-message actor labels are code-owned identity evidence: preserve who said what, and treat a ' +
  'statement as a principal decision only when its label says principalAuthenticated=YES. ' +
  'Plain text, at most ~300 words. Never invent anything not in the messages.'

const AUTOCOMPACT_RENDER_MSG_CHARS = 600
const AUTOCOMPACT_RENDER_BUDGET = 48_000

export async function maybeAutocompact(
  opts: { cfg: Config; llm: LlmClient; chatId: number },
  thread: { chatId: number; messages: ChatMessage[] },
): Promise<void> {
  // Session-memory compaction (the mother sessionMemoryCompact arc, gated
  // OFF by default): when armed, the memory file replaces the one-shot LLM
  // summary and only a raw suffix window is kept. Every failure mode returns
  // false and the legacy path below runs — the desk verifies, never assumes.
  if (sessionMemoryCompactionEnabled() && thread.messages.length >= autocompactThresholds().trigger) {
    await waitForSessionMemoryFlush()
    if (await trySessionMemoryCompaction(opts, thread as Thread, sessionMemoryCompactionKeep())) {
      return
    }
  }
  const split = autocompactSplit(thread.messages)
  if (!split) return
  const evicted = split.evicted
  try {
    // Render newest-first within a hard budget — a 40-message head of 8KB
    // tool results must not become a 320KB summary request.
    const rendered: string[] = []
    let budget = AUTOCOMPACT_RENDER_BUDGET
    for (let i = evicted.length - 1; i >= 0; i--) {
      const m = attributeUserMessageForModel(evicted[i]!)
      const body =
        'tool_call_id' in m
          ? m.content
          : [
              m.content ?? '',
              ...(m.role === 'assistant'
                ? (m.tool_calls ?? []).map((tc) => `[tool call] ${tc.function.name}(${tc.function.arguments})`)
                : []),
            ]
              .filter(Boolean)
              .join(' ')
      const line = `${m.role}: ${body.slice(0, AUTOCOMPACT_RENDER_MSG_CHARS)}`
      if (line.length > budget) {
        rendered.push('…older messages omitted (render budget)')
        break
      }
      budget -= line.length
      rendered.unshift(line)
    }
    const res = await opts.llm.complete({
      messages: [
        { role: 'system', content: AUTOCOMPACT_PROMPT },
        { role: 'user', content: rendered.join('\n') },
      ],
      tools: [],
    })
    const summary = res.message.content?.trim()
    if (!summary) {
      log.info('autocompact skipped: empty summary')
      return
    }
    const boundary: ChatMessage = {
      role: 'user',
      content: `[autocompact] Summary of the ${evicted.length} earlier messages (full text in the transcript):\n\n${summary}`,
      actor: systemInternalActor(opts.chatId, false),
    }
    thread.messages = [boundary, ...split.kept]
    persistTranscriptNote(opts.cfg, opts.chatId, {
      message: boundary,
      autocompact: {
        evicted: evicted.length,
        chars: boundary.content.length,
        // preservedSegment relink metadata (the coder-repo compact pattern):
        // the boundary is the anchor; restores splice the `kept` message
        // records above it into the live chain instead of the raw tail, so
        // rehydration never resurrects the evicted head behind the summary.
        preservedSegment: { kept: split.kept.length },
      },
    })
    log.info(
      `autocompact: ${evicted.length} message(s) -> 1 boundary summary`,
    )
  } catch (e) {
    log.warn('autocompact skipped: transcript unavailable')
  }
}

async function executeToolCall(
  opts: StartRunOptions,
  args: {
    call: { id: string; function: { name: string; arguments: string } }
    agent: AgentDef
    tools: AnyToolSpec[]
    restrictTools: (names: string[]) => void
    runId: string
    depth: number
    controller: AbortController
    emit: (e: RunEvent) => void
  },
): Promise<string> {
  const { call, agent, tools, restrictTools, runId, depth, controller, emit } = args
  const { cfg, chatId, send } = opts

  const tool = tools.find((t) => t.name === call.function.name)
  if (!tool) {
    const allowed = agent.tools ? agent.tools.join(', ') : '(all registered tools)'
    return `[blocked] tool '${call.function.name}' is not permitted for agent '${agent.name}'. Allowed: ${allowed}`
  }

  let input: unknown
  try {
    input = call.function.arguments.trim() === '' ? {} : JSON.parse(call.function.arguments)
  } catch {
    return `[error] tool '${tool.name}' arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}`
  }

  const parsed = tool.input.safeParse(input)
  if (!parsed.success) {
    return `[error] tool '${tool.name}' input invalid: ${parsed.error.message.slice(0, 300)}`
  }

  emit({ kind: 'tool_call', runId, tool: tool.name, input: parsed.data })

  const ctx: ToolContext = {
    cfg,
    agent,
    runId,
    chatId,
    actor: opts.actor,
    signal: controller.signal,
    notify: async (text) => {
      // Raw markdown rides the event stream (TUI parity — Telegram converts
      // its copy to HTML; the TUI renders the source directly).
      emit({ kind: 'notify', runId, text })
      await send.send(chatId, markdownToTelegramHtml(text))
    },
    requestApproval: (req) =>
      opts.approvalGate
        ? opts.approvalGate(req, chatId, controller.signal).then((d) => (d === 'allow' ? 'allow' : 'deny'))
        : Promise.resolve('deny'),
    callSubagent: async (name, prompt, subOpts) => {
      if (depth > 0 || opts.threadMode === 'isolated') return '[error] subagents cannot spawn further subagents'
      return delegateToSubagent(opts, name, prompt, controller, emit, subOpts)
    },
    callScouts: (scouts) => {
      if (depth > 0 || opts.threadMode === 'isolated') return Promise.resolve('[error] subagents cannot spawn scouts')
      return runScouts(opts, scouts, controller, emit)
    },
    restrictTools,
    send,
    ...(opts.mailboxWake ? { requestMailboxWake: opts.mailboxWake } : {}),
  }

  // Approval gate for guarded tools — loop level, before execution. Absent gate ⇒ deny.
  // Money movement is intrinsically guarded. Configuration may add approval
  // to write tools, but can never accidentally make a trade fail-open.
  if (tool.danger === 'trade' || (tool.danger === 'write' && cfg.guardedTools.includes(tool.name))) {
    const prepared = tool.approvalRequest
      ? await tool.approvalRequest(parsed.data, ctx)
      : { tool: tool.name, input: parsed.data, summary: describe(tool.name, parsed.data), danger: tool.danger }
    if ('error' in prepared) {
      emit({ kind: 'tool_result', runId, tool: tool.name, ok: false })
      return `[guard] ${prepared.error}`
    }
    // A0 is the one exact card bypass: the operator explicitly enabled
    // autonomous apprenticeship while the entire desk is in DRY_RUN, and the
    // registered tool is exactly the trade-classified swap executor. Keep the
    // preparation and decision-audit rails intact; only the human card is
    // skipped. Every other guarded tool still denies without an approval gate.
    const autonomousDryRunAllowed = allowsAutonomousDryRunTrade(cfg, tool)
    const decision = autonomousDryRunAllowed
      ? 'allow'
      : opts.approvalGate
        ? await opts.approvalGate(
            prepared,
            chatId,
            controller.signal,
          )
        : 'no_channel'
    if (autonomousDryRunAllowed) {
      log.info(`autonomous apprenticeship: allowing simulated ${tool.name} without a human approval card`)
    }
    if (tool.onApprovalDecision) {
      try {
        await tool.onApprovalDecision(parsed.data, decision, ctx)
      } catch (error) {
        emit({ kind: 'tool_result', runId, tool: tool.name, ok: false })
        return `[guard] approval audit failed closed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (decision !== 'allow') {
      emit({ kind: 'tool_result', runId, tool: tool.name, ok: false })
      return `[denied] user did not approve '${tool.name}' (${decision}). Do not retry without asking why.`
    }
  }

  try {
    const result = await tool.execute(parsed.data, ctx)

    // Structured evidence stays on the trusted server-side rail. Do NOT append
    // or JSON-stringify result.data into the tool message: that would leak
    // potentially large candle/evidence payloads into the model context,
    // transcript, and token budget. The callback is an observation seam only.
    if (result.data !== undefined && opts.onToolData) {
      try {
        await opts.onToolData({
          runId,
          toolCallId: call.id,
          tool: tool.name,
          agent: agent.name,
          depth,
          chatId,
          data: result.data,
        })
      } catch (captureError) {
        log.warn(
          `tool data capture for ${tool.name} failed: ${
            captureError instanceof Error ? captureError.message : String(captureError)
          }`,
        )
      }
    }

    emit({ kind: 'tool_result', runId, tool: tool.name, ok: true })
    return truncate(result.text)
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      emit({ kind: 'tool_result', runId, tool: tool.name, ok: false })
      return '[interrupted by user]'
    }
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`tool ${tool.name} failed: ${message}`)
    emit({ kind: 'tool_result', runId, tool: tool.name, ok: false })
    return `[error] tool '${tool.name}' failed: ${message}`
  }
}

// Scout fan-out (PR 5, the mother-repo AgentTool pattern, desk-sized): briefs
// run in PARALLEL, each as a depth-1 readonly run sharing the parent's abort;
// the main thread ingests conclusions only (keeps the soak thread lean —
// compounds with microcompact/autocompact).
const SCOUTS_MAX = 4

async function runScouts(
  opts: StartRunOptions,
  briefs: Array<{ agent: string; prompt: string }>,
  controller: AbortController,
  emit: (e: RunEvent) => void,
): Promise<string> {
  const picked = briefs.slice(0, SCOUTS_MAX)
  const dropped = briefs.length - picked.length
  // Wall-clock cap per scout (§12.2), same env knob as single subagents.
  const timeoutMs = Number(process.env.SUBAGENT_TIMEOUT_MS ?? 600_000)

  const runOne = async (brief: { agent: string; prompt: string }, i: number): Promise<TaskNotification> => {
    const child = opts.agentRegistry.get(brief.agent)
    const label = `scout:${brief.agent}#${i}`
    if (!child) {
      emit({ kind: 'tool_result', runId: opts.agentName, tool: label, ok: false })
      return {
        taskId: label,
        status: 'failed',
        summary: `[error] no agent named '${brief.agent}'. Available: ${opts.agentRegistry.names().join(', ')}`,
      }
    }
    emit({ kind: 'tool_call', runId: opts.agentName, tool: label, input: { prompt: brief.prompt } })
    const handle = startRun({
      ...opts,
      agentName: brief.agent,
      userText: brief.prompt,
      actor: systemInternalActor(
        opts.chatId,
        mayProjectPrincipalUser(opts.actor),
        false,
        false,
      ),
      depth: 1,
      readonlyTools: true, // scouts observe, never mutate
    })
    // Scouts share the parent's fate: parent /stop ⇒ every scout aborts.
    controller.signal.addEventListener('abort', () => handle.abort(), { once: true })
    const timer = timeoutMs > 0 ? setTimeout(() => handle.abort(), timeoutMs) : undefined
    try {
      const summary = await handle.done
      emit({ kind: 'tool_result', runId: opts.agentName, tool: label, ok: !summary.aborted })
      if (summary.aborted) {
        return {
          taskId: label,
          status: 'killed',
          summary: controller.signal.aborted
            ? `Scout "${brief.agent}" was stopped with the parent run.`
            : `Scout "${brief.agent}" hit the ${(timeoutMs / 60_000).toFixed(0)}-min wall-clock cap — aborted. Narrow the brief.`,
        }
      }
      log.info(`scout '${brief.agent}' done (${summary.turns} turn(s), ${summary.toolCalls} tool call(s))`)
      return {
        taskId: label,
        status: 'completed',
        summary: `Scout "${brief.agent}" completed (${summary.turns} turn(s), ${summary.toolCalls} tool call(s))`,
        result: summary.finalText || '(scout returned empty response)',
        usage: {
          totalTokens: summary.tokensIn + summary.tokensOut,
          toolUses: summary.toolCalls,
          durationMs: summary.durationMs,
        },
      }
    } catch (err) {
      emit({ kind: 'tool_result', runId: opts.agentName, tool: label, ok: false })
      return {
        taskId: label,
        status: 'failed',
        summary: `Scout "${brief.agent}" failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const reports = await Promise.all(picked.map(runOne))
  const droppedNote = dropped > 0 ? `\n[dropped ${dropped} brief(s) over the ${SCOUTS_MAX}-scout cap]` : ''
  // The mother's coordinatorMode §2 law: worker results arrive as
  // `<task-notification>` envelopes — user-message-shaped but never the
  // principal's voice. One envelope per scout, statuses honest.
  return (
    `🕊 ${picked.length} scout report(s) (read-only):\n\n` +
    reports.map((n) => buildTaskNotification(n)).join('\n\n') +
    droppedNote
  )
}

async function delegateToSubagent(
  opts: StartRunOptions,
  name: string,
  prompt: string,
  controller: AbortController,
  emit: (e: RunEvent) => void,
  subOpts?: { toolAllowlist?: string[]; threadMode?: 'chat' | 'isolated' },
): Promise<string> {
  const child = opts.agentRegistry.get(name)
  if (!child) {
    return `[error] no agent named '${name}'. Available: ${opts.agentRegistry.names().join(', ')}`
  }
  emit({ kind: 'tool_call', runId: opts.agentName, tool: `subagent:${name}`, input: { prompt } })
  const handle = startRun({
    ...opts,
    agentName: name,
    userText: prompt,
    actor: systemInternalActor(
      opts.chatId,
      mayProjectPrincipalUser(opts.actor),
      mayMutateDesk(opts.actor),
      mayMutatePrincipalMemory(opts.actor),
    ),
    depth: 1,
    // The skills narrowing rides the same StartRunOptions as readonlyTools —
    // the child's tools are its agent's allowlist INTERSECT this list.
    ...(subOpts?.toolAllowlist !== undefined ? { toolAllowlist: subOpts.toolAllowlist } : {}),
    // context: fork = a FRESH context: no parent history, no parent
    // transcript writes (enforced at the loop via the threadMode seam).
    ...(subOpts?.threadMode !== undefined ? { threadMode: subOpts.threadMode } : {}),
  })
  // Subagent shares the parent's fate: parent /stop ⇒ child aborts.
  controller.signal.addEventListener('abort', () => handle.abort(), { once: true })
  // Wall-clock cap (§12.2): a scout that can't finish can't spin forever —
  // the run is aborted and reported honestly. SUBAGENT_TIMEOUT_MS, 10 min default.
  const timeoutMs = Number(process.env.SUBAGENT_TIMEOUT_MS ?? 600_000)
  const timer = timeoutMs > 0 ? setTimeout(() => handle.abort(), timeoutMs) : undefined
  try {
    const summaryDone = await handle.done
    if (summaryDone.aborted && !controller.signal.aborted) {
      return `[subagent '${name}' hit the ${(timeoutMs / 60_000).toFixed(0)}-min wall-clock cap — aborted. Narrow the brief.]`
    }
    log.info(`subagent '${name}' done (${summaryDone.turns} turn(s), ${summaryDone.toolCalls} tool call(s))`)
    return summaryDone.finalText || '(subagent returned empty response)'
  } catch (err) {
    return `[error] subagent '${name}' failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function agentRegistry_get(opts: StartRunOptions, name: string): AgentDef | undefined {
  return opts.agentRegistry.get(name)
}

function describe(tool: string, input: unknown): string {
  try {
    return `${tool}(${JSON.stringify(input)})`
  } catch {
    return tool
  }
}

function truncate(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…[truncated]`
    : text
}

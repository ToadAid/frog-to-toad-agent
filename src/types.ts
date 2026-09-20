// Shared types for Frog-to-Toad Agent.

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel'

export type TelegramActorContext = {
  source: 'telegram_user'
  transport: 'telegram'
  chatType: TelegramChatType
  username?: string
  firstName?: string
  lastName?: string
  displayName: string
  isBot: boolean
  ownerBindingConfigured: boolean
  transportIdentityPresent: true
  ownerIdentityMatch: boolean
  authorityGranted: false
} & (
  | {
      principalAuthenticated: true
      principalProvider: 'telegram'
      principalId: 'telegram:system-owner'
      principalRole: 'SYSTEM_OWNER'
    }
  | {
      principalAuthenticated: false
      principalProvider?: never
      principalId?: never
      principalRole?: never
    }
)

export type TurnActorContext =
  | TelegramActorContext
  | {
      source: 'principal_operator'
      displayName: 'Principal operator'
    }
  | {
      source: 'scheduled_system'
      displayName: 'Scheduled system'
    }
  | {
      source: 'system_internal'
      displayName: 'Frog-to-Toad internal task'
      /** Inherited from the initiating turn; internal delegation is never an
       * authority upgrade from a Telegram guest. */
      principalContextAllowed: boolean
      /** Explicit inherited mutation capability; absent legacy records fail closed. */
      deskMutationAllowed: boolean
      /** USER.md is narrower than general desk mutation. */
      principalMemoryMutationAllowed: boolean
    }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[]; actor?: TurnActorContext }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCallReq[]
      reasoning_content?: string
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolCallReq = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** A tool definition as sent to the LLM provider. */
export type ToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type AgentDef = {
  name: string
  emoji: string
  description: string
  /** Tool allowlist. undefined = see all registered tools. */
  tools?: string[]
  /** Model override for this agent (falls back to cfg.llm.model). */
  model?: string
  maxTurns: number
  systemPrompt: string
}

/**
 * Terminal reasons (north-star Tier 2 #12, the loop transition ledger): every
 * exit site the turn engine has, named. The law the widened set serves:
 * "finished" and "guard fired" must be distinguishable in the audit record —
 * a run that ended because a bound refused to extend it is NOT the same event
 * as a run that simply completed.
 *  - FINAL                  clean final pass, nothing asked for more
 *  - FINAL_FOLLOWUP_CAP     clean pass, a hook asked, the follow-up cap refused
 *  - BRAIN_EMPTY            empty reply after the single bounded retry
 *  - TURN_BUDGET            turn-cap synthesis (no budget, or budget spent to target)
 *  - TURN_BUDGET_BUDGET_CAP continuation cap/diminishing fired with the declared
 *                           token target still open — synthesis ran anyway
 *  - ABORTED                every abort site, one semantic
 *  - ERROR                  run-level catch or unknown agent
 */
export type RunTermination =
  | 'FINAL'
  | 'FINAL_FOLLOWUP_CAP'
  | 'BRAIN_EMPTY'
  | 'TURN_BUDGET'
  | 'TURN_BUDGET_BUDGET_CAP'
  | 'ABORTED'
  | 'ERROR'

export type RunSummary = {
  runId: string
  agent: string
  turns: number
  toolCalls: number
  tokensIn: number
  tokensOut: number
  durationMs: number
  aborted: boolean
  termination: RunTermination
  finalText: string
}

/**
 * Withhold-then-recover (north-star Tier 2 #13): the two brain-failure
 * classes the loop's single-shot recovery ladder can absorb. TRANSIENT =
 * rate limit / 5xx / timeout / network blip — the same request succeeds on a
 * retry. CONTEXT_OVERFLOW = the provider refused the prompt size —
 * microcompact relieves it. Anything else (auth, malformed request) surfaces
 * immediately.
 */
export type LlmRecoveryStage = 'TRANSIENT' | 'CONTEXT_OVERFLOW'

export type RunEvent =
  | { kind: 'run_started'; runId: string; agent: string; chatId: number }
  | { kind: 'turn'; runId: string; turn: number }
  | { kind: 'tool_call'; runId: string; tool: string; input: unknown }
  | { kind: 'tool_result'; runId: string; tool: string; ok: boolean }
  /** After-turn seam v2: a hook injected a follow-up and the run continues
   * for one more bounded pass. round is 1-based (cap: AFTER_TURN_FOLLOWUP_MAX). */
  | { kind: 'followup'; runId: string; round: number; text: string }
  /** After-turn seam v2: a hook injected a worker report as a
   * `<task-notification>` envelope (text = provenance mark + envelope).
   * Same grant law as followup — one more bounded pass, same cap. */
  | { kind: 'task_notification'; runId: string; round: number; text: string }
  /** Token budget (mother port): the run reached the turn cap but the
   * principal declared a token target (+500k / "use 2M tokens") that is not
   * yet spent — the nudge is injected as provenance-tagged durable history
   * and the run grants one more working turn. round is 1-based
   * (hard cap: TOKEN_BUDGET_MAX_CONTINUATIONS). */
  | { kind: 'budget_continue'; runId: string; round: number; text: string }
  /** Mid-run agent message (send_alert/notify) — RAW MARKDOWN source, the
   * same text Telegram converts to HTML. TUI renders it; draft ignores it. */
  | { kind: 'notify'; runId: string; text: string }
  /** Away-summary card (PR 4) — RAW MARKDOWN source, pre-HTML-conversion. */
  | { kind: 'away_card'; chatId: number; ts: number; text: string }
  | { kind: 'final'; runId: string; text: string; termination: Exclude<RunTermination, 'ABORTED' | 'ERROR'> }
  /** Mailbox delivery (Tier 2 #7): the agent's inbox messages were injected
   * as one provenance-tagged durable block and one more bounded pass was
   * granted — same grant law as followup, same cap. round is 1-based. */
  | { kind: 'mailbox'; runId: string; round: number; text: string }
  /** Withhold-then-recover (Tier 2 #13): a recoverable brain failure was
   * WITHHELD from the consumer — one recovery stage is running (each stage
   * fires at most once per run; the ladder is the audit trail's
   * "recovering" mark, never a user-visible error). On exhaustion the normal
   * {kind:'error'} surfaces unchanged through the run-level catch. */
  | { kind: 'recovering'; runId: string; stage: LlmRecoveryStage; error: string }
  | { kind: 'error'; runId: string; message: string }
  | { kind: 'aborted'; runId: string }

/** Minimal send surface the rest of the system depends on (Telegram or NullSender in tests). */
export type TelegramSender = {
  send(chatId: number, text: string, opts?: SendOpts): Promise<number | undefined>
  /** Optional communication-only binary image capability. Callers must fail
   * closed when a transport does not implement it. */
  sendPhoto?(
    chatId: number,
    png: Uint8Array,
    opts?: PhotoSendOpts,
  ): Promise<number | undefined>
  edit(chatId: number, messageId: number, text: string): Promise<void>
  /** Edit that reports success/failure (progress-draft circuit). "message is
   * not modified" counts as success — the text is already on screen. */
  tryEdit(chatId: number, messageId: number, text: string): Promise<boolean>
  sendWithKeyboard(
    chatId: number,
    text: string,
    keyboard: InlineButton[][],
  ): Promise<number | undefined>
  editWithKeyboard(
    chatId: number,
    messageId: number,
    text: string,
    keyboard: InlineButton[][],
  ): Promise<void>
  answerCallback(cbQueryId: string, text?: string): Promise<void>
}

export type InlineButton = { text: string; callbackData: string }

export type SendOpts = { replyToMessageId?: number }

export const TELEGRAM_PHOTO_MAX_BYTES = 8 * 1024 * 1024
export const TELEGRAM_PHOTO_MAX_CAPTION_CHARS = 900

export type PhotoSendOpts = {
  caption?: string
  replyToMessageId?: number
}

export type ApprovalRequest = {
  tool: string
  input: unknown
  summary: string
  danger: string
}

export type ApprovalDecision = 'allow' | 'deny' | 'timeout' | 'no_channel'

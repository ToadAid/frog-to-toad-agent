import { Bot, type Context } from 'grammy'
import fs from 'node:fs'
import path from 'node:path'
type InlineKeyboardButton = { text: string; callback_data: string }
import type { Config } from '../config.js'
import type {
  ApprovalRequest,
  InlineButton,
  RunEvent,
  RunSummary,
  SendOpts,
  TelegramActorContext,
  TelegramSender,
  TurnActorContext,
} from '../types.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { LlmClient } from '../llm/client.js'
import type { ToolRegistry } from '../tools/registry.js'
import { startRun, type ApprovalGateFn } from '../loop/agentLoop.js'
import { startPlanFirstRun } from '../loop/planMode.js'
import { applyRewind, formatCheckpointList, listCheckpoints, type RewindResult } from '../loop/rewind.js'
import { getSkillCommands, resolveSkillInvocation, skillExecutionOptions } from '../skills/commands.js'
import { registerAwaySummaryHook, noteAdminActivity } from '../loop/awaySummary.js'
import { registerMagicDocsHook } from '../loop/magicDocs.js'
import { registerDreamHook } from '../loop/dream.js'
import { registerMailboxHook } from '../loop/mailboxDelivery.js'
import { registerSessionMemoryHook } from '../loop/sessionMemory.js'
import * as interrupt from '../loop/interrupt.js'
import { escapeHtml, markdownToTelegramHtml, splitForTelegram } from './render.js'
import { createDraftStream } from './draft.js'
import { createTypingIndicator } from './typing.js'
import { log } from '../log.js'
import { sleep } from '../http.js'
import { loadDeskState, setDeskState } from '../safety/deskState.js'
import {
  createPrincipalAdmissionController,
  PRINCIPAL_CONFIRMATION_CALLBACK_PREFIX,
} from '../memory/principalAdmission.js'
import {
  createPrincipalLifecycleCeremonyController,
  isPrincipalLifecycleCommand,
  PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX,
} from '../memory/principalLifecycleCeremony.js'
import {
  createTelegramActorContext,
  isPrincipalAdminChatActor,
  principalOperatorActor,
  scheduledSystemActor,
} from './actor.js'

export type BotHandle = {
  start: () => Promise<void>
  stop: () => Promise<void>
  sender: TelegramSender
  setApprovalGate: (gate: ApprovalGateFn) => void
  setPendingApprovals: (fn: () => number) => void
  startRunForCron: (prompt: string) => Promise<void>
  /** Desk-prompt lane (TUI /prompt): same queue + gates as a chat message. */
  startAdminRun: (prompt: string, images?: string[]) => void
  rewindAdminThread: (n: number) => Promise<RewindResult>
  adminThreadCheckpoints: () => ReturnType<typeof listCheckpoints>
}

export type CronRunSettlement = {
  status: 'completed' | 'aborted' | 'failed'
  reason?: string
}

export function cronRunSettlement(
  summary: Pick<RunSummary, 'aborted'>,
  runErrorMessage?: string,
): CronRunSettlement {
  if (summary.aborted) {
    return { status: 'aborted', reason: 'scheduled agent run was aborted before completion' }
  }
  if (runErrorMessage !== undefined) {
    return { status: 'failed', reason: `scheduled agent run failed: ${runErrorMessage}` }
  }
  return { status: 'completed' }
}

export type BotDeps = {
  agentRegistry: AgentRegistry
  toolRegistry: ToolRegistry
  llm: LlmClient
  /** Optional tap on every run event (SSE status feed in index.ts). */
  onEvent?: (e: RunEvent) => void
}

/**
 * The Telegram transport. Everything outbound goes through ONE FIFO send queue
 * (~1 msg / 1.2s, 429-aware). Inbound text is serialized per chat: one agent
 * run at a time per conversation, the rest queue up.
 */
export async function createBot(cfg: Config, deps: BotDeps): Promise<BotHandle> {
  const bot = new Bot(cfg.telegram.botToken)
  const toolRegistry = deps.toolRegistry

  // After-turn seam (PR 4): scheduled runs finishing while the principal is
  // idle send a "while you were away" digest card (fails open).
  registerAwaySummaryHook()

  // After-turn seam (PR 7): `# MAGIC DOC:` files read from the sandbox are
  // living documents — refreshed with the conversation's learnings after
  // idle top-level runs (fails open, hands-gate gated).
  registerMagicDocsHook()

  // After-turn seam (batch-2 PR 1, the mother-repo autoDream pattern): when
  // enough time and transcripts have accumulated, one one-shot brain call per
  // memory store folds recent conversation signal into durable entries
  // (fails open, hands-gate gated, USER.md out of scope).
  registerDreamHook()

  // Mailbox delivery (north-star Tier 2 #7): after a clean FINAL pass, the
  // agent's durable inbox is peeked and waiting messages ride one more
  // bounded pass under the follow-up grant law (peek never consumes; the
  // grant site marks read; delivery never relaxes gates).
  registerMailboxHook(() => cfg)

  // After-turn seam (north-star Tier 1 #5, the mother sessionMemory arc): a
  // background extractor rewrites data/memory/session/<chatId>.md from the
  // conversation after every top-level run (fire-and-forget, FIFO, fails
  // open; its own file + state only — every other store out of bounds).
  registerSessionMemoryHook()

  type Gate = ApprovalGateFn & {
    handleCallback?: (data: string, fromUserId: number, cbQueryId: string) => void
  }
  let approvalGate: Gate | undefined
  /** Live pending-approval count for the progress draft's 🔒 line. */
  let pendingApprovalsCount: () => number = () => 0

  // ── Send queue ────────────────────────────────────────────────────────────
  const sendQueue: Array<() => Promise<void>> = []
  let draining = false
  function enqueueSend<T>(job: () => Promise<T>): Promise<T | undefined> {
    return new Promise((resolve) => {
      sendQueue.push(async () => {
        try {
          resolve(await job())
        } catch (err) {
          resolve(undefined)
          log.warn(`send failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      void drainSendQueue()
    })
  }
  async function drainSendQueue(): Promise<void> {
    if (draining) return
    draining = true
    while (sendQueue.length > 0) {
      const job = sendQueue.shift()
      if (!job) break
      try {
        await job()
      } catch {
        /* jobs handle their own errors */
      }
      await sleep(1200)
    }
    draining = false
  }

  async function sendText(
    chatId: number,
    text: string,
    opts?: SendOpts,
  ): Promise<number | undefined> {
    let lastMessageId: number | undefined
    // NOTE: callers pass HTML-ready text (format* helpers escape; model output
    // must be escaped by the caller). Plain-text fallback on parse failure.
    const chunks = splitForTelegram(text)
    for (const chunk of chunks) {
      lastMessageId = await enqueueSend(async () => {
        try {
          const msg = await bot.api.sendMessage(chatId, chunk, {
            parse_mode: 'HTML',
            reply_parameters: opts?.replyToMessageId
              ? { message_id: opts.replyToMessageId }
              : undefined,
          })
          return msg.message_id
        } catch {
          const msg = await bot.api.sendMessage(chatId, chunk, {
            reply_parameters: opts?.replyToMessageId
              ? { message_id: opts.replyToMessageId }
              : undefined,
          })
          return msg.message_id
        }
      })
    }
    return lastMessageId
  }

  /** Our {text, callbackData} shape → Telegram's {text, callback_data}. */
  function toTelegramKeyboard(keyboard: InlineButton[][]): InlineKeyboardButton[][] {
    return keyboard.map((row) =>
      row.map((b) => ({ text: b.text, callback_data: b.callbackData }) as InlineKeyboardButton),
    )
  }

  const sender: TelegramSender = {
    send: sendText,
    async edit(chatId, messageId, text) {
      await enqueueSend(async () => {
        try {
          await bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' })
        } catch {
          await bot.api.editMessageText(chatId, messageId, text)
        }
      })
    },
    /** Edit that REPORTS success — the progress draft's throttle + circuit need it.
     * "message is not modified" is success (the text is already on screen). */
    async tryEdit(chatId, messageId, text) {
      const attempt = async (html: boolean): Promise<boolean> => {
        try {
          if (html) {
            await bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' })
          } else {
            await bot.api.editMessageText(chatId, messageId, text)
          }
          return true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('message is not modified')) return true
          return false
        }
      }
      const ok = await enqueueSend(async () => (await attempt(true)) || (await attempt(false)))
      return ok ?? false
    },
    async sendWithKeyboard(chatId, text, keyboard) {
      return enqueueSend(async () => {
        const msg = await bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: toTelegramKeyboard(keyboard) },
        })
        return msg.message_id
      })
    },
    async editWithKeyboard(chatId, messageId, text, keyboard) {
      await enqueueSend(async () => {
        await bot.api.editMessageText(chatId, messageId, text, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: toTelegramKeyboard(keyboard) },
        })
      })
    },
    async answerCallback(cbQueryId, text) {
      await enqueueSend(async () => {
        try {
          await bot.api.answerCallbackQuery(cbQueryId, { text })
        } catch {
          /* already answered / expired */
        }
      })
    },
  }
  const principalAdmission = createPrincipalAdmissionController(cfg, sender)
  const principalLifecycle = createPrincipalLifecycleCeremonyController(cfg, sender)

  // ── Per-chat run serialization ───────────────────────────────────────────
  const runQueues = new Map<number, Promise<void>>()
  function enqueueRun(chatId: number, job: () => Promise<void>): Promise<void> {
    const prev = runQueues.get(chatId) ?? Promise.resolve()
    const next = prev.then(job, job)
    runQueues.set(
      chatId,
      next.finally(() => {
        if (runQueues.get(chatId) === next) runQueues.delete(chatId)
      }),
    )
    return next
  }

  function isAllowed(chatId: number): boolean {
    if (cfg.telegram.adminChatId !== undefined && chatId === cfg.telegram.adminChatId) return true
    return cfg.telegram.allowedChatIds.includes(chatId)
  }

  function runUserText(
    chatId: number,
    actor: TurnActorContext,
    text: string,
    replyToMessageId?: number,
    images?: string[],
    opts?: { strictCronSettlement?: boolean },
  ): Promise<void> {
    const run = enqueueRun(chatId, async () => {
      let runErrorMessage: string | undefined
      // Progress draft (default on): one live bubble edited through run events,
      // becoming the final answer. Off → the old placeholder + tool edits.
      const draft =
        cfg.telegram.progressDrafts
          ? createDraftStream({
              chatId,
              sender,
              pendingApprovals: () => pendingApprovalsCount(),
            })
          : undefined
      const typing = createTypingIndicator(bot.api)
      // Every conversational ingress converges here (Telegram text and the
      // TUI's /prompt lane). A loaded /name expands before the run starts;
      // unmatched slash-shaped text remains an ordinary prompt. Built-in
      // Telegram commands have already been handled by grammY upstream.
      const skillCall = resolveSkillInvocation(getSkillCommands(cfg).commands, text)
      if (skillCall?.kind === 'not-user-invocable') {
        await sender.send(chatId, skillCall.text)
        return
      }
      if (skillCall?.kind === 'invoke') text = skillCall.text
      const skillRunOptions = skillCall?.kind === 'invoke' ? skillExecutionOptions(skillCall.command) : {}
      // Plan-first mode (PR 6): `[plan] task` → read-only plan run → plan
      // artifact → principal approval through the SAME gate → execution run.
      const planTask = text.startsWith('[plan] ') ? text.slice('[plan] '.length).trim() : undefined
      const handle = planTask
        ? startPlanFirstRun({
            cfg,
            agentRegistry: deps.agentRegistry,
            toolRegistry,
            llm: deps.llm,
            send: sender,
            chatId,
            agentName: 'orchestrator',
            userText: planTask,
            actor,
            userImages: images,
            approvalGate,
            onEvent: (e) => {
              deps.onEvent?.(e)
              draft?.onEvent(e)
            },
          })
        : startRun({
        cfg,
        agentRegistry: deps.agentRegistry,
        toolRegistry,
        llm: deps.llm,
        send: sender,
        chatId,
        agentName: 'orchestrator',
        userText: text,
        actor,
        userImages: images,
        ...skillRunOptions,
        approvalGate,
        onEvent: (e) => {
          deps.onEvent?.(e)
          if (e.kind === 'error') runErrorMessage = e.message
          draft?.onEvent(e)
        },
      })
      typing.start(chatId)
      const summary = await handle.done
      typing.stop()
      if (draft !== undefined) {
        await draft.finalize(summary.finalText, { replyToMessageId, termination: summary.termination })
        if (summary.aborted) await sender.send(chatId, '⏹ Stopped.')
      } else {
        if (summary.finalText.trim() !== '') {
          // Model output is markdown — convert to rendered Telegram HTML, not raw symbols.
          await sender.send(chatId, markdownToTelegramHtml(summary.finalText), { replyToMessageId })
        }
        if (summary.aborted) {
          await sender.send(chatId, '⏹ Stopped.')
        }
      }

      if (opts?.strictCronSettlement === true) {
        const settlement = cronRunSettlement(summary, runErrorMessage)
        if (settlement.status !== 'completed') {
          throw new Error(settlement.reason ?? `scheduled agent run ${settlement.status}`)
        }
      }
    })
    // Manual/Telegram callers intentionally ignore the returned Promise, but
    // attaching a handler prevents an unhandled rejection. Cron callers await
    // the original Promise so A2 can write an honest completion/failure receipt.
    void run.catch((err) => {
      log.error(`run queue error: ${err instanceof Error ? err.stack : String(err)}`)
    })
    return run
  }

  /** Cron-fired prompts enter the same per-chat queue as chat messages. */
  function startRunForCron(prompt: string): Promise<void> {
    const admin = cfg.telegram.adminChatId
    if (admin === undefined) return Promise.reject(new Error('cron run has no admin chat lane'))
    return runUserText(
      admin,
      scheduledSystemActor(admin),
      `[scheduled] ${prompt}`,
      undefined,
      undefined,
      { strictCronSettlement: true },
    )
  }

  /** TUI / desktop prompts: same queue, no [scheduled] tag. Images ride the
   * vision lane exactly like a Telegram photo (data URIs on the user turn). */
  function startAdminRun(prompt: string, images?: string[]): void {
    const admin = cfg.telegram.adminChatId
    if (admin === undefined) return
    noteAdminActivity() // the principal is at the desk typing
    void runUserText(admin, principalOperatorActor(admin), prompt, undefined, images)
  }

  async function rewindAdminThread(n: number): Promise<RewindResult> {
    const admin = cfg.telegram.adminChatId
    if (admin === undefined) return { ok: false, text: '', error: 'no admin chat configured' }
    let out: RewindResult = { ok: false, text: '', error: 'rewind never executed' }
    await enqueueRun(admin, async () => {
      out = applyRewind(cfg, admin, n)
    })
    return out
  }

  function adminThreadCheckpoints(): ReturnType<typeof listCheckpoints> {
    const admin = cfg.telegram.adminChatId
    return admin === undefined ? [] : listCheckpoints(cfg, admin)
  }

  // ── Commands ─────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const chatId = ctx.chat?.id
    if (chatId === undefined) return
    if (!isAllowed(chatId)) {
      await sender.send(
        chatId,
        `This desk is private. Your chat id: ${chatId} — add it to TELEGRAM_ADMIN_CHAT_ID to connect.`,
      )
      return
    }
    await sender.send(
      chatId,
      cfg.dryRun
        ? '🧪 Frog-to-Toad Agent online — DRY RUN mode. No orders will be signed.\n' +
            'Talk to me like a trader: "what is BTC doing?", "research PEPE", "buy 0.1 ETH of MOG (simulated)".\n\n' +
            'Commands: /status /positions /agents /stop /dryrun'
        : '⚡ Frog-to-Toad Agent online — LIVE mode.\nCommands: /status /positions /agents /stop',
    )
  })

  bot.command('help', async (ctx) => {
    if (ctx.chat && isAllowed(ctx.chat.id)) {
      await sender.send(
        ctx.chat.id,
        '🎯 <b>Frog-to-Toad Agent</b>\n\n' +
          '/status — desk status (mode + trading state)\n' +
          '/positions — current positions\n' +
          '/agents — the desk roster\n' +
          '/dryrun — dry-run state\n' +
          '/stop — interrupt the current run (and deny pending approvals)\n\n' +
          '<b>Principal memory (private authenticated principal only)</b>\n' +
          '/remember instruction &lt;content&gt;\n' +
          '/remember preference &lt;content&gt;\n' +
          '/remember revoke &lt;exact active content&gt;\n' +
          '/remember supersede &lt;exact active content&gt;\n' +
          'Each command requires explicit private-principal confirmation and grants no trade or execution authority.\n' +
          'To replace: first admit the new instruction/preference and confirm it; then supersede the old exact content and explicitly select the already-admitted successor.\n\n' +
          '<b>Trading state (principal only)</b>\n' +
          '/halt — refuse ALL trades (persists across restarts)\n' +
          '/reduce — exits only: entries and rotations refused\n' +
          '/resume — back to normal trading',
      )
    }
  })

  bot.command('remember', async (ctx) => {
    const input = {
      chatId: ctx.chat?.id,
      chatType: ctx.chat?.type,
      fromUserId: ctx.from?.id,
      messageId: ctx.message?.message_id,
      updateId: ctx.update.update_id,
      text: ctx.message?.text,
      isForwarded: ctx.message?.forward_origin !== undefined,
    }
    if (isPrincipalLifecycleCommand(input.text)) {
      await principalLifecycle.begin(input)
    } else {
      await principalAdmission.begin(input)
    }
  })

  bot.command('status', async (ctx) => {
    if (!ctx.chat || !isAllowed(ctx.chat.id)) return
    const desk = loadDeskState(cfg)
    const stateBadge = desk.state === 'ACTIVE' ? '▶️ ACTIVE' : desk.state === 'REDUCING' ? '📉 REDUCING' : '🛑 HALTED'
    await sender.send(
      ctx.chat.id,
      `🧭 Desk status\n• Mode: ${cfg.dryRun ? 'DRY RUN 🧪' : 'LIVE ⚡'}\n` +
        `• Trading state: ${stateBadge}${desk.reason ? ` — ${desk.reason}` : ''}\n` +
        `• Brain: ${cfg.llm.model}\n• Per-trade cap: $${cfg.limits.perTradeUsdMax}\n` +
        `• Daily cap: $${cfg.limits.dailyUsdMax}`,
    )
  })

  bot.command('agents', async (ctx) => {
    if (!ctx.chat || !isAllowed(ctx.chat.id)) return
    await sender.send(ctx.chat.id, `🤝 Desk roster:\n${deps.agentRegistry.roster()}`)
  })

  bot.command('dryrun', async (ctx) => {
    if (!ctx.chat || !isAllowed(ctx.chat.id)) return
    await sender.send(
      ctx.chat.id,
      cfg.dryRun
        ? '🧪 DRY RUN — all trades are simulated and written to the ledger. Nothing signs.'
        : '⚡ LIVE mode — real execution enabled.',
    )
  })

  bot.command('stop', async (ctx) => {
    const chatId = ctx.chat?.id
    if (chatId === undefined || !isAllowed(chatId)) return
    const stopped = interrupt.abort(chatId)
    await sender.send(chatId, stopped ? '⏹ Interrupting current run…' : 'Nothing running.')
  })

  // Plan-first mode (PR 6): /plan <task> — read-only plan run → artifact →
  // principal approval card → execution run only on 'allow'.
  bot.command('plan', async (ctx) => {
    const chatId = ctx.chat?.id
    if (chatId === undefined || !isAllowed(chatId)) return
    const task = ctx.message?.text?.replace(/^\/plan\s*/, '').trim() ?? ''
    if (task === '') {
      await sender.send(chatId, 'What should I plan? Usage: /plan <task>')
      return
    }
    const actor = createTelegramActorContext(cfg, ctx.chat, ctx.from)
    if (!actor) return
    noteAdminActivity()
    void runUserText(chatId, actor, `[plan] ${task}`)
  })

  bot.command('rewind', async (ctx) => {
    await handleRewindCommand(
      {
        cfg,
        send: (chatId, text) => sender.send(chatId, text),
        runExclusive: (chatId, job) => enqueueRun(chatId, job),
        noteAdminActivity,
      },
      {
        chat: ctx.chat ? { id: ctx.chat.id, type: ctx.chat.type } : undefined,
        from: ctx.from ? { id: ctx.from.id } : undefined,
        args: ctx.message?.text?.replace(/^\/rewind\s*/, '').trim() ?? '',
      },
    )
  })

  // ── Trading state (Nautilus steal #1) — PRINCIPAL-ONLY, persisted ────────
  // The agent has no tool that touches these. HALTED refuses all trades;
  // REDUCING refuses entries and rotations (only exits into stables pass).
  function setStateCommand(command: 'halt' | 'reduce' | 'resume', label: string): void {
    bot.command(command, async (ctx) => {
      const chatId = ctx.chat?.id
      if (chatId === undefined) return
      const actor = createTelegramActorContext(cfg, ctx.chat, ctx.from)
      if (!isPrincipalAdminChatActor(cfg, actor, chatId)) {
        await sender.send(chatId, '⛔ Only the principal can change trading state.')
        return
      }
      const state = command === 'halt' ? 'HALTED' : command === 'reduce' ? 'REDUCING' : 'ACTIVE'
      const record = setDeskState(cfg, state, `${label} by principal`)
      await sender.send(
        chatId,
        state === 'ACTIVE'
          ? `▶️ Desk ACTIVE — trading resumes behind all guards.`
          : state === 'HALTED'
            ? `🛑 Desk HALTED — every trade refused until /resume.`
            : `📉 Desk REDUCING — entries and rotations refused; exits into stables still pass.`,
      )
      log.info(`desk trading state → ${record.state}${record.reason ? ` (${record.reason})` : ''}`)
    })
  }
  setStateCommand('halt', '/halt')
  setStateCommand('reduce', '/reduce')
  setStateCommand('resume', '/resume')

  bot.command('positions', async (ctx) => {
    if (!ctx.chat || !isAllowed(ctx.chat.id)) return
    await sender.send(ctx.chat.id, '📋 No positions yet — the ledger fills up in Phase 3.')
  })

  // ── Text routing ─────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat?.id
    const text = ctx.message?.text
    if (chatId === undefined || text === undefined) return

    // Groups: ONLY an @mention addresses the desk — no reply-trigger, no
    // chatter (matches Telegram bot privacy mode). The bot's display name
    // works as an alias since that's what humans type in a group.
    let prompt = text
    const chatType = ctx.chat?.type
    if (chatType === 'group' || chatType === 'supergroup') {
      const handles = [ctx.me.username, ctx.me.first_name].filter(
        (h): h is string => typeof h === 'string' && h.length > 0,
      )
      const m = extractMention(text, handles)
      if (!m.addressed) return
      prompt = m.prompt === '' ? 'hello' : m.prompt
    }

    if (!isAllowed(chatId)) {
      // Include the id — the owner copy-pastes it into .env to connect.
      await sender.send(
        chatId,
        `🔒 Private desk. Your chat id is <code>${chatId}</code> — send it to the owner to be allowlisted.`,
      )
      return
    }
    const actor = createTelegramActorContext(cfg, ctx.chat, ctx.from)
    if (!actor) return
    noteAdminActivity() // a real principal message — resets the away clock
    runUserText(chatId, actor, prompt, ctx.message?.message_id)
  })

  // ── Image routing (vision lane) ────────────────────────────────────────────
  // Photos + image documents become data URIs on the fresh user message — the
  // brain sees them THIS turn only; the thread keeps a text note. Caption is
  // the prompt; no caption → the frog is asked what it sees.
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024

  async function downloadImage(ctx: { getFile: () => Promise<{ file_path?: string }> }): Promise<
    { dataUri: string; savedRel: string } | { error: string }
  > {
    try {
      const file = await ctx.getFile()
      if (!file.file_path) return { error: 'Telegram gave no file path' }
      const url = `https://api.telegram.org/file/bot${cfg.telegram.botToken}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) return { error: `download failed: HTTP ${res.status}` }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > MAX_IMAGE_BYTES) {
        return { error: `image too large (${(buf.byteLength / 1e6).toFixed(1)} MB — cap 5 MB)` }
      }
      const ext = (file.file_path.split('.').pop() ?? 'jpg').toLowerCase()
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      // Durable copy in the sandbox — tools can re-read it later by path.
      const inboxDir = path.join(cfg.paths.dataDir, 'sandbox', 'inbox')
      fs.mkdirSync(inboxDir, { recursive: true })
      const name = `${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`
      fs.writeFileSync(path.join(inboxDir, name), buf)
      return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, savedRel: `inbox/${name}` }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function handleImage(
    chatId: number,
    actor: TelegramActorContext,
    getFile: () => Promise<{ file_path?: string }>,
    caption: string | undefined,
    chatType: string | undefined,
    handles: string[],
    messageId: number | undefined,
  ): Promise<void> {
    if (!isAllowed(chatId)) {
      await sender.send(
        chatId,
        `🔒 Private desk. Your chat id is <code>${chatId}</code> — send it to the owner to be allowlisted.`,
      )
      return
    }
    const img = await downloadImage({ getFile })
    if ('error' in img) {
      await sender.send(chatId, `🖼️ Couldn't read that image: ${img.error}`)
      return
    }
    let prompt = caption === undefined || caption.trim() === '' ? 'What do you see in this image?' : caption
    if (chatType === 'group' || chatType === 'supergroup') {
      const m = extractMention(prompt, handles)
      if (!m.addressed) return
      prompt = m.prompt === '' ? 'What do you see in this image?' : m.prompt
    }
    runUserText(chatId, actor, `${prompt}\n\n[image saved to data/sandbox/${img.savedRel}]`, messageId, [img.dataUri])
  }

  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat?.id
    if (chatId === undefined || ctx.message?.photo === undefined) return
    const actor = createTelegramActorContext(cfg, ctx.chat, ctx.from)
    if (!actor) return
    const handles = [ctx.me.username, ctx.me.first_name].filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    )
    await handleImage(chatId, actor, () => ctx.getFile(), ctx.message.caption, ctx.chat?.type, handles, ctx.message.message_id)
  })

  bot.on('message:document', async (ctx) => {
    const chatId = ctx.chat?.id
    const doc = ctx.message?.document
    if (chatId === undefined || doc === undefined || !doc.mime_type?.startsWith('image/')) return
    const actor = createTelegramActorContext(cfg, ctx.chat, ctx.from)
    if (!actor) return
    const handles = [ctx.me.username, ctx.me.first_name].filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    )
    await handleImage(chatId, actor, () => ctx.getFile(), ctx.message.caption, ctx.chat?.type, handles, ctx.message.message_id)
  })

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data
    const fromId = ctx.callbackQuery.from.id
    if (data.startsWith(PRINCIPAL_LIFECYCLE_CALLBACK_PREFIX)) {
      const message = ctx.callbackQuery.message
      await principalLifecycle.handleCallback({
        data,
        chatId: message?.chat.id,
        chatType: message?.chat.type,
        fromUserId: fromId,
        messageId: message?.message_id,
        updateId: ctx.update.update_id,
        callbackQueryId: ctx.callbackQuery.id,
        acknowledge: async (text) => {
          try {
            await ctx.answerCallbackQuery({ text })
            return true
          } catch {
            return false
          }
        },
      })
      return
    }
    if (data.startsWith(PRINCIPAL_CONFIRMATION_CALLBACK_PREFIX)) {
      const message = ctx.callbackQuery.message
      await principalAdmission.handleCallback({
        data,
        chatId: message?.chat.id,
        chatType: message?.chat.type,
        fromUserId: fromId,
        messageId: message?.message_id,
        callbackQueryId: ctx.callbackQuery.id,
        acknowledge: async (text) => {
          try {
            await ctx.answerCallbackQuery({ text })
            return true
          } catch {
            return false
          }
        },
      })
      return
    }
    if (data.startsWith('apr:')) {
      if (approvalGate?.handleCallback) {
        // The gate owns authorization + answering the callback query.
        approvalGate.handleCallback(data, fromId, ctx.callbackQuery.id)
      } else {
        await ctx.answerCallbackQuery({ text: 'approval gate not armed' }).catch(() => {})
      }
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
  })

  bot.catch((err) => {
    log.error(`bot error: ${err.error instanceof Error ? err.error.stack : String(err.error)}`)
  })

  return {
    async start() {
      // Publish the command list — this is the ☰ menu button's contents.
      await bot.api
        .setMyCommands([
          { command: 'status', description: 'Desk status — mode, trading state, caps' },
          { command: 'positions', description: 'Open positions' },
          { command: 'agents', description: 'The desk roster' },
          { command: 'remember', description: 'Record/revoke authenticated principal memory' },
          { command: 'help', description: 'What the desk can do' },
          { command: 'stop', description: 'Interrupt the current run' },
          { command: 'rewind', description: 'Undo the last n runs: /rewind <n>' },
          { command: 'halt', description: 'Refuse ALL trades (principal only)' },
          { command: 'reduce', description: 'Exits only — entries refused (principal only)' },
          { command: 'resume', description: 'Resume normal trading (principal only)' },
        ])
        .catch((err) => log.warn(`setMyCommands failed: ${err instanceof Error ? err.message : String(err)}`))
      // Long polling; drop pending updates older than boot.
      await bot.start({ drop_pending_updates: true })
    },
    async stop() {
      principalAdmission.cancelAll()
      principalLifecycle.cancelAll()
      await bot.stop()
    },
    sender,
    setApprovalGate(gate) {
      approvalGate = gate
    },
    setPendingApprovals(fn) {
      pendingApprovalsCount = fn
    },
    startRunForCron,
    startAdminRun,
    rewindAdminThread,
    adminThreadCheckpoints,
  }
}

export type RewindCommandDeps = {
  cfg: Config
  send: (chatId: number, text: string) => Promise<unknown>
  runExclusive: (chatId: number, job: () => Promise<void>) => Promise<void>
  noteAdminActivity?: () => void
}

export type RewindCommandInput = {
  chat?: { id: number; type?: string }
  from?: { id: number }
  args: string
}

export async function handleRewindCommand(
  deps: RewindCommandDeps,
  input: RewindCommandInput,
): Promise<void> {
  if (!isPrincipalLoopInvocation(deps.cfg, input.chat, input.from)) return
  const chatId = input.chat!.id
  const args = input.args.trim()
  if (args === '') {
    await deps.send(chatId, formatCheckpointList(deps.cfg, chatId))
    return
  }
  const n = Number(args)
  if (!Number.isInteger(n) || n < 1) {
    await deps.send(chatId, '⏪ usage: /rewind [n] — undo the last n runs (no args lists checkpoints)')
    return
  }
  deps.noteAdminActivity?.()
  let out: RewindResult = { ok: false, text: '', error: 'rewind never executed' }
  await deps.runExclusive(chatId, async () => {
    out = applyRewind(deps.cfg, chatId, n)
  })
  await deps.send(chatId, out.ok ? out.text : `⏪ ${out.error}`)
}

/**
 * Group etiquette: does this text address the desk (@mention)? If so, return
 * the prompt with the mention stripped. Bare "@desk" → empty prompt (greeting).
 * Accepts one or more handles (real username + display-name alias). Only a
 * mention addresses the desk — replies and chatter do not.
 * Word-boundary match so "@TradingAgent" never matches inside "@TradingAgentFan".
 */
export function extractMention(
  text: string,
  handles: string | string[],
): { addressed: boolean; prompt: string } {
  const names = Array.isArray(handles) ? handles : [handles]
  // Telegram usernames are [A-Za-z0-9_], so a trailing name-char means a
  // longer/different username, not this one.
  const patterns = names.map((n) => new RegExp(`@${n}(?![A-Za-z0-9_])`, 'g'))
  if (!patterns.some((re) => re.test(text))) return { addressed: false, prompt: text }
  let prompt = text
  for (const re of patterns) prompt = prompt.replace(re, '')
  return { addressed: true, prompt: prompt.replace(/\s+/g, ' ').trim() }
}

/** Stdout "Telegram" for tests and keyless runs. */
export function createNullSender(): TelegramSender & {
  messages: Array<{ chatId: number; text: string }>
  keyboards: Array<{ chatId: number; keyboard: InlineButton[][] }>
  answers: Array<{ cbQueryId: string; text?: string }>
} {
  const messages: Array<{ chatId: number; text: string }> = []
  const keyboards: Array<{ chatId: number; keyboard: InlineButton[][] }> = []
  const answers: Array<{ cbQueryId: string; text?: string }> = []
  const logSend = (chatId: number, text: string) => {
    messages.push({ chatId, text })
    // eslint-disable-next-line no-console
    console.log(`[null-sender → configured destination] ${text}`)
    return Promise.resolve(messages.length)
  }
  return {
    messages,
    keyboards,
    answers,
    send: logSend,
    edit: async (chatId, _id, text) => {
      logSend(chatId, `(edit) ${text}`)
    },
    tryEdit: async (chatId, _id, text) => {
      logSend(chatId, `(tryEdit) ${text}`)
      return true
    },
    sendWithKeyboard: async (chatId, text, keyboard) => {
      keyboards.push({ chatId, keyboard })
      return logSend(chatId, `${text}\n[keyboard: ${keyboard.map((r) => r.map((b) => b.text).join('/')).join('|')}]`)
    },
    editWithKeyboard: async (chatId, _id, text, keyboard) => {
      keyboards.push({ chatId, keyboard })
      logSend(chatId, `(edit+kb) ${text}`)
    },
    answerCallback: async (cbQueryId, text) => {
      answers.push({ cbQueryId, text })
    },
  }
}

export type { ApprovalRequest, InlineButton }

/** The exact private-principal boundary: the configured admin chat, in a
 * private chat, from the configured principal Telegram user ID. Generic allowlisted
 * chats are NOT this — an allowed group member is not the principal. */
export function isPrincipalLoopInvocation(
  cfg: Config,
  chat: { id: number; type?: string } | undefined,
  from: { id: number } | undefined,
): boolean {
  const admin = cfg.telegram.adminChatId
  const principal = cfg.telegram.principalUserId
  if (admin === undefined || principal === undefined) return false
  if (!chat || chat.type !== 'private' || chat.id !== admin) return false
  if (!from || from.id !== principal) return false
  return true
}

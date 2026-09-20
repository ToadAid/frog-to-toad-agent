import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import type { ApprovalRequest, ApprovalDecision, TelegramSender } from '../types.js'
import type { ApprovalGateFn } from '../loop/agentLoop.js'
import { formatApprovalCard } from '../telegram/render.js'
import { guard } from './guard.js'
import { log } from '../log.js'

type Pending = {
  resolve: (d: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
  cardMessageId: number | undefined
  chatId: number
  createdAt: number
  req: ApprovalRequest
}

/**
 * The approval gate: a guarded tool call becomes a Telegram inline card.
 * THE DEFAULT IS DENY — on timeout, abort, restart, or any failure.
 * Only the admin chat id may press the buttons; callbacks from anyone else
 * are answered with 'not authorized' and ignored.
 */
/** One pending approval, as the dashboard shows it. */
export type PendingApproval = {
  reqId: string
  tool: string
  summary: string
  danger: string
  ageSec: number
  timeoutSec: number
}

/** Optional observer hook — the status server turns these into SSE events. */
export type ApprovalEvent =
  | { kind: 'approval_created'; reqId: string; tool: string; summary: string; danger: string; ts: number }
  | { kind: 'approval_decided'; reqId: string; tool: string; decision: ApprovalDecision; via: string; ts: number }

export type ApprovalGate = ApprovalGateFn & {
  handleCallback: (data: string, fromUserId: number, cbQueryId: string) => void
  pendingCount: () => number
  /** Detail view for the dashboard: every pending request with its full context. */
  pendingList: () => PendingApproval[]
  /** Desktop answer path (same gate as Telegram). false when unknown/expired. */
  decide: (reqId: string, allow: boolean) => boolean
  /** Kill switch: deny every pending approval. Returns how many were denied. */
  denyAll: (via: string) => number
}

export function createApprovalGate(
  cfg: Config,
  send: TelegramSender,
  onEvent?: (e: ApprovalEvent) => void,
): ApprovalGate {
  const pending = new Map<string, Pending>()
  /** Wall-clock time of the last card actually sent — the throttle's clock. */
  let lastCardAt: number | undefined

  function settle(reqId: string, decision: ApprovalDecision, via: string): void {
    const p = pending.get(reqId)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(reqId)
    p.resolve(decision)
    onEvent?.({
      kind: 'approval_decided',
      reqId,
      tool: p.req.tool,
      decision,
      via,
      ts: Date.now(),
    })
    // Update the card so the chat shows the outcome.
    if (p.cardMessageId !== undefined) {
      void send.edit(
        p.chatId,
        p.cardMessageId,
        `${formatApprovalCard({ ...p.req, timeoutSec: cfg.limits.approvalTimeoutSec })}\n\n` +
          (decision === 'allow' ? `✅ APPROVED ${via}` : `❌ DENIED ${via}`),
      )
    }
  }

  const gate: ApprovalGateFn = async (req, chatId, signal) => {
    if (signal.aborted) return 'deny'
    if (cfg.telegram.adminChatId === undefined || cfg.telegram.principalUserId === undefined) return 'no_channel'

    // Throttle (Nautilus message-bus steal): a runaway agent loop must not be
    // able to spam the principal's phone with cards. Deny-default applies —
    // an un-sent card is a DENIED card, and the loop can react to the refusal.
    if (pending.size >= cfg.limits.approvalMaxPending) {
      log.warn(
        `approval throttle: ${pending.size} card(s) already pending (max ${cfg.limits.approvalMaxPending}) — refusing new card for ${req.tool} (deny-default)`,
      )
      return 'deny'
    }
    if (lastCardAt !== undefined && Date.now() - lastCardAt < cfg.limits.approvalMinIntervalSec * 1000) {
      log.warn(
        `approval throttle: card for ${req.tool} arrived ${Date.now() - lastCardAt}ms after the previous one (min ${cfg.limits.approvalMinIntervalSec}s) — refused`,
      )
      return 'deny'
    }

    const reqId = randomUUID().slice(0, 8)
    const card = formatApprovalCard({
      tool: req.tool,
      summary: req.summary,
      danger: req.danger,
      timeoutSec: cfg.limits.approvalTimeoutSec,
    })
    const messageId = await send.sendWithKeyboard(
      chatId,
      card,
      [
        [
          { text: '✅ Approve', callbackData: `apr:${reqId}:y` },
          { text: '❌ Deny', callbackData: `apr:${reqId}:n` },
        ],
      ],
    )
    lastCardAt = Date.now()

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        settle(reqId, 'timeout', '(timeout — auto-deny)')
      }, cfg.limits.approvalTimeoutSec * 1000)
      pending.set(reqId, { resolve, timer, cardMessageId: messageId, chatId, createdAt: Date.now(), req })
      onEvent?.({
        kind: 'approval_created',
        reqId,
        tool: req.tool,
        summary: req.summary,
        danger: req.danger,
        ts: Date.now(),
      })

      signal.addEventListener(
        'abort',
        () => {
          settle(reqId, 'deny', '(run stopped)')
        },
        { once: true },
      )
    })
  }

  // Wire the callback handler onto the returned function (bot calls this).
  const withCallbacks = gate as ApprovalGate

  withCallbacks.handleCallback = (data, fromUserId, cbQueryId) => {
    const parts = data.split(':')
    const reqId = parts[1] ?? ''
    const vote = parts[2]
    if (cfg.telegram.principalUserId === undefined || fromUserId !== cfg.telegram.principalUserId) {
      void send.answerCallback(cbQueryId, '🔒 not authorized')
      return
    }
    const p = pending.get(reqId)
    if (!p) {
      void send.answerCallback(cbQueryId, 'expired or unknown approval')
      return
    }
    void send.answerCallback(cbQueryId, vote === 'y' ? 'approved' : 'denied')
    settle(reqId, vote === 'y' ? 'allow' : 'deny', vote === 'y' ? '(by owner)' : '(by owner)')
  }

  withCallbacks.pendingCount = () => pending.size

  withCallbacks.pendingList = () =>
    [...pending.entries()].map(([reqId, p]) => ({
      reqId,
      tool: p.req.tool,
      summary: p.req.summary,
      danger: p.req.danger,
      ageSec: Math.floor((Date.now() - (p.createdAt ?? Date.now())) / 1000),
      timeoutSec: cfg.limits.approvalTimeoutSec,
    }))

  withCallbacks.decide = (reqId, allow) => {
    if (!pending.has(reqId)) return false
    settle(reqId, allow ? 'allow' : 'deny', allow ? '(approved on dashboard)' : '(denied on dashboard)')
    return true
  }

  withCallbacks.denyAll = (via: string) => {
    const ids = [...pending.keys()]
    for (const reqId of ids) settle(reqId, 'deny', `(${via})`)
    return ids.length
  }

  void guard // guard checks run inside trade tools; the gate only handles human intent
  log.debug('approval gate armed')
  return withCallbacks
}

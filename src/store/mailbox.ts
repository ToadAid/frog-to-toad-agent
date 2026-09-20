import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Config } from '../config.js'
import { log } from '../log.js'

/**
 * The agent mailbox (mother-repo north-star Tier 2 #7, teammateMailbox.ts
 * desk-sized): ONE JSON inbox per agent under data/mailbox/<agent>.json —
 * durable, restart-surviving, cross-process honest.
 *
 * HARD RULES — enforced in code, both directions, never just documented:
 *  - PERMISSION-TYPE ENVELOPES DROPPED ENTIRELY: the mother's
 *    team_permission_update / mode_set_request / permission_request(_response)
 *    / sandbox_permission_* never travel this mailbox. writeToMailbox REFUSES
 *    them (names the violation, writes nothing) and the reader QUARANTINES
 *    any that appear in a file (never surfaced, logged). A message can never
 *    change another agent's tools, modes, or authority — not even by accident.
 *  - NO BROADCAST: one named recipient per send. The mother's `*` broadcast
 *    is dropped by omission — the API has no such parameter at all.
 *  - APPROVAL ≠ EXECUTION: a plan_approval_response is context data for the
 *    recipient run. The execution gates (approvalGate, DRY_RUN) are unchanged
 *    and still required — a mailbox approval alone can never move anything.
 *
 * Delivery semantics (the mother's busy→end-of-turn lane, desk-sized): a
 * running agent PEEKS its unread inbox after a clean FINAL pass (see
 * loop/mailboxDelivery.ts); the messages are marked read only when the
 * after-turn grant actually happens — a refused extension never consumes
 * mail. Idle→autonomous-run spawn is a v2 decision, deliberately not here.
 *
 * The lock is the #4 tasks-store pattern desk-wide: O_EXCL create with an
 * ownership token, bounded retries, stale fail-closed (stale is not
 * permission to steal).
 */

export type MailboxMessage = {
  /** Sender's agent name — identity the recipient can judge, never forged. */
  from: string
  text: string
  timestamp: string
  read: boolean
  /** Stable id set at write; mark-read targets ids, never array indexes. */
  id: string
}

/** Recipients/senders are agent names (agents/*.md `name`) or `principal`
 * (the operator's inbox). Typeable, charset-safe, one token. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const TEXT_MAX = 16_384
const MAILBOX_MAX_MESSAGES = 200 // the inbox is a queue, not an archive

function lockAttempts(): number {
  return Math.max(1, Number(process.env['MAILBOX_LOCK_ATTEMPTS']) || 40)
}
function lockDelayMs(): number {
  return Math.max(1, Number(process.env['MAILBOX_LOCK_DELAY_MS']) || 25)
}
function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as NodeJS.ErrnoException).code === 'string'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

// ── typed protocol (JSON-in-text, the mother's structured-envelope shape) ───
// Desk-sized to TWO types: the plan-approval round trip. Everything else the
// mother speaks (shutdown, task assignment, permission anything) either has a
// desk-native mechanism already (interrupt) or is a money-safety drop.

const PlanApprovalRequestSchema = z
  .object({
    type: z.literal('plan_approval_request'),
    from: z.string().min(1),
    timestamp: z.string().min(1),
    requestId: z.string().min(1),
    planContent: z.string().min(1).max(65_536),
  })
  .strict()

const PlanApprovalResponseSchema = z
  .object({
    type: z.literal('plan_approval_response'),
    requestId: z.string().min(1),
    approved: z.boolean(),
    feedback: z.string().max(8_192).optional(),
    timestamp: z.string().min(1),
  })
  // .strict() IS the hard rule: the mother's response carries an optional
  // `permissionMode` — here a response that tries to carry a permission mode
  // is REFUSED, not stripped.
  .strict()

export type PlanApprovalRequest = z.infer<typeof PlanApprovalRequestSchema>
export type PlanApprovalResponse = z.infer<typeof PlanApprovalResponseSchema>

export function parsePlanApprovalRequest(text: string): PlanApprovalRequest | null {
  try {
    const r = PlanApprovalRequestSchema.safeParse(JSON.parse(text))
    if (r.success) return r.data
  } catch {
    // not JSON — plain text by law
  }
  return null
}

export function parsePlanApprovalResponse(text: string): PlanApprovalResponse | null {
  try {
    const r = PlanApprovalResponseSchema.safeParse(JSON.parse(text))
    if (r.success) return r.data
  } catch {
    // not JSON — plain text by law
  }
  return null
}

export function createPlanApprovalRequest(from: string, planContent: string): { envelope: string; requestId: string } {
  const requestId = randomUUID()
  const envelope = JSON.stringify({
    type: 'plan_approval_request' as const,
    from,
    timestamp: new Date().toISOString(),
    requestId,
    planContent,
  })
  return { envelope, requestId }
}

export function createPlanApprovalResponse(requestId: string, approved: boolean, feedback?: string): string {
  return JSON.stringify({
    type: 'plan_approval_response' as const,
    requestId,
    approved,
    ...(feedback !== undefined ? { feedback } : {}),
    timestamp: new Date().toISOString(),
  })
}

// ── the money-safety refusal (HARD RULE) ────────────────────────────────────

/** Envelope types that NEVER travel the mailbox. A message whose parsed JSON
 * claims one of these types is refused at write and quarantined at read —
 * even if the rest of the envelope is malformed: the CLAIM is the violation. */
const FORBIDDEN_TYPES = [
  'team_permission_update',
  'mode_set_request',
  'permission_request',
  'permission_response',
  'sandbox_permission_request',
  'sandbox_permission_response',
] as const

/** The forbidden type the text claims, or null when it claims none. Two
 * checks: the parsed `type` field of any JSON object, and a raw-text scan —
 * a MALFORMED envelope that still claims a forbidden type in its body is
 * refused all the same (the claim is the violation, parseable or not). */
export function forbiddenTypeClaim(text: string): string | null {
  try {
    const obj: unknown = JSON.parse(text)
    if (typeof obj === 'object' && obj !== null && 'type' in obj) {
      const t = (obj as { type?: unknown })['type']
      if (typeof t === 'string' && (FORBIDDEN_TYPES as readonly string[]).includes(t)) return t
    }
  } catch {
    // not parseable JSON — fall through to the raw-text scan
  }
  const m = /"type"\s*:\s*"([a-z_]+)"/i.exec(text)
  if (m && (FORBIDDEN_TYPES as readonly string[]).includes(m[1]!)) return m[1]!
  return null
}

// ── the store ───────────────────────────────────────────────────────────────

export function mailboxDir(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'mailbox')
}

function inboxFile(cfg: Config, agentName: string): string {
  if (!NAME_RE.test(agentName)) throw new Error(`mailbox: invalid agent name '${agentName}'`)
  return path.join(mailboxDir(cfg), `${agentName}.json`)
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** ENOENT is the ONLY condition that maps to an empty inbox — an absent
 * inbox is a fact, like the mother's readMailbox. Anything else throws:
 * a corrupt inbox is refused, never silently emptied (tasks-store law). */
export function readMailbox(cfg: Config, agentName: string): MailboxMessage[] {
  let raw: string
  try {
    raw = fs.readFileSync(inboxFile(cfg, agentName), 'utf8')
  } catch (e) {
    if (isErrnoException(e) && e.code === 'ENOENT') return []
    throw new Error(`mailbox '${agentName}' unreadable: ${(e as Error).message}`)
  }
  const messages: unknown = JSON.parse(raw)
  if (!Array.isArray(messages)) throw new Error(`mailbox '${agentName}' is not an array`)
  const out: MailboxMessage[] = []
  for (const m of messages) {
    const msg = m as Partial<MailboxMessage>
    if (
      typeof msg?.from === 'string' &&
      typeof msg?.text === 'string' &&
      typeof msg?.timestamp === 'string' &&
      typeof msg?.read === 'boolean' &&
      typeof msg?.id === 'string'
    ) {
      out.push({ from: msg.from, text: msg.text, timestamp: msg.timestamp, read: msg.read, id: msg.id })
    } else {
      throw new Error(`mailbox '${agentName}' holds a malformed message (refused, never skipped)`)
    }
  }
  return out
}

export type UnreadMessage = MailboxMessage & { index: number }

/** Peek WITHOUT consuming: the delivery seam decides later. A refused
 * extension must never have consumed the messages it carried. */
export function peekUnread(cfg: Config, agentName: string): UnreadMessage[] {
  return readMailbox(cfg, agentName)
    .map((m, index) => ({ ...m, index }))
    .filter((m) => !m.read)
}

/** ONE inbox lock around every mutation, the tasks-store pattern: O_EXCL
 * create is the "who entered" proof; the token proves ownership at release. */
async function withInboxLock<T>(cfg: Config, agentName: string, fn: () => T): Promise<T> {
  const dir = mailboxDir(cfg)
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, `.${agentName}.lock`)
  const token = randomUUID()
  let acquired = false
  for (let attempt = 0; attempt < lockAttempts(); attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }))
      fs.closeSync(fd)
      acquired = true
      break
    } catch (e) {
      if (isErrnoException(e) && e.code === 'EEXIST') {
        await sleep(lockDelayMs())
        continue
      }
      throw new Error(`mailbox lock could not be created: ${(e as Error).message}`)
    }
  }
  if (!acquired) {
    throw new Error(`mailbox '${agentName}' is busy — .${agentName}.lock is held. ` +
      'If no other desk process is running, remove the lock file by hand (stale is not permission to steal).')
  }
  try {
    return fn()
  } finally {
    try {
      const raw = JSON.parse(fs.readFileSync(lock, 'utf8') as string) as { token?: string }
      if (raw?.token === token) fs.rmSync(lock, { force: true })
      else log.warn(`mailbox ${agentName}: release skipped — lock changed hands mid-operation`)
    } catch (e) {
      log.warn(`mailbox ${agentName}: release skipped — ${(e as Error).message}`)
    }
  }
}

/** Send ONE message to ONE named recipient. Hard rules live here: the
 * permission-type refusal, the recipient charset, the text bound. */
export async function writeToMailbox(cfg: Config, recipient: string, from: string, text: string): Promise<void> {
  if (!NAME_RE.test(recipient)) throw new Error(`mailbox: invalid recipient '${recipient}'`)
  if (!NAME_RE.test(from)) throw new Error(`mailbox: invalid sender '${from}'`)
  const body = text.trim()
  if (body === '') throw new Error('mailbox: empty message')
  if (body.length > TEXT_MAX) throw new Error(`mailbox: message exceeds ${TEXT_MAX} chars`)
  const forbidden = forbiddenTypeClaim(body)
  if (forbidden !== null) {
    // HARD RULE: a permission-type envelope is refused at the write — named,
    // logged, and NOTHING is stored. No recipient ever sees it.
    log.warn(`mailbox: REFUSED permission-type envelope '${forbidden}' from ${from} to ${recipient}`)
    throw new Error(`mailbox: permission-type envelopes never travel the mailbox (refused '${forbidden}')`)
  }
  await withInboxLock(cfg, recipient, () => {
    const messages = readMailboxInLock(cfg, recipient)
    if (messages.length >= MAILBOX_MAX_MESSAGES) {
      throw new Error(`mailbox '${recipient}' is full (>${MAILBOX_MAX_MESSAGES}) — recipient must drain first`)
    }
    messages.push({ from, text: body, timestamp: new Date().toISOString(), read: false, id: randomUUID() })
    writeJsonAtomic(inboxFile(cfg, recipient), messages)
  })
}

/** Mark EXACTLY these message ids read — the injection site consumes what it
 * actually delivered, after the grant, never at peek. */
export async function markMessagesRead(cfg: Config, agentName: string, ids: string[]): Promise<void> {
  await withInboxLock(cfg, agentName, () => {
    const messages = readMailboxInLock(cfg, agentName)
    const wanted = new Set(ids)
    let changed = false
    for (const m of messages) {
      if (wanted.has(m.id) && !m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) writeJsonAtomic(inboxFile(cfg, agentName), messages)
  })
}

/** Drain: read unread + mark read in ONE locked operation (the tool lane —
 * an agent draining its own inbox into its context consumes what it reads). */
export async function drainMailbox(cfg: Config, agentName: string): Promise<UnreadMessage[]> {
  return withInboxLock(cfg, agentName, () => {
    const messages = readMailboxInLock(cfg, agentName)
    const unread: UnreadMessage[] = []
    const messagesOut = messages.map((m, index) => {
      if (m.read) return m
      unread.push({ ...m, index })
      return { ...m, read: true }
    })
    if (unread.length > 0) writeJsonAtomic(inboxFile(cfg, agentName), messagesOut)
    return unread
  })
}

function readMailboxInLock(cfg: Config, agentName: string): MailboxMessage[] {
  return readMailbox(cfg, agentName)
}

/** Quarantine (HARD RULE, read side): strip any permission-type envelope that
 * somehow sits in an inbox file (a hand-edited file, an old process). The
 * claimed type is logged, the message is never surfaced, and it is marked
 * read so it can not be re-delivered — refuse, log, move on. */
export function quarantinePermissionMessages(cfg: Config, agentName: string, messages: UnreadMessage[]): UnreadMessage[] {
  const delivered: UnreadMessage[] = []
  for (const m of messages) {
    const forbidden = forbiddenTypeClaim(m.text)
    if (forbidden === null) {
      delivered.push(m)
      continue
    }
    log.warn(
      `mailbox ${agentName}: QUARANTINED message ${m.id} from ${m.from} — claims permission-type '${forbidden}' (never delivered)`,
    )
    void markMessagesRead(cfg, agentName, [m.id])
  }
  return delivered
}
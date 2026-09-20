/**
 * Task-notification envelope (mother-repo port: coordinatorMode.ts §2/§5).
 * Worker results — scout reports now, background lanes later — arrive as
 * `<task-notification>` XML: they look like user text but are not. The brain
 * distinguishes them by the opening tag, and the envelope itself is the
 * provenance mark.
 *
 * Laws:
 *  - NOTIFICATION IS NOT VOICE — a notification may inform a reply but never
 *    speaks as the principal. The brain reads it, understands it, and
 *    synthesizes its own answer; it never relays a worker's words as if the
 *    desk itself had concluded them.
 *  - BOUNDED — a notification is capped in every dimension it carries. A
 *    worker that rambles cannot flood the thread (result, summary, usage all
 *    clamped).
 *  - AN ENVELOPE NEVER CARRIES AN ENVELOPE — report text quoting the envelope
 *    tags is stripped before wrapping, and every untrusted field is XML-TEXT
 *    escaped before interpolation. Worker text may live inside an envelope;
 *    it may never become envelope structure: no worker-supplied `<` or `>`
 *    can survive as markup, so forged siblings (`</result><status>…`) are
 *    impossible while the document keeps exactly one outer wrapper.
 *  - PROVENANCE — an injected notification carries the desk's mark
 *    (`[task notification]`) above the envelope, so durable thread history
 *    always shows the principal did not write it.
 */

export type TaskNotificationStatus = 'completed' | 'failed' | 'killed'

export type TaskNotification = {
  /** The worker's identity (e.g. the scout label `scout:researcher#0`). */
  taskId: string
  status: TaskNotificationStatus
  /** Human-readable outcome: "completed", "failed: {error}", or "was stopped". */
  summary: string
  /** The worker's final text response. Optional (mother §2). */
  result?: string
  usage?: {
    totalTokens?: number
    toolUses?: number
    durationMs?: number
  }
}

/** Marker prepended to every injected notification — the provenance law. */
export const TASK_NOTIFICATION_PREFIX = '[task notification]'

const SUMMARY_MAX_CHARS = 200
const RESULT_MAX_CHARS = 2_000

function clampCount(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined
  return Math.max(0, Math.floor(n))
}

/** Strip envelope tags quoted inside report text — an envelope never carries
 * an envelope, and quoted tags can neither forge one nor break out of one. */
function stripEnvelopeTags(text: string): string {
  return text
    .replaceAll(/<task-notification>/gi, '')
    .replaceAll(/<\/task-notification>/gi, '')
}

/** XML TEXT escaping for untrusted worker strings: worker text may live
 * inside an envelope, but no raw `<` or `>` it supplies may become envelope
 * structure. Applied AFTER wrapper-tag stripping and bounding — the escape
 * is the last step before interpolation. (`&` first, or the other
 * replacements would double-encode.) */
function escapeXmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** The truncation law, unchanged: cap the CLEAN (stripped) text. */
function bound(text: string, max: number): string {
  const clean = stripEnvelopeTags(text)
  return clean.length > max ? `${clean.slice(0, max)}…[truncated]` : clean
}

/** The untrusted-text pipeline, in its one lawful order: strip forbidden
 * wrapper tags → bound (the truncation law) → XML-escape → interpolate. */
function untrustedField(text: string, max: number): string {
  return escapeXmlText(bound(text, max))
}

/**
 * Render one bounded notification envelope (mother §2 format verbatim —
 * `<result>` and `<usage>` are optional sections).
 */
export function buildTaskNotification(n: TaskNotification): string {
  const lines: string[] = ['<task-notification>']
  lines.push(`<task-id>${untrustedField(n.taskId, SUMMARY_MAX_CHARS)}</task-id>`)
  lines.push(`<status>${n.status}</status>`)
  lines.push(`<summary>${untrustedField(n.summary, SUMMARY_MAX_CHARS)}</summary>`)
  if (n.result !== undefined && n.result !== '') {
    lines.push(`<result>${untrustedField(n.result, RESULT_MAX_CHARS)}</result>`)
  }
  const usage = {
    totalTokens: clampCount(n.usage?.totalTokens),
    toolUses: clampCount(n.usage?.toolUses),
    durationMs: clampCount(n.usage?.durationMs),
  }
  if (usage.totalTokens !== undefined || usage.toolUses !== undefined || usage.durationMs !== undefined) {
    lines.push('<usage>')
    if (usage.totalTokens !== undefined) lines.push(`  <total_tokens>${usage.totalTokens}</total_tokens>`)
    if (usage.toolUses !== undefined) lines.push(`  <tool_uses>${usage.toolUses}</tool_uses>`)
    if (usage.durationMs !== undefined) lines.push(`  <duration_ms>${usage.durationMs}</duration_ms>`)
    lines.push('</usage>')
  }
  lines.push('</task-notification>')
  return lines.join('\n')
}

/** The full injected message: the desk's provenance mark above the envelope. */
export function injectTaskNotification(n: TaskNotification): string {
  return `${TASK_NOTIFICATION_PREFIX}\n\n${buildTaskNotification(n)}`
}

/** A notification is recognized by its opening tag (mother §2) — not by the
 * prefix alone, and never by a closing tag without an opening one. */
export function isTaskNotificationMessage(text: string): boolean {
  return typeof text === 'string' && text.includes('<task-notification>')
}

/** Structural validation for a directive-carrying notification. Returns the
 * reason it was refused, or undefined when well-formed. */
export function invalidTaskNotificationReason(n: unknown): string | undefined {
  if (typeof n !== 'object' || n === null) return 'not an object'
  const cand = n as Partial<TaskNotification>
  if (typeof cand.taskId !== 'string' || cand.taskId.trim() === '') return 'missing taskId'
  if (cand.status !== 'completed' && cand.status !== 'failed' && cand.status !== 'killed') {
    return `invalid status '${String(cand.status)}' (completed|failed|killed)`
  }
  if (typeof cand.summary !== 'string' || cand.summary.trim() === '') return 'missing summary'
  if (cand.result !== undefined && typeof cand.result !== 'string') return 'result must be a string'
  return undefined
}
/** Telegram rendering helpers: HTML escaping, 4096 chunking, card formatting. */

const TELEGRAM_MAX = 4096

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Model output is MARKDOWN; Telegram speaks HTML (MarkdownV2 needs 18 chars
 * escaped — hopeless for LLM prose). Escape first, then convert the common
 * markdown constructs to real Telegram formatting so messages RENDER instead
 * of showing raw asterisks and backticks. Anything unrecognized stays literal.
 * Unbalanced output can still fail Telegram's parser → caller's plain-text
 * fallback catches it.
 */
export function markdownToTelegramHtml(md: string): string {
  let text = escapeHtml(md)

  // Fenced code first — protect the content from every later transform.
  const fences: string[] = []
  text = text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    fences.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
    return `@@FENCE${fences.length - 1}@@`
  })

  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>') // bold BEFORE italic, so ** isn't two italics
    // Italic needs the asterisk HUGGING word chars — "2 * 3" must never pair
    // with a stray * later on the line and italicize half a sentence.
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '<i>$1</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>')

  // Blockquotes: consecutive lines that began life as "> " (escaped to &gt;).
  text = text.replace(/^(?:&gt;\s?.*(?:\n|$))+/gm, (block) => {
    const inner = block.replace(/^&gt;\s?/gm, '').replace(/\n$/, '')
    return `<blockquote>${inner}</blockquote>\n`
  })

  text = text.replace(/@@FENCE(\d+)@@/g, (_m, i: string) => fences[Number(i)] ?? '')
  return text
}

/**
 * Split text into <=4000-char chunks for Telegram (buffer for entities).
 * Split priority: paragraph boundary → line boundary → sentence → hard slice.
 * Never splits inside a fenced code block if avoidable.
 */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit)
    // Don't split inside a code fence: prefer the fence boundary if present.
    const fenceIdx = window.lastIndexOf('```')
    let cut = -1
    const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. ')]
    for (const c of candidates.sort((a, b) => b - a)) {
      if (c > limit * 0.3 && (fenceIdx === -1 || c < fenceIdx)) {
        cut = c + (c === window.lastIndexOf('. ') ? 1 : 0)
        break
      }
    }
    if (cut === -1) cut = limit
    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

import { shortAddress } from '../tools/tokens.js'

export type TradeCardData = {
  simulated: boolean
  fromToken: string
  toToken: string
  /** Contract address of the buy token when known — shown on the card. */
  toTokenAddress?: string
  fromAmount: string
  toAmount: string
  priceImpactPct?: number
  notes?: string
}

export function formatTradeCard(t: TradeCardData): string {
  const header = t.simulated ? '🧪 <b>SIMULATED TRADE (dry-run)</b>' : '⚡ <b>TRADE</b>'
  const impact =
    t.priceImpactPct !== undefined ? `\n📉 Price impact: ${t.priceImpactPct.toFixed(2)}%` : ''
  const contract = t.toTokenAddress
    ? `\n📜 Contract: <code>${escapeHtml(shortAddress(t.toTokenAddress))}</code>`
    : ''
  const notes = t.notes ? `\n\n${escapeHtml(t.notes)}` : ''
  return (
    `${header}\n\n` +
    `💱 ${escapeHtml(t.fromAmount)} ${escapeHtml(t.fromToken)} → ${escapeHtml(t.toAmount)} ${escapeHtml(t.toToken)}` +
    contract +
    impact +
    notes
  )
}

export function formatApprovalCard(req: {
  tool: string
  summary: string
  danger: string
  timeoutSec: number
}): string {
  return (
    `🔔 <b>APPROVAL REQUIRED</b>\n\n` +
    `Tool: <code>${escapeHtml(req.tool)}</code>\n` +
    `${escapeHtml(req.summary)}\n\n` +
    `⏱ Auto-<b>DENY</b> in ${req.timeoutSec}s if you don't answer.`
  )
}

export function formatPositions(p: {
  positions: Array<{ symbol: string; qty: number; avgEntryUsd: number; unrealizedUsd: number | null }>
  realizedPnlUsd: number
  dryRun: boolean
}): string {
  const header = p.dryRun ? '📋 <b>Positions (SIMULATED)</b>' : '📋 <b>Positions</b>'
  if (p.positions.length === 0) {
    return `${header}\n\nNo open positions. Realized P&L: $${p.realizedPnlUsd.toFixed(2)}`
  }
  const rows = p.positions
    .map((pos) => {
      const pnl =
        pos.unrealizedUsd !== null
          ? ` · P&L ${pos.unrealizedUsd >= 0 ? '+' : ''}$${pos.unrealizedUsd.toFixed(2)}`
          : ''
      return `• ${escapeHtml(pos.symbol)}: ${pos.qty} @ avg $${pos.avgEntryUsd.toFixed(2)}${pnl}`
    })
    .join('\n')
  return `${header}\n\n${rows}\n\nRealized P&L: $${p.realizedPnlUsd.toFixed(2)}`
}
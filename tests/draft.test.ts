import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDraftStream, type DraftSender } from '../src/telegram/draft.js'
import type { RunEvent } from '../src/types.js'

/** Sender stub with controllable edit failures and a full call log. */
function fakeSender(failEdits = 0): DraftSender & {
  sends: string[]
  edits: string[]
  failNextEdits: (n: number) => void
} {
  let nextId = 1
  let failing = failEdits
  const state = {
    sends: [] as string[],
    edits: [] as string[],
    failNextEdits: (n: number) => {
      failing = n
    },
  }
  const sender: DraftSender = {
    send: async (_chatId, text) => {
      state.sends.push(text)
      return nextId++
    },
    tryEdit: async (_chatId, _messageId, text) => {
      if (failing > 0) {
        failing -= 1
        return false
      }
      state.edits.push(text)
      return true
    },
  }
  return Object.assign(sender, state)
}

const started: RunEvent = { kind: 'run_started', runId: 'r1', agent: 'orchestrator', chatId: 7 }
const tool = (t: string, input: unknown = {}): RunEvent => ({
  kind: 'tool_call',
  runId: 'r1',
  tool: t,
  input,
})
const toolOk = (t: string): RunEvent => ({ kind: 'tool_result', runId: 'r1', tool: t, ok: true })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('progress draft', () => {
  it('first event sends ONE draft bubble containing agent + tool activity', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    d.onEvent(tool('market_technicals', { symbol: 'BTC' }))
    await vi.advanceTimersByTimeAsync(2_500)
    // The bubble is sent at run_started; the tool line arrives via the edit.
    expect(s.sends.length).toBe(1)
    expect(s.sends[0]).toContain('orchestrator')
    expect(s.edits.at(-1)).toContain('market_technicals')
  })

  it('edits are throttled — a burst of events yields few edits, not one per event', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    d.onEvent(tool('a'))
    d.onEvent(tool('b'))
    d.onEvent(tool('c'))
    await vi.advanceTimersByTimeAsync(2_500)
    // All events landed within one throttle window → the trailing timer makes
    // at most 1 edit for the whole burst (final compose collapses the lines).
    expect(s.edits.length).toBeLessThanOrEqual(1)
    expect(s.edits.length + s.sends.length).toBeGreaterThanOrEqual(2)
  })

  it('no change → no edit (dedupe), even across poll ticks', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    d.onEvent(tool('x'))
    await vi.advanceTimersByTimeAsync(2_500)
    const before = s.edits.length
    await vi.advanceTimersByTimeAsync(3_000) // three silent poll ticks
    expect(s.edits.length).toBe(before)
  })

  it('tool_result flips its ⚙️ line to ✅/❌ by tool name', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    d.onEvent(tool('kronos_forecast'))
    d.onEvent({ kind: 'tool_result', runId: 'r1', tool: 'kronos_forecast', ok: false })
    await vi.advanceTimersByTimeAsync(2_500)
    const last = s.edits.at(-1) ?? s.sends.at(-1)!
    expect(last).toContain('❌ kronos_forecast')
    expect(last).not.toContain('⚙️')
  })

  it('caps the draft at 8 lines and 120 chars per line', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    for (let i = 0; i < 12; i++) d.onEvent(tool(`tool_${i}`))
    await vi.advanceTimersByTimeAsync(2_500)
    const text = s.edits.at(-1) ?? s.sends.at(-1)!
    const rows = text.split('\n')
    expect(rows.length).toBeLessThanOrEqual(8)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(120)
  })

  it('shows a 🔒 line when approvals are pending', async () => {
    const s = fakeSender()
    let pending = 0
    const d = createDraftStream({ chatId: 7, sender: s, pendingApprovals: () => pending })
    d.onEvent(started)
    await vi.advanceTimersByTimeAsync(2_500)
    expect((s.edits.at(-1) ?? s.sends.at(-1)!).includes('approval')).toBe(false)
    pending = 2
    d.onEvent(tool('some_tool')) // any event (or poll tick) recomposes
    await vi.advanceTimersByTimeAsync(1_100)
    const text = s.edits.at(-1) ?? s.sends.at(-1)!
    expect(text).toContain('🔒 2 approvals pending')
  })

  it('input summaries are HTML-escaped at the transport boundary', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    d.onEvent(tool('journal_append', { text: '<script>x & y</script>' }))
    await vi.advanceTimersByTimeAsync(2_500)
    const text = s.edits.at(-1) ?? s.sends.at(-1)!
    expect(text).toContain('&lt;script&gt;')
    expect(text).not.toContain('<script>')
  })

  it('circuit: 3 consecutive failed edits stop editing; final goes fresh', async () => {
    const s = fakeSender()
    s.failNextEdits(99)
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    for (let i = 0; i < 6; i++) {
      d.onEvent(tool(`t${i}`))
      await vi.advanceTimersByTimeAsync(1_100)
    }
    expect(s.edits.length).toBe(0)
    await d.finalize('The desk has no opinion.', { replyToMessageId: 42, termination: 'FINAL' })
    // Final delivered as a FRESH message, not lost on the dead draft.
    expect(s.sends.filter((t) => t.includes('no opinion')).length).toBe(1)
  })

  it('finalize edits the draft into the rendered final answer (happy path)', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    d.onEvent(tool('market_technicals', { symbol: 'BTC' }))
    await vi.advanceTimersByTimeAsync(2_500)
    const sendsBefore = s.sends.length
    await d.finalize('**BTC is holding.**', { replyToMessageId: 9, termination: 'FINAL' })
    expect(s.edits.at(-1)).toContain('<b>')
    expect(s.sends.length).toBe(sendsBefore) // no duplicate message
  })

  it('aborted run settles the draft to ⏹ Stopped.', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    await vi.advanceTimersByTimeAsync(2_500)
    await d.finalize('partial thought', { termination: 'ABORTED' })
    expect(s.edits.at(-1)).toBe('⏹ Stopped.')
  })

  it('final answer longer than one Telegram page → draft points down, chunks sent fresh', async () => {
    const s = fakeSender()
    const d = createDraftStream({ chatId: 7, sender: s })
    d.onEvent(started)
    await vi.advanceTimersByTimeAsync(2_500)
    const long = 'x'.repeat(3_500) + '\n\n' + 'y'.repeat(3_500)
    await d.finalize(long, { termination: 'FINAL' })
    expect(s.sends.length).toBeGreaterThanOrEqual(2)
  })
})

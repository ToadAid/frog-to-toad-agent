import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTypingIndicator } from '../src/telegram/typing.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('typing indicator keepalive', () => {
  it('fires immediately, then on the interval, and stops cleanly', async () => {
    let calls = 0
    const t = createTypingIndicator({
      sendChatAction: async () => {
        calls += 1
      },
    })
    t.start(7)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(11_000) // two interval ticks (5s each)
    expect(calls).toBe(3)
    t.stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls).toBe(3)
  })

  it('TTL auto-stops a forgotten indicator', async () => {
    let calls = 0
    const t = createTypingIndicator({
      sendChatAction: async () => {
        calls += 1
      },
    })
    t.start(7)
    await vi.advanceTimersByTimeAsync(61_000)
    const capped = calls
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toBe(capped)
    expect(calls).toBeLessThanOrEqual(13) // immediate + ≤12 ticks inside 60s
  })

  it('a failing sendChatAction trips the failure budget and stops the loop', async () => {
    let calls = 0
    const t = createTypingIndicator({
      sendChatAction: async () => {
        calls += 1
        throw new Error('dead api')
      },
    })
    t.start(7)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toBe(2) // immediate + one tick → budget (2) tripped → stopped
  })

  it('restart replaces the previous loop instead of stacking two', async () => {
    let calls = 0
    const t = createTypingIndicator({
      sendChatAction: async () => {
        calls += 1
      },
    })
    t.start(7)
    await vi.advanceTimersByTimeAsync(5_000)
    t.start(7) // a second run in the same chat
    await vi.advanceTimersByTimeAsync(5_000)
    // 1 (first start) + 1 (first tick) + 1 (restart) + 1 (restart tick) = 4
    expect(calls).toBe(4)
  })
})
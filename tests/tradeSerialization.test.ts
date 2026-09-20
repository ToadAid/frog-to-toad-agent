import { describe, expect, it } from 'vitest'
import {
  TradeExecutionSerializer,
  tradeExecutionSerializer,
} from '../src/safety/tradeSerialization.js'
import { swapExecuteTool } from '../src/tools/swap.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('D1-P7 process-local trade serialization', () => {
  it('runs trade work FIFO and never overlaps holders', async () => {
    const serializer = new TradeExecutionSerializer()
    const entered = deferred()
    const releaseFirst = deferred()
    const events: string[] = []

    const first = serializer.run(new AbortController().signal, async () => {
      events.push('first-enter')
      entered.resolve()
      await releaseFirst.promise
      events.push('first-exit')
      return 'first'
    })

    await entered.promise

    const second = serializer.run(new AbortController().signal, async () => {
      events.push('second-enter')
      return 'second'
    })
    const third = serializer.run(new AbortController().signal, async () => {
      events.push('third-enter')
      return 'third'
    })

    await flush()
    expect(events).toEqual(['first-enter'])

    releaseFirst.resolve()
    expect(await first).toEqual({ ok: true, value: 'first' })
    expect(await second).toEqual({ ok: true, value: 'second' })
    expect(await third).toEqual({ ok: true, value: 'third' })
    expect(events).toEqual([
      'first-enter',
      'first-exit',
      'second-enter',
      'third-enter',
    ])
  })

  it('removes an aborted waiter without letting later work pass the current holder', async () => {
    const serializer = new TradeExecutionSerializer()
    const entered = deferred()
    const releaseFirst = deferred()
    const events: string[] = []

    const first = serializer.run(new AbortController().signal, async () => {
      events.push('first-enter')
      entered.resolve()
      await releaseFirst.promise
      events.push('first-exit')
      return 'first'
    })
    await entered.promise

    const waitingAbort = new AbortController()
    let abortedWorkCalled = false
    const second = serializer.run(waitingAbort.signal, async () => {
      abortedWorkCalled = true
      events.push('second-enter')
      return 'second'
    })
    const third = serializer.run(new AbortController().signal, async () => {
      events.push('third-enter')
      return 'third'
    })

    waitingAbort.abort()
    const secondResult = await second
    expect(secondResult).toMatchObject({
      ok: false,
      code: 'TRADE_EXECUTION_WAIT_ABORTED',
    })
    expect(abortedWorkCalled).toBe(false)

    await flush()
    expect(events).toEqual(['first-enter'])

    releaseFirst.resolve()
    await first
    expect(await third).toEqual({ ok: true, value: 'third' })
    expect(events).toEqual(['first-enter', 'first-exit', 'third-enter'])
  })

  it('releases the lane when execution throws', async () => {
    const serializer = new TradeExecutionSerializer()
    const first = serializer.run(new AbortController().signal, async () => {
      throw new Error('boom')
    })
    const second = serializer.run(new AbortController().signal, async () => 'after-error')

    await expect(first).rejects.toThrow('boom')
    expect(await second).toEqual({ ok: true, value: 'after-error' })
  })

  it('never invokes work for an already-aborted signal', async () => {
    const serializer = new TradeExecutionSerializer()
    const controller = new AbortController()
    controller.abort()

    let called = false
    const result = await serializer.run(controller.signal, async () => {
      called = true
      return 'impossible'
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'TRADE_EXECUTION_WAIT_ABORTED',
    })
    expect(called).toBe(false)
  })

  it('routes the canonical swap_execute body through the process-wide lane', async () => {
    const holdEntered = deferred()
    const releaseHold = deferred()
    const hold = tradeExecutionSerializer.run(
      new AbortController().signal,
      async () => {
        holdEntered.resolve()
        await releaseHold.promise
        return 'held'
      },
    )
    await holdEntered.promise

    let settled = false
    const call = swapExecuteTool.execute(
      {
        fromSymbol: 'NOT_A_MAJOR',
        toSymbol: 'ETH',
        fromAmount: 1,
        expectedToAmount: 1,
        estEntryPriceUsd: 1,
        estNotionalUsd: 1,
        rationale: 'serialization proof',
      },
      {
        signal: new AbortController().signal,
      } as never,
    )
    void call.finally(() => {
      settled = true
    })

    await flush()
    expect(settled).toBe(false)

    releaseHold.resolve()
    await hold
    const result = await call
    expect(result.text).toContain("fromSymbol 'NOT_A_MAJOR'")
  })

  it('returns a bounded refusal when swap_execute is aborted while waiting', async () => {
    const holdEntered = deferred()
    const releaseHold = deferred()
    const hold = tradeExecutionSerializer.run(
      new AbortController().signal,
      async () => {
        holdEntered.resolve()
        await releaseHold.promise
        return 'held'
      },
    )
    await holdEntered.promise

    const waiting = new AbortController()
    const call = swapExecuteTool.execute(
      {
        fromSymbol: 'NOT_A_MAJOR',
        toSymbol: 'ETH',
        fromAmount: 1,
        expectedToAmount: 1,
        estEntryPriceUsd: 1,
        estNotionalUsd: 1,
        rationale: 'abort proof',
      },
      { signal: waiting.signal } as never,
    )

    waiting.abort()
    const result = await call
    expect(result.text).toContain('TRADE_EXECUTION_WAIT_ABORTED')

    releaseHold.resolve()
    await hold
  })
})

export type TradeExecutionRunResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      code: 'TRADE_EXECUTION_WAIT_ABORTED'
      reason: string
    }

function waitAborted(): TradeExecutionRunResult<never> {
  return {
    ok: false,
    code: 'TRADE_EXECUTION_WAIT_ABORTED',
    reason: 'trade execution was aborted before acquiring the process-local execution slot',
  }
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)

  return new Promise<boolean>((resolve) => {
    let settled = false

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(false)

    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

/**
 * FIFO serialization for trade execution inside this Node.js process.
 *
 * This closes same-process interleaving between independently queued chats,
 * cron/admin runs, and autonomous dry-run execution. It is deliberately NOT a
 * filesystem lock, cross-process reservation, persistent lease, or stale-lock
 * recovery mechanism. Those are separate authority/durability boundaries.
 */
export class TradeExecutionSerializer {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<TradeExecutionRunResult<T>> {
    if (signal.aborted) return waitAborted()

    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })

    const previous = this.tail
    this.tail = previous.then(
      () => gate,
      () => gate,
    )

    const entered = await waitForTurn(previous, signal)
    if (!entered || signal.aborted) {
      // Resolving early removes an aborted waiter from the logical queue while
      // the chained tail still preserves the ordering of all earlier holders.
      releaseGate()
      return waitAborted()
    }

    try {
      return { ok: true, value: await work() }
    } finally {
      // Execution errors must never strand later trades behind this slot.
      releaseGate()
    }
  }
}

/**
 * One process-wide execution lane for the canonical swap_execute tool.
 * Quotes remain concurrent/read-only; only execution is serialized.
 */
export const tradeExecutionSerializer = new TradeExecutionSerializer()

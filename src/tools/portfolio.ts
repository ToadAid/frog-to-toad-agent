import { z } from 'zod'
import { defineTool } from './registry.js'
import { readPositions, readLedger, type LedgerEntry } from '../store/positions.js'
import type { Config } from '../config.js'
import { fmtLocalTs } from '../util/temporal.js'
import { readApprenticeshipTreasury } from '../safety/simulatedTreasury.js'

export const portfolioGetTool = defineTool({
  name: 'portfolio_get',
  description: 'Current open positions (symbol, qty, avg entry, realized P&L) from the desk ledger.',
  danger: 'readonly',
  input: z.object({}),
  execute: async (_input, ctx) => {
    const book = readPositions(ctx.cfg)
    const treasury = ctx.cfg.autonomousDryRun ? readApprenticeshipTreasury(ctx.cfg) : undefined
    const treasuryLine =
      treasury === undefined
        ? ''
        : treasury.ok
          ? `\nApprenticeship treasury: $${treasury.cashUsd.toFixed(2)} cash / $${treasury.seedUsd.toFixed(2)} seed`
          : `\n[guard] ${treasury.code}: ${treasury.reason}`

    if (book.positions.length === 0) {
      return {
        text: `No open positions. Realized P&L: $${book.realizedPnlUsd.toFixed(2)}${treasuryLine}`,
        data: treasury === undefined ? book : { ...book, apprenticeshipTreasury: treasury },
      }
    }
    const lines = book.positions.map(
      (p) =>
        `${p.symbol}: qty ${p.qty} @ avg $${p.avgEntryUsd.toFixed(2)} · cost basis $${(p.qty * p.avgEntryUsd).toFixed(2)}`,
    )
    return {
      text: `Open positions:\n${lines.join('\n')}\nRealized P&L: $${book.realizedPnlUsd.toFixed(2)}${treasuryLine}`,
      data: treasury === undefined ? book : { ...book, apprenticeshipTreasury: treasury },
    }
  },
})

export const portfolioHistoryTool = defineTool({
  name: 'portfolio_history',
  description: 'Recent ledger events (opens/closes/closes simulated), newest last.',
  danger: 'readonly',
  input: z.object({
    limit: z.number().int().positive().max(50).default(10),
  }),
  execute: async (input, ctx) => {
    const entries = readLedgerTail(ctx.cfg, input.limit)
    if (entries.length === 0) return { text: 'Ledger is empty.' }
    const lines = entries.map(
      (e) =>
        `${fmtLocalTs(ctx.cfg.timezone, e.ts)} ${e.type.toUpperCase()} ${e.symbol ?? ''} qty=${e.qty ?? '-'} @ $${e.entryUsd ?? e.exitUsd ?? '-'}${e.dryRun ? ' [SIM]' : ' [LIVE]'}`,
    )
    return { text: lines.join('\n') }
  },
})

function readLedgerTail(cfg: Config, limit: number): LedgerEntry[] {
  return readLedger(cfg).slice(-limit)
}
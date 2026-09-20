import { z } from 'zod'
import { defineTool } from './registry.js'
import {
  appendLedgerBatch,
  checkCloseProvenance,
  type LedgerEntry,
} from '../store/positions.js'
import { guard } from '../safety/guard.js'
import type { TradeCardData } from '../telegram/render.js'
import { isMajor, shortAddress, tokenByAddress } from './tokens.js'
import { getUsdPrice } from '../market/feeds.js'
import { oracleSanityCheck } from '../market/oracleSanity.js'
import { mcpExecuteSwap, mcpReadTokenBalance, BASE_TOKENS } from '../mcp/bridge.js'
import { actualFillQty } from '../safety/reconcile.js'
import { checkBalance, checkMinNotional, checkPrecision } from '../safety/precision.js'
import { checkApprenticeshipSpend } from '../safety/simulatedTreasury.js'
import { isStable } from '../safety/deskState.js'
import { tradeExecutionSerializer } from '../safety/tradeSerialization.js'
import {
  haltForLiveExecutionAmbiguity,
  markLiveExecutionAccounted,
  markLiveExecutionAmbiguous,
  prepareLiveExecution,
} from '../safety/liveExecutionJournal.js'

/**
 * Swap tools.
 *  - swap_quote:   fetches live prices, sanity-checks them against the
 *                  Chainlink aggregator (majors), estimates output; executes nothing
 *  - swap_execute: requires Telegram approval (guarded). Backend:
 *                    'dry-run' — records a SIMULATED ledger entry (default)
 *                    'mcp'     — calls the external CDP wallet server
 *                  Only dry-run exists in dry-run mode; the signer lives in
 *                  the external MCP server process, never in this codebase.
 *
 * Token identity is ADDRESS-FIRST: majors may be quoted by symbol alone, but
 * anything else REQUIRES its contract address (enforced here in code, not by
 * prompt) so a lookalike ticker can never be traded by accident.
 */

const tokenRefInput = {
  fromSymbol: z.string().describe('token to sell, e.g. USDC'),
  toSymbol: z.string().describe('ticker of the token to buy, e.g. ETH'),
  fromTokenAddress: z
    .string()
    .optional()
    .describe('contract address of the sell token (required if it is not a major)'),
  toTokenAddress: z
    .string()
    .optional()
    .describe('contract address of the buy token — REQUIRED unless toSymbol is a major (BTC/ETH/SOL/stables/…)'),
}

/** Enforced in code: non-majors must trade by contract address. */
function requireAddressIfNotMajor(side: 'from' | 'to', symbol: string, address: string | undefined): string | undefined {
  if (isMajor(symbol)) return undefined
  if (address && address.startsWith('0x')) return undefined
  return (
    `[error] ${side === 'to' ? 'toSymbol' : 'fromSymbol'} '${symbol}' is not a desk major — ` +
    `refuse to guess. Resolve it first with market_token_search and retry with its ` +
    `${side === 'to' ? 'toTokenAddress' : 'fromTokenAddress'} (contract address). Ticker alone is never an asset.`
  )
}

export const swapQuoteTool = defineTool({
  name: 'swap_quote',
  description:
    'Quote a token swap: fetches live reference prices and estimates output amount and impact. ' +
    'Executes nothing. Always quote before proposing a trade. Non-major tokens need their contract address.',
  danger: 'readonly',
  input: z.object({
    ...tokenRefInput,
    fromAmount: z.number().positive().describe('amount of fromSymbol to sell'),
  }),
  execute: async (input, _ctx) => {
    const needFrom = requireAddressIfNotMajor('from', input.fromSymbol, input.fromTokenAddress)
    if (needFrom) return { text: needFrom }
    const needTo = requireAddressIfNotMajor('to', input.toSymbol, input.toTokenAddress)
    if (needTo) return { text: needTo }

    const fromPrice = await referencePrice(input.fromSymbol, input.fromTokenAddress)
    const toPrice = await referencePrice(input.toSymbol, input.toTokenAddress)
    if (fromPrice === undefined || toPrice === undefined) {
      return {
        text:
          `[error] cannot quote: no reference price for ` +
          `${fromPrice === undefined ? input.fromSymbol : input.toSymbol}. ` +
          `For long-tail tokens use market_token_search first (needs a liquid pair).`,
      }
    }

    const notional = input.fromAmount * fromPrice
    const g = guard(_ctx.cfg)
    const check = g.precheckTrade({
      from: input.fromSymbol,
      fromAddress: input.fromTokenAddress,
      fromQty: input.fromAmount,
      to: input.toSymbol,
      toAddress: input.toTokenAddress,
      notionalUsd: notional,
    })
    if (!check.ok) return { text: `[guard] ${check.reason}` }

    // Instrument discipline (Nautilus steal): precision + dust floor BEFORE a
    // card can go out, and — on the live lane — can the wallet fund it at all?
    const precision = checkPrecision(input.fromSymbol, input.fromAmount)
    if (!precision.ok) return { text: `[guard] ${precision.reason}` }

    let apprenticeshipCashNote = ''
    if (_ctx.cfg.autonomousDryRun && _ctx.cfg.dryRun && isStable(input.fromSymbol)) {
      const treasuryCheck = checkApprenticeshipSpend(_ctx.cfg, {
        fromSymbol: input.fromSymbol,
        notionalUsd: notional,
      })
      if (!treasuryCheck.ok) {
        return { text: `[guard] ${treasuryCheck.code}: ${treasuryCheck.reason}` }
      }
      apprenticeshipCashNote =
        ` Apprenticeship cash before trade: $${treasuryCheck.treasury.cashUsd.toFixed(2)}.`
    }

    const dust = checkMinNotional(notional)
    if (!dust.ok) return { text: `[guard] ${dust.reason}` }
    const fromAddress = input.fromTokenAddress ?? BASE_TOKENS[input.fromSymbol.toUpperCase()]
    let walletNote = ''
    if (!_ctx.cfg.dryRun && fromAddress) {
      const balance = await mcpReadTokenBalance(_ctx.cfg, fromAddress)
      const funded = checkBalance(balance, notional, input.fromSymbol.toUpperCase())
      if (!funded.ok) return { text: `[guard] ${funded.reason}` }
      if (balance !== undefined) {
        walletNote = ` Wallet holds ${balance} ${input.fromSymbol.toUpperCase()}.`
      }
    }

    // Oracle sanity (majors): refuse to quote if the web price disagrees
    // with the Chainlink aggregator — divergence means broken or manipulated.
    const sanity = await oracleSanityCheck(input.toSymbol, toPrice)
    if (!sanity.ok) return { text: `[guard] ${sanity.reason}` }

    const estOut = (notional * (1 - estImpact(notional) / 100)) / toPrice
    const toLabel = input.toTokenAddress
      ? `${input.toSymbol.toUpperCase()} on ${shortAddress(input.toTokenAddress)}`
      : input.toSymbol.toUpperCase()
    const card: TradeCardData = {
      simulated: true,
      fromToken: input.fromSymbol.toUpperCase(),
      toToken: toLabel,
      toTokenAddress: input.toTokenAddress,
      fromAmount: String(input.fromAmount),
      toAmount: estOut.toFixed(6),
      priceImpactPct: estImpact(notional),
      notes: `Reference prices: ${input.fromSymbol.toUpperCase()}=$${fmtPrice(fromPrice)}, ${input.toSymbol.toUpperCase()}=$${fmtPrice(toPrice)}.${walletNote}${apprenticeshipCashNote} Rough estimate — verify with pair data for illiquid tokens.`,
    }
    return {
      text:
        `QUOTE (simulated): ${input.fromAmount} ${input.fromSymbol.toUpperCase()} → ~${estOut.toFixed(6)} ${toLabel}\n` +
        `Notional: $${notional.toFixed(2)} · est. impact: ${estImpact(notional)}% (placeholder model)${walletNote}`,
      data: card,
    }
  },
})

export const swapExecuteTool = defineTool({
  name: 'swap_execute',
  description:
    'EXECUTE a swap. Requires explicit human approval via Telegram (auto-DENIED on timeout). ' +
    'Currently DRY-RUN: records a simulated trade in the ledger and moves no funds. ' +
    'Non-major tokens require their contract address.',
  danger: 'trade',
  input: z.object({
    ...tokenRefInput,
    fromAmount: z.number().positive(),
    expectedToAmount: z.number().positive().describe('output amount from swap_quote'),
    estEntryPriceUsd: z.number().positive().describe('estimated USD price of toSymbol from the quote'),
    estNotionalUsd: z.number().positive().describe('estimated USD value of the trade from the quote'),
    slippageBps: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe('max acceptable slippage in basis points (default 100 = 1%) — used by the wallet server'),
    rationale: z.string().describe('one-line reason for this trade'),
  }),
  execute: async (input, ctx) => {
    const serialized = await tradeExecutionSerializer.run(ctx.signal, async () => {
    const needFrom = requireAddressIfNotMajor('from', input.fromSymbol, input.fromTokenAddress)
    if (needFrom) return { text: needFrom }
    const needTo = requireAddressIfNotMajor('to', input.toSymbol, input.toTokenAddress)
    if (needTo) return { text: needTo }

    let executionNotionalUsd = input.estNotionalUsd
    if (ctx.cfg.dryRun && ctx.cfg.autonomousDryRun) {
      if (!isStable(input.fromSymbol)) {
        return {
          text:
            `[guard] APPRENTICESHIP_ENTRY_REQUIRES_STABLE: A1 autonomous apprenticeship entries ` +
            `must spend from a stable treasury; ${input.fromSymbol.toUpperCase()} is not a stable source`,
        }
      }

      // A1 monetary conservation: never let the model self-report how much cash
      // it spent. Re-price the SOURCE amount at execution time and use that
      // derived USD value for every cash/risk check and the canonical ledger.
      const fromRef = await referencePrice(input.fromSymbol, input.fromTokenAddress)
      if (fromRef === undefined || !Number.isFinite(fromRef) || fromRef <= 0) {
        return {
          text:
            `[guard] APPRENTICESHIP_SOURCE_PRICE_UNAVAILABLE: cannot derive authoritative USD debit ` +
            `for ${input.fromSymbol.toUpperCase()} at execution time`,
        }
      }
      executionNotionalUsd = input.fromAmount * fromRef
      if (!Number.isFinite(executionNotionalUsd) || executionNotionalUsd <= 0) {
        return {
          text:
            `[guard] APPRENTICESHIP_INVALID_NOTIONAL: derived execution notional is not a positive finite USD amount`,
        }
      }
    }

    // A source close needs current market truth of its own. Never book
    // realized P&L from the model-carried estNotionalUsd.
    let sourceExitUsd: number | undefined
    if (!isStable(input.fromSymbol)) {
      sourceExitUsd = await referencePrice(input.fromSymbol, input.fromTokenAddress)
      if (
        sourceExitUsd === undefined ||
        !Number.isFinite(sourceExitUsd) ||
        sourceExitUsd <= 0
      ) {
        return {
          text:
            `[guard] SOURCE_EXIT_PRICE_UNAVAILABLE: cannot book a canonical close for ` +
            `${input.fromSymbol.toUpperCase()} without a fresh source reference price`,
        }
      }
    }

    const g = guard(ctx.cfg)
    const check = g.precheckTrade({
      from: input.fromSymbol,
      fromAddress: input.fromTokenAddress,
      fromQty: input.fromAmount,
      to: input.toSymbol,
      toAddress: input.toTokenAddress,
      notionalUsd: executionNotionalUsd,
    })
    if (!check.ok) return { text: `[guard] trade rejected: ${check.reason}` }

    // Same instrument discipline as the quote — re-checked at execution time.
    const precision = checkPrecision(input.fromSymbol, input.fromAmount)
    if (!precision.ok) return { text: `[guard] ${precision.reason}` }
    const dust = checkMinNotional(executionNotionalUsd)
    if (!dust.ok) return { text: `[guard] ${dust.reason}` }
    const fromAddress = input.fromTokenAddress ?? BASE_TOKENS[input.fromSymbol.toUpperCase()]
    if (!ctx.cfg.dryRun && fromAddress) {
      const balance = await mcpReadTokenBalance(ctx.cfg, fromAddress)
      const funded = checkBalance(balance, executionNotionalUsd, input.fromSymbol.toUpperCase())
      if (!funded.ok) return { text: `[guard] ${funded.reason}` }
    }

    // Oracle sanity (majors): cross-check the web price against the Chainlink
    // aggregator before anything is recorded or executed.
    const toRef = await referencePrice(input.toSymbol, input.toTokenAddress)
    if (toRef !== undefined) {
      const sanity = await oracleSanityCheck(input.toSymbol, toRef)
      if (!sanity.ok) return { text: `[guard] ${sanity.reason}` }
    }

    let executionQty = input.expectedToAmount
    let executionEntryUsd = input.estEntryPriceUsd
    if (ctx.cfg.dryRun && ctx.cfg.autonomousDryRun) {
      if (toRef === undefined || !Number.isFinite(toRef) || toRef <= 0) {
        return {
          text:
            `[guard] APPRENTICESHIP_DESTINATION_PRICE_UNAVAILABLE: cannot derive simulated fill ` +
            `for ${input.toSymbol.toUpperCase()} at execution time`,
        }
      }

      // A1 asset conservation: never let the model self-report how many units
      // it received. Re-use the inherited placeholder impact model, but derive
      // the fill from authoritative debit + fresh destination reference price.
      const impactFactor = 1 - estImpact(executionNotionalUsd) / 100
      executionQty = (executionNotionalUsd * impactFactor) / toRef
      if (!Number.isFinite(executionQty) || executionQty <= 0) {
        return {
          text:
            `[guard] APPRENTICESHIP_INVALID_FILL: derived simulated output quantity is not positive and finite`,
        }
      }

      // Effective entry makes qty × entry reconcile exactly to the cash debit.
      // This books the placeholder impact as immediate execution cost rather
      // than letting simulated assets appear from nowhere.
      executionEntryUsd = executionNotionalUsd / executionQty
    }

    let apprenticeshipCashAfterUsd: number | undefined
    if (ctx.cfg.dryRun && ctx.cfg.autonomousDryRun) {
      // Final A1 check happens AFTER all async oracle work and IMMEDIATELY
      // before the synchronous append below. No second balance file exists.
      const treasuryCheck = checkApprenticeshipSpend(ctx.cfg, {
        fromSymbol: input.fromSymbol,
        notionalUsd: executionNotionalUsd,
      })
      if (!treasuryCheck.ok) {
        return { text: `[guard] ${treasuryCheck.code}: ${treasuryCheck.reason}` }
      }
      apprenticeshipCashAfterUsd = treasuryCheck.treasury.cashUsd - executionNotionalUsd
    }

    // Backend flag: dry-run simulates; 'mcp' routes to the external wallet
    // server (unreachable in dry-run mode — boot refuses that combination).
    if (ctx.cfg.dryRun) {
      // D1-P5 is re-checked at the last local boundary after all async pricing
      // work. The outer D1-P7 serializer keeps other swap_execute calls in this
      // process out of this proof-to-append window; no cross-process reservation
      // is claimed.
      if (!isStable(input.fromSymbol)) {
        const finalSourceProof = checkCloseProvenance(ctx.cfg, {
          symbol: input.fromSymbol,
          tokenAddress: input.fromTokenAddress,
          qty: input.fromAmount,
          dryRun: true,
        })
        if (!finalSourceProof.ok) {
          return {
            text: `[guard] trade rejected before ledger append: ${finalSourceProof.code}: ${finalSourceProof.reason}`,
          }
        }
      }

      const entries = buildSwapLedgerEntries(input, {
        receivedQty: executionQty,
        destinationEntryUsd: executionEntryUsd,
        sourceExitUsd,
        dryRun: true,
        runId: ctx.runId,
        apprenticeshipNotionalUsd: ctx.cfg.autonomousDryRun
          ? executionNotionalUsd
          : undefined,
      })
      appendLedgerBatch(ctx.cfg, entries)
      return {
        text:
          `🧪 SIMULATED EXECUTION: sold ${input.fromAmount} ${input.fromSymbol.toUpperCase()} → ` +
          `~${executionQty} ${input.toSymbol.toUpperCase()}` +
          `${input.toTokenAddress ? ` (contract ${shortAddress(input.toTokenAddress)})` : ''} ` +
          `(effective entry $${executionEntryUsd}). ` +
          `Ledger accounting written in one append (dryRun=true). No funds were moved — the desk is in dry-run mode.` +
          (apprenticeshipCashAfterUsd === undefined
            ? ''
            : ` Apprenticeship cash remaining: $${Math.max(0, apprenticeshipCashAfterUsd).toFixed(2)}.`),
      }
    }

    // LIVE path (real mode only): the external MCP wallet server signs.
    // The ledger records the ACTUAL fill, not the estimate: balance of the buy
    // token read before AND after the swap → delta is what really landed
    // (Nautilus execution-report honesty; born from the estimate-vs-actual
    // drift on the first real fill). Ladder: balance delta > server quote >
    // our estimate — the entry always says which evidence it used.
    const toAddress = input.toTokenAddress ?? BASE_TOKENS[input.toSymbol.toUpperCase()]
    const preBalance = toAddress ? await mcpReadTokenBalance(ctx.cfg, toAddress) : undefined

    // Last safe source-ownership check before the external wallet can move
    // funds. The outer D1-P7 serializer prevents another swap_execute in this
    // process from interleaving here. This is still not a cross-process lock or
    // a blockchain-plus-disk atomicity guarantee.
    if (!isStable(input.fromSymbol)) {
      const finalSourceProof = checkCloseProvenance(ctx.cfg, {
        symbol: input.fromSymbol,
        tokenAddress: input.fromTokenAddress,
        qty: input.fromAmount,
        dryRun: false,
      })
      if (!finalSourceProof.ok) {
        return {
          text: `[guard] trade rejected before wallet execution: ${finalSourceProof.code}: ${finalSourceProof.reason}`,
        }
      }
    }

    // D1-P8 durable ambiguity boundary: persist PREPARED before the external
    // wallet call. If the process dies after this point and before ACCOUNTED,
    // the next boot HALTs rather than guessing whether funds moved.
    let liveExecutionId: string
    try {
      liveExecutionId = prepareLiveExecution(ctx.cfg, {
        runId: ctx.runId,
        fromSymbol: input.fromSymbol,
        fromTokenAddress: input.fromTokenAddress,
        toSymbol: input.toSymbol,
        toTokenAddress: input.toTokenAddress,
        fromAmount: input.fromAmount,
      }).executionId
    } catch (err) {
      return {
        text:
          `[guard] LIVE_EXECUTION_JOURNAL_UNAVAILABLE: refusing wallet execution because ` +
          `the durable prepared receipt could not be written: ${
            err instanceof Error ? err.message : String(err)
          }`,
      }
    }

    let res: Awaited<ReturnType<typeof mcpExecuteSwap>>
    try {
      res = await mcpExecuteSwap(ctx.cfg, input)
    } catch (err) {
      const reason =
        `wallet call threw after durable PREPARED receipt: ` +
        (err instanceof Error ? err.message : String(err))
      try {
        markLiveExecutionAmbiguous(ctx.cfg, liveExecutionId, reason)
      } catch {
        // The PREPARED receipt is already durable; boot-time classification
        // still sees this execution as unresolved even if this annotation fails.
      }
      haltForLiveExecutionAmbiguity(ctx.cfg, reason)
      return { text: `[guard] LIVE_EXECUTION_AMBIGUOUS: ${reason}; desk HALTED` }
    }

    if (!res.ok) {
      // A remote failure after submission cannot be upgraded to "nothing
      // happened" without stronger wallet-server evidence. Retain ambiguity.
      const reason = `wallet server returned failure after durable PREPARED receipt: ${res.error}`
      try {
        markLiveExecutionAmbiguous(ctx.cfg, liveExecutionId, reason)
      } catch {
        // PREPARED remains authoritative and unresolved.
      }
      haltForLiveExecutionAmbiguity(ctx.cfg, reason)
      return { text: `[guard] LIVE_EXECUTION_AMBIGUOUS: ${reason}; desk HALTED` }
    }

    const txHash = res.parsed?.transactionHash

    try {
      const postBalance = toAddress ? await mcpReadTokenBalance(ctx.cfg, toAddress) : undefined
      const { qty, qtySource } = actualFillQty(
        preBalance,
        postBalance,
        res.parsed?.toAmount !== undefined ? Number(res.parsed.toAmount) : undefined,
        input.expectedToAmount,
      )
      const entries = buildSwapLedgerEntries(input, {
        receivedQty: qty,
        destinationEntryUsd: executionEntryUsd,
        sourceExitUsd,
        dryRun: false,
        runId: ctx.runId,
        receipt: {
          qtySource,
          minQty: res.parsed?.minToAmount !== undefined ? Number(res.parsed.minToAmount) : undefined,
          txHash,
          approvalTxHash: res.parsed?.approvalTxHash,
        },
      })
      appendLedgerBatch(ctx.cfg, entries)

      try {
        markLiveExecutionAccounted(ctx.cfg, liveExecutionId, txHash)
      } catch (err) {
        const reason =
          `wallet and ledger accounting completed but ACCOUNTED receipt failed: ` +
          (err instanceof Error ? err.message : String(err))
        haltForLiveExecutionAmbiguity(ctx.cfg, reason)
        return {
          text:
            `[guard] LIVE_EXECUTION_ACCOUNTING_RECEIPT_FAILED: ${reason}; ` +
            `desk HALTED and the durable PREPARED receipt remains unresolved`,
        }
      }

      return {
        text:
          `⚡ LIVE EXECUTION via wallet server: sold ${input.fromAmount} ${input.fromSymbol.toUpperCase()} → ` +
          `${qty} ${input.toSymbol.toUpperCase()} (${qtySource})` +
          `${input.toTokenAddress ? ` (contract ${shortAddress(input.toTokenAddress)})` : ''} ` +
          `(entry est. $${input.estEntryPriceUsd}). Ledger accounting written in one append (dryRun=false).\n` +
          (txHash ? `Tx: ${txHash}\n` : '') +
          `Server response: ${res.text}`,
      }
    } catch (err) {
      const reason =
        `wallet reported success but local accounting did not complete: ` +
        (err instanceof Error ? err.message : String(err))
      try {
        markLiveExecutionAmbiguous(ctx.cfg, liveExecutionId, reason, txHash)
      } catch {
        // PREPARED remains durable and unresolved.
      }
      haltForLiveExecutionAmbiguity(ctx.cfg, reason)
      return {
        text:
          `[guard] LIVE_EXECUTION_AMBIGUOUS: ${reason}; desk HALTED. ` +
          `Do not retry until wallet/ledger reconciliation resolves execution ${liveExecutionId}`,
      }
    }
    })
    if (!serialized.ok) {
      return { text: `[guard] ${serialized.code}: ${serialized.reason}` }
    }
    return serialized.value
  },
})


type SwapLedgerReceipt = Pick<
  LedgerEntry,
  'qtySource' | 'minQty' | 'txHash' | 'approvalTxHash'
>

export function buildSwapLedgerEntries(
  input: {
    fromSymbol: string
    fromTokenAddress?: string
    toSymbol: string
    toTokenAddress?: string
    fromAmount: number
    rationale: string
  },
  facts: {
    receivedQty: number
    destinationEntryUsd: number
    sourceExitUsd?: number
    dryRun: boolean
    runId?: string
    apprenticeshipNotionalUsd?: number
    receipt?: Partial<SwapLedgerReceipt>
  },
): LedgerEntry[] {
  const ts = Date.now()
  const common = {
    ts,
    dryRun: facts.dryRun,
    runId: facts.runId,
    rationale: input.rationale,
  }
  const entries: LedgerEntry[] = []
  const receipt = facts.receipt ?? {}

  if (!isStable(input.fromSymbol)) {
    if (
      facts.sourceExitUsd === undefined ||
      !Number.isFinite(facts.sourceExitUsd) ||
      facts.sourceExitUsd <= 0
    ) {
      throw new Error('SOURCE_EXIT_PRICE_REQUIRED')
    }
    if (facts.apprenticeshipNotionalUsd !== undefined) {
      throw new Error('APPRENTICESHIP_NON_STABLE_CLOSE_NOT_AUTHORIZED')
    }

    entries.push({
      ...common,
      type: 'close',
      symbol: input.fromSymbol.toUpperCase(),
      tokenAddress: input.fromTokenAddress,
      qty: input.fromAmount,
      exitUsd: facts.sourceExitUsd,
      txHash: receipt.txHash,
      approvalTxHash: receipt.approvalTxHash,
    })
  }

  // Preserve the Frog's existing destination-open semantics exactly. D1-P6
  // adds the source close and batches the related legs; it does not redefine
  // stable-position representation.
  entries.push({
    ...common,
    type: 'open',
    symbol: input.toSymbol.toUpperCase(),
    tokenAddress: input.toTokenAddress,
    qty: facts.receivedQty,
    entryUsd: facts.destinationEntryUsd,
    qtySource: receipt.qtySource,
    minQty: receipt.minQty,
    txHash: receipt.txHash,
    approvalTxHash: receipt.approvalTxHash,
    ...(facts.apprenticeshipNotionalUsd === undefined
      ? {}
      : {
          capitalPool: 'apprenticeship' as const,
          notionalUsd: facts.apprenticeshipNotionalUsd,
        }),
  })

  return entries
}

function fmtPrice(p: number): string {
  return p < 0.01 ? p.toPrecision(3) : p.toLocaleString()
}

/**
 * Reference price: majors from the redundant feed chain (CoinGecko → Binance →
 * Coinbase); contract tokens from the best DexScreener pair (address-exact).
 */
async function referencePrice(symbol: string, address: string | undefined): Promise<number | undefined> {
  if (isMajor(symbol)) {
    return (await getUsdPrice(symbol))?.usd
  }
  if (!address) return undefined
  const t = await tokenByAddress(address)
  return t?.priceUsd ?? undefined
}

function estImpact(notional: number): number {
  return notional > 25_000 ? 1.0 : notional > 2_500 ? 0.3 : 0.1
}
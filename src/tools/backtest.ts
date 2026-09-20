import { z } from 'zod'
import { defineTool } from './registry.js'
import type { Candle } from '../market/ta.js'
import { binanceCandles, coinbaseCandles } from './technicals.js'
import {
  backtest,
  formatBacktestReport,
  strategyLabel,
  validateStrategy,
  type StrategySpec,
} from '../backtest/engine.js'
import { isContractAddress } from './tokens.js'

/**
 * backtest_strategy — run a BUILT-IN strategy over historical OHLCV and get
 * returns/alpha/trades. Readonly simulation: nothing touches the ledger,
 * nothing signs. The standing gates (graded live signals) are NOT waived by
 * a nice-looking backtest — the report says so.
 */

const MAX_CANDLES = 1000

type CandleSource = (symbol: string, interval: 'hourly' | 'daily', limit: number) => Promise<Candle[]>

async function candlesDefault(symbol: string, interval: 'hourly' | 'daily', limit: number): Promise<Candle[]> {
  try {
    const c = await binanceCandles(symbol, interval, limit)
    if (c.length > 0) return c
  } catch {
    /* fall through */
  }
  return coinbaseCandles(symbol, interval)
}

let candleSource: CandleSource = candlesDefault

/** Test seam — swap the history fetcher for a scripted fake. */
export function setBacktestCandleSource(fn: CandleSource | undefined): void {
  candleSource = fn ?? candlesDefault
}

const strategySchema = z
  .object({
    kind: z.enum(['sma_cross', 'rsi_reversion', 'breakout', 'momentum']),
    fast: z.number().optional(),
    slow: z.number().optional(),
    period: z.number().optional(),
    oversold: z.number().optional(),
    exitLevel: z.number().optional(),
    lookback: z.number().optional(),
    exitLookback: z.number().optional(),
    thresholdPct: z.number().optional(),
  })
  .describe(
    'which built-in strategy + params: sma_cross{fast,slow} · rsi_reversion{period,oversold,exitLevel} · ' +
      'breakout{lookback,exitLookback} · momentum{lookback,thresholdPct}. Unset params use defaults.',
  )

export const backtestStrategyTool = defineTool({
  name: 'backtest_strategy',
  description:
    'Backtest a built-in strategy (long/flat, next-open fills, fees+slippage) against historical candles ' +
    'for a MAJOR (BTC, ETH, SOL, … — contract addresses are refused; no DEX history depth). ' +
    'Returns total return vs buy&hold (alpha), win rate, profit factor, expectancy, max drawdown, sample trades. ' +
    'Use it BEFORE proposing any rule as a live signal — and remember one window is a look, not proof: ' +
    'test on multiple windows before believing a rule. Simulation only — never touches the ledger.',
  danger: 'readonly',
  input: z.object({
    symbol: z.string().describe('major ticker, e.g. "BTC" or "ETH"'),
    interval: z.enum(['hourly', 'daily']).optional().describe('candle size (default daily — more history)'),
    limit: z.number().int().min(50).max(MAX_CANDLES).optional().describe('history length, 50–1000 candles (default 500)'),
    strategy: strategySchema,
    feeBps: z.number().optional().describe('fee per side in bps (default 10)'),
    slippageBps: z.number().optional().describe('slippage per side in bps (default 10)'),
  }),
  execute: async (input) => {
    if (isContractAddress(input.symbol)) {
      return {
        text: '[error] backtest_strategy speaks exchange majors only (BTC, ETH, …) — contract addresses / DEX candles are out of scope',
      }
    }
    const symbol = input.symbol.toUpperCase().replace(/-?USD[T]?$/, '')
    const interval = input.interval ?? 'daily'
    const limit = input.limit ?? 500

    const spec: StrategySpec = { ...input.strategy } as StrategySpec
    const invalid = validateStrategy(spec)
    if (invalid) return { text: `[error] invalid strategy: ${invalid}` }

    let candles: Candle[]
    try {
      candles = await candleSource(symbol, interval, limit)
    } catch (err) {
      return { text: `[error] could not load ${symbol} ${interval} candles: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (candles.length < 30) {
      return { text: `[error] only ${candles.length} ${symbol} ${interval} candles available — not enough history to backtest` }
    }

    let result
    try {
      result = backtest({ symbol, interval, candles, strategy: spec, feeBps: input.feeBps, slippageBps: input.slippageBps })
    } catch (err) {
      return { text: `[error] backtest failed: ${err instanceof Error ? err.message : String(err)} (strategy was ${strategyLabel(spec)})` }
    }
    return { text: formatBacktestReport(result) }
  },
})
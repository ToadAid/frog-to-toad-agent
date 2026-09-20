import type { GuardCheck } from './guard.js'

/**
 * Instrument discipline (NautilusTrader `Instrument` steal): every tradable
 * carries its own precision and a minimum sane size — an order that wants
 * 9 decimals of USDC or trades dust notional gets refused BEFORE an approval
 * card can go out, not die onchain after the principal approved.
 *
 * Desk-sized: only the decimals map for tokens we can resolve by ticker
 * (anything else trades by contract address and gets the generic checks).
 */

export const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  WETH: 18,
  CBBTC: 8,
  DAI: 18,
}

/** Dust floor: below this notional the fixed costs dominate and the fill lies. */
export const MIN_NOTIONAL_USD = 1

/** More decimals than the token supports → the amount would be truncated onchain. */
export function checkPrecision(symbol: string, amount: number): GuardCheck {
  const decimals = TOKEN_DECIMALS[symbol.toUpperCase()]
  if (decimals === undefined) return { ok: true } // unknown instrument: generic checks only
  if (!Number.isFinite(amount)) return { ok: false, reason: `amount for ${symbol} is not a finite number`, code: 'PRECISION_EXCEEDED' }
  const scaled = amount * 10 ** decimals
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return {
      ok: false,
      reason: `${symbol} carries ${decimals} decimals — an amount with more precision (${amount}) would be silently truncated onchain; round it`,
      code: 'PRECISION_EXCEEDED',
    }
  }
  return { ok: true }
}

export function checkMinNotional(notionalUsd: number): GuardCheck {
  if (notionalUsd < MIN_NOTIONAL_USD) {
    return {
      ok: false,
      reason: `notional $${notionalUsd.toFixed(4)} is dust — desk minimum is $${MIN_NOTIONAL_USD} (fixed costs dominate below it)`,
      code: 'INVALID_NOTIONAL',
    }
  }
  return { ok: true }
}

/** Balance gate for the quote path: can the wallet actually fund this? */
export function checkBalance(balance: number | undefined, notionalUsd: number, symbol: string): GuardCheck {
  if (balance === undefined) return { ok: true } // inconclusive is NOT zero — the balance lane may just be unreadable
  if (balance + 1e-9 < notionalUsd) {
    return {
      ok: false,
      reason: `wallet holds ${balance} ${symbol} but this trade wants $${notionalUsd.toFixed(2)} — INSUFFICIENT_BALANCE; fund the wallet or shrink the trade`,
      code: 'INSUFFICIENT_BALANCE',
    }
  }
  return { ok: true }
}
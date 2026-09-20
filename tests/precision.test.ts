import { describe, it, expect } from 'vitest'
import { checkBalance, checkMinNotional, checkPrecision, MIN_NOTIONAL_USD, TOKEN_DECIMALS } from '../src/safety/precision.js'

describe('instrument precision registry (Nautilus Instrument steal)', () => {
  it('known tokens carry their real decimals', () => {
    expect(TOKEN_DECIMALS['USDC']).toBe(6)
    expect(TOKEN_DECIMALS['WETH']).toBe(18)
    expect(TOKEN_DECIMALS['CBBTC']).toBe(8)
  })

  it('amounts with more precision than the token refuses', () => {
    expect(checkPrecision('USDC', 1.5)).toMatchObject({ ok: true })
    expect(checkPrecision('USDC', 0.0000001)).toMatchObject({ ok: false, code: 'PRECISION_EXCEEDED' })
    expect(checkPrecision('CBBTC', 0.00000001)).toMatchObject({ ok: true }) // 8 decimals exactly
    expect(checkPrecision('CBBTC', 0.000000001)).toMatchObject({ ok: false })
  })

  it('unknown instruments get generic checks only — never guessed decimals', () => {
    expect(checkPrecision('TOBY', 0.000123456789)).toMatchObject({ ok: true })
  })

  it('non-finite amounts refuse', () => {
    expect(checkPrecision('WETH', Number.NaN)).toMatchObject({ ok: false })
    expect(checkPrecision('WETH', Number.POSITIVE_INFINITY)).toMatchObject({ ok: false })
  })

  it('floating-point noise within a token precision does not refuse', () => {
    // 0.1 + 0.2 style drift must not reject a human-plausible amount
    expect(checkPrecision('USDC', 1.000001)).toMatchObject({ ok: true })
  })
})

describe('dust floor', () => {
  it('refuses sub-$1 notional with INVALID_NOTIONAL', () => {
    expect(checkMinNotional(0.5)).toMatchObject({ ok: false, code: 'INVALID_NOTIONAL' })
    expect(checkMinNotional(1)).toMatchObject({ ok: true })
    expect(MIN_NOTIONAL_USD).toBeGreaterThanOrEqual(1)
  })
})

describe('wallet balance gate (INSUFFICIENT_BALANCE steal)', () => {
  it('refuses when the wallet cannot fund the trade', () => {
    const r = checkBalance(1, 50, 'USDC')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('INSUFFICIENT_BALANCE')
      expect(r.reason).toContain('INSUFFICIENT_BALANCE')
      expect(r.reason).toContain('1 USDC')
    }
  })

  it('passes when funded, including exact balance', () => {
    expect(checkBalance(50, 50, 'USDC')).toMatchObject({ ok: true })
    expect(checkBalance(100, 50, 'USDC')).toMatchObject({ ok: true })
  })

  it('inconclusive balance is NOT zero — it never blocks', () => {
    expect(checkBalance(undefined, 50, 'USDC')).toMatchObject({ ok: true })
  })
})
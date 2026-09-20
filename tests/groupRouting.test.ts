import { describe, it, expect } from 'vitest'
import { extractMention } from '../src/telegram/bot.js'

describe('group mention routing', () => {
  it('detects a mention and strips it from the prompt', () => {
    const m = extractMention('@TradingAgent what is BTC doing?', 'TradingAgent')
    expect(m.addressed).toBe(true)
    expect(m.prompt).toBe('what is BTC doing?')
  })

  it('handles a mid-sentence mention', () => {
    const m = extractMention('hey @TradingAgent research MOG for us', 'TradingAgent')
    expect(m.addressed).toBe(true)
    expect(m.prompt).toBe('hey research MOG for us')
  })

  it('bare mention becomes an empty prompt (greeting)', () => {
    const m = extractMention('@TradingAgent', 'TradingAgent')
    expect(m.addressed).toBe(true)
    expect(m.prompt).toBe('')
  })

  it('ignores group chatter not addressed to the desk', () => {
    const m = extractMention('gm everyone, chart looks juicy', 'TradingAgent')
    expect(m.addressed).toBe(false)
    expect(m.prompt).toBe('gm everyone, chart looks juicy')
  })

  it('ignores similarly-named usernames (case-sensitive, exact match)', () => {
    const m = extractMention('@TradingAgentFan hello', 'TradingAgent')
    expect(m.addressed).toBe(false)
  })

  it('accepts the display-name alias as well as the real username', () => {
    // Bot username is tobycoder_bot but it shows as "TradingAgent" in groups.
    const m = extractMention('@TradingAgent what is ETH doing?', ['tobycoder_bot', 'TradingAgent'])
    expect(m.addressed).toBe(true)
    expect(m.prompt).toBe('what is ETH doing?')
  })

  it('matches the real username even when only it is mentioned', () => {
    const m = extractMention('yo @tobycoder_bot check PEPE', ['tobycoder_bot', 'TradingAgent'])
    expect(m.addressed).toBe(true)
    expect(m.prompt).toBe('yo check PEPE')
  })

  it('strips both handles when both appear in one message', () => {
    const m = extractMention('@tobycoder_bot @TradingAgent gm', ['tobycoder_bot', 'TradingAgent'])
    expect(m.addressed).toBe(true)
    expect(m.prompt).toBe('gm')
  })

  it('ignores chatter with no handle of any kind', () => {
    const m = extractMention('anyone watching SOL?', ['tobycoder_bot', 'TradingAgent'])
    expect(m.addressed).toBe(false)
  })
})
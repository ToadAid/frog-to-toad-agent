import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { guard } from '../src/safety/guard.js'
import { createApprovalGate } from '../src/safety/approvals.js'
import { appendLedger, readPositions, ledgerPath } from '../src/store/positions.js'
import { appendJsonl } from '../src/store/jsonl.js'
import { distillLessons, journalPath, type JournalEntry } from '../src/tools/journal.js'
import { createNullSender } from '../src/telegram/bot.js'

let dir: string
let cfg: Config

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-safety-'))
  process.env['TRADING_DESK_DIR'] = dir
  process.env['SELFTEST'] = '1'
  cfg = loadConfig()
})

// Fresh ledger/journal/lessons per test — folding and cap math fold the whole file.
beforeEach(() => {
  fs.rmSync(ledgerPath(cfg), { force: true })
  fs.rmSync(journalPath(cfg), { force: true })
  fs.rmSync(path.join(cfg.paths.dataDir, 'lessons'), { recursive: true, force: true })
})

describe('guard — hard caps in code', () => {
  it('blocks trades over the per-trade cap before any approval card', () => {
    const g = guard(cfg)
    const result = g.precheckTrade({ from: 'USDC', to: 'ETH', notionalUsd: 10_000 })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('per-trade cap')
  })

  it('blocks trades that would breach the daily cap', () => {
    // Raise the per-trade cap so this trade trips the DAILY cap, not the per-trade one.
    const loose = { ...cfg, limits: { ...cfg.limits, perTradeUsdMax: 100 } }
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'BTC',
      qty: 0.003,
      entryUsd: 50000,
      dryRun: true,
    }) // $150 of the $200 daily cap
    const g = guard(loose)
    const result = g.precheckTrade({ from: 'USDC', to: 'SOL', notionalUsd: 60 })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('daily cap')
  })

  it('enforces the token allowlist when non-empty', () => {
    const strict = { ...cfg, limits: { ...cfg.limits, tokenAllowlist: ['BTC', 'ETH'] } }
    const g = guard(strict)
    expect(g.precheckTrade({ from: 'USDC', to: 'BTC', notionalUsd: 10 }).ok).toBe(true)
    const bad = g.precheckTrade({ from: 'USDC', to: 'RANDOMMEME', notionalUsd: 10 })
    expect(bad.ok).toBe(false)
  })

  it('blocks symbols on the blocked list', () => {
    const blocked = { ...cfg, limits: { ...cfg.limits, blockedSymbols: ['PEPE'] } }
    const g = guard(blocked)
    const r = g.precheckTrade({ from: 'USDC', to: 'PEPE', notionalUsd: 5 })
    expect(r.ok).toBe(false)
  })
})

describe('ledger → positions folding', () => {
  it('folds open/close into positions and realized P&L', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'ETH',
      qty: 0.05,
      entryUsd: 2000,
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'close',
      symbol: 'ETH',
      qty: 0.05,
      exitUsd: 2200,
      dryRun: true,
    })
    const book = readPositions(cfg)
    expect(book.positions.find((p) => p.symbol === 'ETH')).toBeUndefined()
    expect(book.realizedPnlUsd).toBeCloseTo(10, 2)
  })

  it('keeps partially closed positions', () => {
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'open',
      symbol: 'BTC',
      qty: 0.002,
      entryUsd: 50000,
      dryRun: true,
    })
    appendLedger(cfg, {
      ts: Date.now(),
      type: 'close',
      symbol: 'BTC',
      qty: 0.001,
      exitUsd: 51000,
      dryRun: true,
    })
    const book = readPositions(cfg)
    const btc = book.positions.find((p) => p.symbol === 'BTC')
    expect(btc).toBeDefined()
    expect(btc!.qty).toBeCloseTo(0.001, 6)
    expect(btc!.avgEntryUsd).toBeCloseTo(50000, 2)
  })
})

describe('approval gate — deny is the default', () => {
  /** The gate registers its pending request in a microtask (after sending the card). */
  async function flushMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  it('allows when the owner presses approve', async () => {
    const sender = createNullSender()
    const adminCfg: Config = { ...cfg, telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111, botToken: 'x' } }
    const gate = createApprovalGate(adminCfg, sender)
    const signal = new AbortController().signal
    const p = gate({ tool: 'swap_execute', input: {}, summary: 'test trade', danger: 'trade' }, 111, signal)
    await flushMicrotasks()
    const reqId = sender.keyboards[0]!.keyboard[0]![0]!.callbackData.split(':')[1]!
    gate.handleCallback(`apr:${reqId}:y`, 111, 'cb1')
    await expect(p).resolves.toBe('allow')
  })

  it('ignores a non-owner callback and keeps the approval pending for the owner', async () => {
    const sender = createNullSender()
    const adminCfg: Config = { ...cfg, telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111, botToken: 'x' } }
    const gate = createApprovalGate(adminCfg, sender)
    const signal = new AbortController().signal
    const p = gate({ tool: 'swap_execute', input: {}, summary: 'x', danger: 'trade' }, 111, signal)
    await flushMicrotasks()
    const reqId = sender.keyboards[0]!.keyboard[0]![0]!.callbackData.split(':')[1]!
    // Impostor presses approve — must be refused, and must NOT settle the owner's request.
    gate.handleCallback(`apr:${reqId}:y`, 999, 'cb2')
    expect(sender.answers.some((a) => a.text?.includes('not authorized'))).toBe(true)
    // Owner still holds the decision: their deny lands.
    gate.handleCallback(`apr:${reqId}:n`, 111, 'cb3')
    await expect(p).resolves.toBe('deny')
  })

  it('auto-denies on timeout', async () => {
    const sender = createNullSender()
    const fastCfg: Config = {
      ...cfg,
      telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111, botToken: 'x' },
      limits: { ...cfg.limits, approvalTimeoutSec: 1 },
    }
    const gate = createApprovalGate(fastCfg, sender)
    const p = gate({ tool: 'swap_execute', input: {}, summary: 'x', danger: 'trade' }, 111, new AbortController().signal)
    await expect(p).resolves.toBe('timeout')
  })

  it('denies when no admin chat is configured', async () => {
    const sender = createNullSender()
    const noAdmin: Config = { ...cfg, telegram: { ...cfg.telegram, adminChatId: undefined, botToken: 'x' } }
    const gate = createApprovalGate(noAdmin, sender)
    const p = gate({ tool: 'swap_execute', input: {}, summary: 'x', danger: 'trade' }, 111, new AbortController().signal)
    await expect(p).resolves.toBe('no_channel')
  })

  it('throttle: refuses a new card once approvalMaxPending cards are already pending', async () => {
    const sender = createNullSender()
    const throttled: Config = {
      ...cfg,
      telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111, botToken: 'x' },
      limits: { ...cfg.limits, approvalMaxPending: 2, approvalMinIntervalSec: 0 },
    }
    const gate = createApprovalGate(throttled, sender)
    const p1 = gate({ tool: 'swap_execute', input: {}, summary: 'trade 1', danger: 'trade' }, 111, new AbortController().signal)
    const p2 = gate({ tool: 'swap_execute', input: {}, summary: 'trade 2', danger: 'trade' }, 111, new AbortController().signal)
    await flushMicrotasks()
    expect(gate.pendingCount()).toBe(2)
    // A runaway loop asking for a third card gets DENIED, not queued.
    const p3 = gate({ tool: 'swap_execute', input: {}, summary: 'trade 3', danger: 'trade' }, 111, new AbortController().signal)
    await expect(p3).resolves.toBe('deny')
    expect(sender.keyboards).toHaveLength(2) // no third card was ever sent
    // Once a card settles, the slot frees and the next card goes through.
    gate.denyAll('test cleanup')
    await expect(p1).resolves.toBe('deny')
    await expect(p2).resolves.toBe('deny')
    const p4 = gate({ tool: 'swap_execute', input: {}, summary: 'trade 4', danger: 'trade' }, 111, new AbortController().signal)
    await flushMicrotasks()
    expect(gate.pendingCount()).toBe(1)
    expect(sender.keyboards).toHaveLength(3)
    gate.denyAll('test cleanup')
    await expect(p4).resolves.toBe('deny')
  })

  it('throttle: refuses a card sent within approvalMinIntervalSec of the previous one', async () => {
    const sender = createNullSender()
    const throttled: Config = {
      ...cfg,
      telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111, botToken: 'x' },
      limits: { ...cfg.limits, approvalMaxPending: 10, approvalMinIntervalSec: 60 },
    }
    const gate = createApprovalGate(throttled, sender)
    const p1 = gate({ tool: 'swap_execute', input: {}, summary: 'first', danger: 'trade' }, 111, new AbortController().signal)
    await flushMicrotasks() // first card actually sent → lastCardAt is set
    expect(gate.pendingCount()).toBe(1)
    // Immediate second card is inside the min interval → denied without a card.
    const p2 = gate({ tool: 'swap_execute', input: {}, summary: 'second', danger: 'trade' }, 111, new AbortController().signal)
    await expect(p2).resolves.toBe('deny')
    expect(sender.keyboards).toHaveLength(1)
    gate.denyAll('test cleanup')
    await expect(p1).resolves.toBe('deny')
  })

  it('denyAll (kill switch) denies every pending approval at once', async () => {
    const sender = createNullSender()
    const adminCfg: Config = { ...cfg, telegram: { ...cfg.telegram, adminChatId: 111, principalUserId: 111, botToken: 'x' } }
    const gate = createApprovalGate(adminCfg, sender)
    const p1 = gate({ tool: 'swap_execute', input: {}, summary: 'trade 1', danger: 'trade' }, 111, new AbortController().signal)
    const p2 = gate({ tool: 'swap_execute', input: {}, summary: 'trade 2', danger: 'trade' }, 111, new AbortController().signal)
    await flushMicrotasks()
    expect(gate.pendingCount()).toBe(2)
    expect(gate.denyAll('kill switch')).toBe(2)
    await expect(p1).resolves.toBe('deny')
    await expect(p2).resolves.toBe('deny')
    expect(gate.pendingCount()).toBe(0)
    // The cards were updated so the chat shows the kill outcome.
    expect(sender.messages.filter((m) => m.text.includes('DENIED (kill switch)')).length).toBe(2)
  })
})

describe('lesson distillation — sample-size gate is code, not prompt', () => {
  it('skips a pattern with fewer than min samples', () => {
    const entries: JournalEntry[] = Array.from({ length: 4 }, (_, i) => ({
      ts: Date.now(),
      symbol: 'MOG',
      decision: 'bought memes',
      grade: 'bad-process',
      lesson: `lesson ${i}`,
    }))
    for (const e of entries) appendJsonl(journalPath(cfg), e)
    const result = distillLessons(cfg)
    expect(result.written).toHaveLength(0)
    expect(result.skipped.some((s) => s.pattern === 'MOG:bad-process' && s.n === 4)).toBe(true)
  })

  it('promotes a pattern with enough samples, once', () => {
    const entries: JournalEntry[] = Array.from({ length: 6 }, (_, i) => ({
      ts: Date.now(),
      symbol: 'PEPE',
      decision: 'chased pump',
      grade: 'bad-process',
      lesson: 'never chase pumps',
    }))
    for (const e of entries) appendJsonl(journalPath(cfg), e)
    const result = distillLessons(cfg)
    expect(result.written).toContain('PEPE:bad-process')
    // second run: no duplicate lesson lines
    const again = distillLessons(cfg)
    expect(again.written).toHaveLength(0)
  })
})

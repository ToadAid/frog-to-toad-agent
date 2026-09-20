import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../src/config.js'
import { appendJsonlBatch, readJsonl } from '../src/store/jsonl.js'
import { appendLedgerBatch, ledgerPath, readLedger } from '../src/store/positions.js'

describe('D1-P4 single-append JSONL batches', () => {
  it('serializes related records into exactly one filesystem append call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-jsonl-batch-'))
    const file = path.join(dir, 'batch.jsonl')
    const appendSpy = vi.spyOn(fs, 'appendFileSync')

    try {
      appendJsonlBatch(file, [{ id: 1 }, { id: 2 }])

      expect(appendSpy).toHaveBeenCalledTimes(1)
      expect(appendSpy).toHaveBeenCalledWith(file, '{"id":1}\n{"id":2}\n')
      expect(readJsonl<{ id: number }>(file)).toEqual([{ id: 1 }, { id: 2 }])
    } finally {
      appendSpy.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serializes the whole batch before writing so a later serialization failure leaves no prefix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-jsonl-batch-fail-'))
    const file = path.join(dir, 'batch.jsonl')
    fs.writeFileSync(file, '{"seed":true}\n', 'utf8')
    const before = fs.readFileSync(file, 'utf8')
    const appendSpy = vi.spyOn(fs, 'appendFileSync')

    try {
      expect(() => appendJsonlBatch(file, [{ id: 1 }, { bad: 1n }])).toThrow()
      expect(appendSpy).not.toHaveBeenCalled()
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
    } finally {
      appendSpy.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats an empty batch as a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-jsonl-batch-empty-'))
    const file = path.join(dir, 'batch.jsonl')
    try {
      appendJsonlBatch(file, [])
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes the same ordered primitive at the canonical ledger boundary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-ledger-batch-'))
    const cfg = { paths: { dataDir: dir } } as Config
    const entries = [
      {
        ts: 1,
        type: 'close' as const,
        symbol: 'AAA',
        tokenAddress: '0x1111111111111111111111111111111111111111',
        qty: 2,
        exitUsd: 10,
        dryRun: true,
      },
      {
        ts: 1,
        type: 'open' as const,
        symbol: 'BBB',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        qty: 4,
        entryUsd: 5,
        dryRun: true,
      },
    ]

    try {
      appendLedgerBatch(cfg, entries)
      expect(readLedger(cfg)).toEqual(entries)
      expect(fs.readFileSync(ledgerPath(cfg), 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

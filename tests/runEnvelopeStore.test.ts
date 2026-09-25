import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import {
  assertRunWriterFenceCurrent,
  issueRunWriterFence,
  persistRunEnvelope,
  readRunEnvelopeHead,
} from '../src/store/runEnvelopeStore.js'

const roots: string[] = []

function fixture(): { cfg: Config; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-run-envelope-'))
  roots.push(root)
  return { cfg: { paths: { dataDir: root } }, root }
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('governed run envelope persistence gate', () => {
  it('issues monotonic fencing tokens and rejects stale writers', async () => {
    const { cfg } = fixture()
    const first = await issueRunWriterFence(cfg, { runId: 'run-1', ownerId: 'worker-a', reason: 'START', issuedAt: '2026-09-25T12:00:00.000Z' })
    expect(first.fencingToken).toBe(1)
    expect(() => assertRunWriterFenceCurrent(cfg, first)).not.toThrow()
    const second = await issueRunWriterFence(cfg, { runId: 'run-1', ownerId: 'worker-b', reason: 'FAILOVER', issuedAt: '2026-09-25T12:01:00.000Z' })
    expect(second.fencingToken).toBe(2)
    expect(() => assertRunWriterFenceCurrent(cfg, first)).toThrow(/stale run writer fence/)
    expect(() => assertRunWriterFenceCurrent(cfg, second)).not.toThrow()
  })

  it('refuses fencing-token clock rollback', async () => {
    const { cfg } = fixture()
    await issueRunWriterFence(cfg, { runId: 'run-clock', ownerId: 'worker-a', reason: 'START', issuedAt: '2026-09-25T12:01:00.000Z' })
    await expect(issueRunWriterFence(cfg, { runId: 'run-clock', ownerId: 'worker-b', reason: 'RESTART', issuedAt: '2026-09-25T12:00:00.000Z' })).rejects.toThrow(/cannot move backwards/)
  })

  it('requires EMPTY CAS for the first write and exact-head CAS after it', async () => {
    const { cfg } = fixture()
    const fence = await issueRunWriterFence(cfg, { runId: 'run-2', ownerId: 'worker-a', reason: 'START', issuedAt: '2026-09-25T12:00:00.000Z' })
    const first = await persistRunEnvelope(cfg, fence, { slot: 'run-state', expectedHeadSha256: null, envelope: { b: 2, a: 1 }, updatedAt: '2026-09-25T12:00:01.000Z' })
    expect(first.record.revision).toBe(0)
    expect(first.record.previousHeadSha256).toBeNull()
    expect(readRunEnvelopeHead(cfg, 'run-2', 'run-state')?.headSha256).toBe(first.headSha256)
    const second = await persistRunEnvelope(cfg, fence, { slot: 'run-state', expectedHeadSha256: first.headSha256, envelope: { state: 'next' }, updatedAt: '2026-09-25T12:00:02.000Z' })
    expect(second.record.revision).toBe(1)
    expect(second.record.previousHeadSha256).toBe(first.headSha256)
  })

  it('refuses stale CAS overwrite after another writer advances the slot', async () => {
    const { cfg } = fixture()
    const fence = await issueRunWriterFence(cfg, { runId: 'run-3', ownerId: 'worker-a', reason: 'START' })
    const first = await persistRunEnvelope(cfg, fence, { slot: 'budget', expectedHeadSha256: null, envelope: { remaining: 10 } })
    const second = await persistRunEnvelope(cfg, fence, { slot: 'budget', expectedHeadSha256: first.headSha256, envelope: { remaining: 9 } })
    await expect(persistRunEnvelope(cfg, fence, { slot: 'budget', expectedHeadSha256: first.headSha256, envelope: { remaining: 8 } })).rejects.toThrow(/CAS mismatch/)
    expect(readRunEnvelopeHead(cfg, 'run-3', 'budget')?.headSha256).toBe(second.headSha256)
  })

  it('blocks an old worker after a failover fence is issued', async () => {
    const { cfg } = fixture()
    const oldFence = await issueRunWriterFence(cfg, { runId: 'run-4', ownerId: 'worker-a', reason: 'START' })
    const first = await persistRunEnvelope(cfg, oldFence, { slot: 'invocation:abc', expectedHeadSha256: null, envelope: { status: 'STARTED' } })
    const newFence = await issueRunWriterFence(cfg, { runId: 'run-4', ownerId: 'worker-b', reason: 'FAILOVER' })
    await expect(persistRunEnvelope(cfg, oldFence, { slot: 'invocation:abc', expectedHeadSha256: first.headSha256, envelope: { status: 'COMPLETED' } })).rejects.toThrow(/stale run writer fence/)
    const next = await persistRunEnvelope(cfg, newFence, { slot: 'invocation:abc', expectedHeadSha256: first.headSha256, envelope: { status: 'RECONCILIATION_REQUIRED' } })
    expect(next.record.writer.fencingToken).toBe(newFence.fencingToken)
  })

  it('allows only one concurrent write from the same observed head', async () => {
    const { cfg } = fixture()
    const fence = await issueRunWriterFence(cfg, { runId: 'run-5', ownerId: 'worker-a', reason: 'START' })
    const first = await persistRunEnvelope(cfg, fence, { slot: 'progress', expectedHeadSha256: null, envelope: { value: 0 } })
    const results = await Promise.allSettled([
      persistRunEnvelope(cfg, fence, { slot: 'progress', expectedHeadSha256: first.headSha256, envelope: { value: 1 } }),
      persistRunEnvelope(cfg, fence, { slot: 'progress', expectedHeadSha256: first.headSha256, envelope: { value: 2 } }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('canonicalizes payload hashes independent of object insertion order', async () => {
    const firstCfg = fixture().cfg
    const secondCfg = fixture().cfg
    const firstFence = await issueRunWriterFence(firstCfg, { runId: 'same', ownerId: 'worker', reason: 'START', issuedAt: '2026-09-25T12:00:00.000Z' })
    const secondFence = await issueRunWriterFence(secondCfg, { runId: 'same', ownerId: 'worker', reason: 'START', issuedAt: '2026-09-25T12:00:00.000Z' })
    const first = await persistRunEnvelope(firstCfg, firstFence, { slot: 'state', expectedHeadSha256: null, envelope: { a: 1, b: { x: 2, y: 3 } }, updatedAt: '2026-09-25T12:00:01.000Z' })
    const second = await persistRunEnvelope(secondCfg, secondFence, { slot: 'state', expectedHeadSha256: null, envelope: { b: { y: 3, x: 2 }, a: 1 }, updatedAt: '2026-09-25T12:00:01.000Z' })
    expect(first.record.envelopeSha256).toBe(second.record.envelopeSha256)
    expect(first.headSha256).toBe(second.headSha256)
  })

  it('detects stored-envelope tampering on read', async () => {
    const { cfg, root } = fixture()
    const fence = await issueRunWriterFence(cfg, { runId: 'run-7', ownerId: 'worker-a', reason: 'START' })
    await persistRunEnvelope(cfg, fence, { slot: 'state', expectedHeadSha256: null, envelope: { safe: true } })
    const runHash = crypto.createHash('sha256').update('run-7').digest('hex')
    const slotHash = crypto.createHash('sha256').update('state').digest('hex')
    const file = path.join(root, 'runtime', 'governed-runs', runHash, 'slots', `${slotHash}.json`)
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { record: { envelope: Record<string, unknown> } }
    doc.record.envelope.safe = false
    fs.writeFileSync(file, JSON.stringify(doc), 'utf8')
    expect(() => readRunEnvelopeHead(cfg, 'run-7', 'state')).toThrow(/integrity mismatch/)
  })

  it('hashes run and slot identities into owned paths', async () => {
    const { cfg, root } = fixture()
    const fence = await issueRunWriterFence(cfg, { runId: '../odd/run', ownerId: 'worker-a', reason: 'START' })
    await persistRunEnvelope(cfg, fence, { slot: '../../state', expectedHeadSha256: null, envelope: { ok: true } })
    expect(fs.existsSync(path.join(root, 'state.json'))).toBe(false)
    expect(readRunEnvelopeHead(cfg, '../odd/run', '../../state')?.record.envelopeSha256).toHaveLength(64)
  })
})

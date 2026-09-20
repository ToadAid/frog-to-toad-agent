#!/usr/bin/env node
/**
 * purge-ledger — surgical one-line surgery on the desk ledger (append-only JSONL).
 *
 * The ledger is the single source of truth (src/store/positions.ts) and is
 * append-only by design — so a wrong entry (the 2026-09-03 phantom WETH fill:
 * estimate qty/quote price recorded instead of the onchain balance delta)
 * cannot be edited through the normal tools. This script is the principal's
 * scalpel. Plain .mjs on purpose: runs with bare node, no tsx, works even
 * when the desk process is stopped.
 *
 *   node scripts/purge-ledger.mjs --file data/ledger.jsonl --match '<unique substring>'
 *     → CHECK (default): prints the ONE matching line. Writes nothing.
 *
 *   ... --apply
 *     → DELETE that one line (timestamped .bak- backup written first).
 *
 *   ... --apply --set '{"qty":0.000413238788690533,"entryUsd":2419.9084,"qtySource":"balance_delta"}'
 *     → REPLACE: merge these fields into the matched entry (ts/type/txHash kept).
 *
 * Guards (fail-closed):
 *   - --match must hit EXACTLY ONE non-empty line (0 or >1 → refuse, show hits)
 *   - backup before every write; atomic tmp+rename
 *   - --set requires the matched line to be a JSON object; diff printed pre-write
 */
import fs from 'node:fs'

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}
const flag = (name) => process.argv.includes('--' + name)

const file = arg('file')
const match = arg('match')
const setRaw = arg('set')
const apply = flag('apply')

if (!file || !match) {
  console.error("usage: node scripts/purge-ledger.mjs --file <ledger.jsonl> --match '<unique substring>' [--apply] [--set '<json>']")
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`[purge] no such file: ${file}`)
  process.exit(1)
}

const raw = fs.readFileSync(file, 'utf8')
const lines = raw.split('\n')
const hits = []
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '') continue
  if (lines[i].includes(match)) hits.push(i)
}

if (hits.length !== 1) {
  console.error(`[purge] REFUSED: --match must hit EXACTLY ONE line, got ${hits.length}. Nothing written.`)
  for (const h of hits.slice(0, 10)) console.error(`  line ${h + 1}: ${lines[h].slice(0, 140)}`)
  process.exit(1)
}
const idx = hits[0]
const oldLine = lines[idx]

const entryCount = lines.filter((l) => l.trim() !== '').length
console.log(`[purge] target — line ${idx + 1} of ${entryCount} entries:`)
console.log(`  ${oldLine}`)

let parsed = null
let parses = true
try {
  parsed = JSON.parse(oldLine)
} catch {
  parses = false
}
if (!parses) console.log('  (note: line is not valid JSON — corrupt line; --set unavailable, delete only)')

let newLine = null
if (setRaw !== undefined) {
  if (!parses || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[purge] REFUSED: --set needs the matched line to be a JSON object.')
    process.exit(1)
  }
  let patch
  try {
    patch = JSON.parse(setRaw)
  } catch (e) {
    console.error(`[purge] REFUSED: --set is not valid JSON: ${e.message}`)
    process.exit(1)
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    console.error('[purge] REFUSED: --set must be a JSON object.')
    process.exit(1)
  }
  newLine = JSON.stringify({ ...parsed, ...patch })
  console.log('[purge] replacement:')
  console.log(`  ${newLine}`)
}

if (!apply) {
  console.log('[purge] CHECK mode — nothing written. Add --apply to execute.')
  process.exit(0)
}

// Backup first — a purge without an escape hatch is a second incident.
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${file}.bak-${stamp}`
fs.copyFileSync(file, backup)

lines[idx] = newLine ?? null
const hadTrailingNewline = raw.endsWith('\n')
let out = lines.filter((l) => l !== null).join('\n')
if (hadTrailingNewline && !out.endsWith('\n')) out += '\n'

const tmp = `${file}.tmp-purge-${stamp}`
fs.writeFileSync(tmp, out)
fs.renameSync(tmp, file)

console.log(`[purge] ${newLine !== null ? 'REPLACED' : 'DELETED'} line ${idx + 1}. backup: ${backup}`)
console.log('[purge] done — re-run in CHECK mode (expect 0 hits) or portfolio_get to verify.')
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../log.js'

/** Append one JSON object as a line. Single appendFile — crash-safe on POSIX. */
export function appendJsonl(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + '\n')
}


/**
 * Append related JSONL records through one filesystem append call.
 *
 * Every record is serialized before the filesystem is touched, so a
 * serialization failure cannot leave a prefix of the logical batch behind.
 * This is a single-append durability primitive, not a cross-process
 * transaction guarantee.
 */
export function appendJsonlBatch(file: string, objects: unknown[]): void {
  if (objects.length === 0) return
  const payload = objects.map((obj) => JSON.stringify(obj)).join('\n') + '\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, payload)
}

export function readJsonl<T>(file: string, opts?: { onCorrupt?: (corruptLines: number) => void }): T[] {
  if (!fs.existsSync(file)) return []
  const out: T[] = []
  let corrupt = 0
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // Corrupt line: skip with a warning. Last (partially-written) line after a crash.
      corrupt++
      log.warn(`jsonl: skipping corrupt line ${i + 1} in ${file}`)
    }
  }
  if (corrupt > 0) opts?.onCorrupt?.(corrupt)
  return out
}

export function tailJsonl<T>(file: string, n: number): T[] {
  const all = readJsonl<T>(file)
  return all.slice(-n)
}
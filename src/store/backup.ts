import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'

/**
 * Rotating state backups (NautilusTrader cache-snapshot steal, desk-sized).
 * Every state file we depend on is atomic-write, but a corrupt or truncated
 * write can still DESTROY the only copy — the ledger is the desk's memory.
 * Keep the last N generations under data/backups/, rotated at boot: at most
 * one session's writes are ever at risk, and a bad file always has an undo.
 */

export const BACKUP_GENERATIONS = 3

function backupDir(cfg: Config): string {
  return path.join(cfg.paths.dataDir, 'backups')
}

function sameBytes(a: string, b: string): boolean {
  const sa = fs.statSync(a)
  const sb = fs.statSync(b)
  if (sa.size !== sb.size) return false
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

/**
 * Rotate one file: current → .1 → .2 → … (oldest beyond maxGenerations is
 * deleted). Unchanged files don't consume a generation. Missing source is a
 * no-op (nothing to back up yet). Never throws — a backup failure must not
 * take the desk down.
 */
export function rotateBackup(cfg: Config, fileName: string, maxGenerations = BACKUP_GENERATIONS): string | undefined {
  try {
    const src = path.join(cfg.paths.dataDir, fileName)
    if (!fs.existsSync(src)) return undefined
    const dir = backupDir(cfg)
    fs.mkdirSync(dir, { recursive: true })

    const gen = (n: number) => path.join(dir, `${fileName}.${n}`)
    if (fs.existsSync(gen(1)) && sameBytes(src, gen(1))) return gen(1) // unchanged — keep generations

    // Shift older generations down; delete the one that falls off the cliff.
    for (let n = maxGenerations - 1; n >= 1; n--) {
      if (fs.existsSync(gen(n))) {
        if (n === maxGenerations) fs.rmSync(gen(n))
        else fs.renameSync(gen(n), gen(n + 1))
      }
    }
    fs.copyFileSync(src, gen(1))
    return gen(1)
  } catch (e) {
    console.warn(`[backup] rotating ${fileName} failed: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

/** Rotate every state file the desk cannot afford to lose (boot + daily). */
export function rotateStateBackups(cfg: Config): string[] {
  return ['ledger.jsonl', 'desk_state.json']
    .map((f) => rotateBackup(cfg, f))
    .filter((p): p is string => p !== undefined)
}
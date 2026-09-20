import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { sandboxRoot } from './workspace.js'

const INCLUDE = [
  'src', 'agents', 'scripts', 'tests', 'skills', '.github',
  'kronos-server/forecast.py', 'kronos-server/run.sh', 'kronos-server/requirements.txt', 'kronos-server/ATTRIBUTION.md',
  'cobo-wallet-server/ONBOARDING.md', 'cobo-wallet-server/run.sh',
  'config.json', 'package.json', 'tsconfig.json', 'README.md', 'feature_list.md', 'BUILD_LIST.md',
  '.env.example', '.gitignore',
]

function countFiles(root: string): number {
  if (!fs.statSync(root).isDirectory()) return 1
  return fs.readdirSync(root, { withFileTypes: true }).reduce(
    (count, item) => count + (item.isDirectory() ? countFiles(path.join(root, item.name)) : 1),
    0,
  )
}

/** Refresh the agent's source view from an explicit public-file allowlist.
 * Build in a staging directory first so an interrupted copy never leaves a
 * partially refreshed mirror. State, credentials, lockfiles and wallet data
 * are deliberately absent. */
export function refreshRepoMirror(cfg: Config, root: string): { files: number; missing: string[] } {
  const sandbox = sandboxRoot(cfg)
  const dest = path.join(sandbox, 'repo')
  const stage = path.join(sandbox, `.repo-stage-${process.pid}`)
  const old = path.join(sandbox, `.repo-old-${process.pid}`)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.rmSync(old, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  let files = 0
  const missing: string[] = []
  try {
    for (const entry of INCLUDE) {
      const src = path.join(root, entry)
      if (!fs.existsSync(src)) {
        missing.push(entry)
        continue
      }
      fs.cpSync(src, path.join(stage, entry), { recursive: true, force: true })
      files += countFiles(src)
    }
    if (fs.existsSync(dest)) fs.renameSync(dest, old)
    fs.renameSync(stage, dest)
    fs.rmSync(old, { recursive: true, force: true })
    return { files, missing }
  } catch (error) {
    if (!fs.existsSync(dest) && fs.existsSync(old)) fs.renameSync(old, dest)
    throw error
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(old, { recursive: true, force: true })
  }
}

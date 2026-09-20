/**
 * Repo mirror — the desk's read-only window into its own source.
 *
 *   npm run mirror:repo
 *
 * Copies the live source tree into `data/sandbox/repo/` so the agents can
 * workspace_read the REAL code (verify claims against the repo, not memory)
 * while every write still lands in their sandbox scratch space. The mirror is
 * refreshed by hand — a stale mirror is better than a live write path into
 * the desk that runs the desk. Code review discipline: read the mirror,
 * propose diffs, the PRINCIPAL applies.
 */
import fs from 'node:fs'
import path from 'node:path'
import { sandboxRoot } from '../src/tools/workspace.js'
import { loadConfig } from '../src/config.js'

// What the frog may READ of its own body. Source + docs, never state, never
// secrets: data/ (ledger + workspace memory) and .env stay out by name.
const INCLUDE = [
  'src',
  'agents',
  'scripts',
  'tests',
  'skills',
  'kronos-server/forecast.py',
  'kronos-server/run.sh',
  'kronos-server/requirements.txt',
  'kronos-server/ATTRIBUTION.md',
  'cobo-wallet-server/ONBOARDING.md',
  'cobo-wallet-server/run.sh',
  'config.json',
  'package.json',
  'tsconfig.json',
  'README.md',
  'feature_list.md',
  'BUILD_LIST.md',
  '.env.example',
  '.gitignore',
]

const root = process.env.FROG_TO_TOAD_DIR ?? process.env.TRADING_DESK_DIR ?? process.cwd()
const cfg = loadConfig()
const dest = path.join(sandboxRoot(cfg), 'repo')

fs.rmSync(dest, { recursive: true, force: true })
let files = 0
for (const entry of INCLUDE) {
  const src = path.join(root, entry)
  if (!fs.existsSync(src)) {
    console.warn(`[mirror] missing, skipped: ${entry}`)
    continue
  }
  const out = path.join(dest, entry)
  fs.cpSync(src, out, { recursive: true, force: true })
  const stat = fs.statSync(src)
  files += stat.isDirectory()
    ? (function walk(dir: string): number {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .reduce((n, d) => (d.isDirectory() ? n + walk(path.join(dir, d.name)) : n + 1), 0)
      })(src)
    : 1
}
console.log(`[mirror] ${files} files → ${path.relative(root, dest)}`)

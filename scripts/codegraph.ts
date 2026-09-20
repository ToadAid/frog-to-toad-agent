import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deskRoot } from '../src/config.js'
import { inspectRepoEyes, readCodegraphVersionPin, runRepoEyesChild, verifyCodegraphVersion } from '../src/repoEyes.js'

type Lock = {
  version: string
  releaseTag: string
  repository: string
  artifacts: Record<string, { file: string; sha256: string }>
}

function readLock(root: string): Lock {
  return JSON.parse(fs.readFileSync(path.join(root, 'codegraph.lock.json'), 'utf8')) as Lock
}

function localCommand(root: string): string {
  return path.join(root, '.tools', 'codegraph', 'current', 'bin', 'codegraph')
}

function run(command: string, args: string[], cwd: string): void {
  const result = runRepoEyesChild(command, args, cwd, 'inherit')
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

async function install(root: string): Promise<string> {
  const pin = readLock(root)
  const existing = localCommand(root)
  if (fs.existsSync(existing) && verifyCodegraphVersion(existing, pin.version, root).ok) {
    console.log(`CodeGraph ${pin.version} already verified at ${existing}`)
    return existing
  }

  const platform = process.platform === 'linux' ? 'linux' : process.platform
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  const key = `${platform}-${arch}`
  const artifact = pin.artifacts[key]
  if (!artifact) throw new Error(`no pinned CodeGraph artifact for ${key}`)

  const url = `https://github.com/${pin.repository}/releases/download/${pin.releaseTag}/${artifact.file}`
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-to-toad-codegraph-'))
  const archive = path.join(scratch, artifact.file)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`CodeGraph download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256) throw new Error(`CodeGraph checksum mismatch for ${artifact.file}`)
  fs.writeFileSync(archive, bytes, { mode: 0o600 })

  const versions = path.join(root, '.tools', 'codegraph', 'versions')
  const destination = path.join(versions, pin.version)
  const unpacked = path.join(scratch, `codegraph-${key}`)
  fs.mkdirSync(versions, { recursive: true })
  run('tar', ['-xzf', archive, '-C', scratch], root)
  if (!fs.existsSync(path.join(unpacked, 'bin', 'codegraph'))) throw new Error('CodeGraph archive lacks bin/codegraph')
  fs.rmSync(destination, { recursive: true, force: true })
  fs.renameSync(unpacked, destination)
  const current = path.join(root, '.tools', 'codegraph', 'current')
  fs.rmSync(current, { force: true })
  fs.symlinkSync(path.relative(path.dirname(current), destination), current, 'dir')
  fs.rmSync(scratch, { recursive: true, force: true })

  const verified = verifyCodegraphVersion(localCommand(root), pin.version, root)
  if (!verified.ok) throw new Error(verified.detail ?? 'CodeGraph verification failed after install')
  console.log(`CodeGraph ${pin.version} checksum-verified at ${localCommand(root)}`)
  return localCommand(root)
}

async function main(): Promise<void> {
  const root = deskRoot()
  const commandName = process.argv[2] ?? 'status'
  if (commandName === 'install') {
    await install(root)
    return
  }
  if (commandName === 'verify') {
    const binaryAt = process.argv[3] ?? localCommand(root)
    const result = verifyCodegraphVersion(binaryAt, readCodegraphVersionPin(root), root)
    if (!result.ok) throw new Error(result.detail ?? 'CodeGraph verification failed')
    console.log(`CodeGraph ${result.observed} verified at ${binaryAt}`)
    return
  }
  if (commandName === 'init' || commandName === 'bootstrap') {
    const binaryAt = await install(root)
    run(binaryAt, ['init', root], root)
    console.log(JSON.stringify(inspectRepoEyes(root, { command: binaryAt }), null, 2))
    return
  }
  if (commandName === 'wire') {
    const target = process.argv[3]
    if (!target || !/^[a-z][a-z0-9,-]*$/.test(target)) throw new Error('wire requires an explicit supported agent target, e.g. codex')
    const binaryAt = await install(root)
    run(binaryAt, ['install', '--target', target, '--location', 'local', '--yes'], root)
    return
  }
  if (commandName === 'status') {
    console.log(JSON.stringify(inspectRepoEyes(root), null, 2))
    return
  }
  throw new Error(`unknown CodeGraph command: ${commandName}`)
}

void main().catch((error: unknown) => {
  console.error(`[codegraph] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

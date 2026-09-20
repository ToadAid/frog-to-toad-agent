import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../src/config.js'
import { createToolRegistry } from '../src/tools/index.js'
import { refreshRepoMirror } from '../src/tools/repoMirror.js'
import { isProtectedSandboxPath } from '../src/tools/workspace.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-d0-'))
  roots.push(root)
  return root
}

describe('D0 — sandbox sovereignty', () => {
  it('repo namespace is mechanically protected from workspace writes', () => {
    expect(isProtectedSandboxPath('repo')).toBe(true)
    expect(isProtectedSandboxPath('repo/src/index.ts')).toBe(true)
    expect(isProtectedSandboxPath('./repo/skills/x/SKILL.md')).toBe(true)
    expect(isProtectedSandboxPath('skills/x/SKILL.md')).toBe(false)
  })

  it('repo mirror copies allowlisted context and excludes operator state/secrets', () => {
    const root = tempRoot()
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'marker.ts'), 'export const marker = 1\n')
    fs.writeFileSync(path.join(root, 'agents', 'frog.md'), '# frog\n')
    fs.writeFileSync(path.join(root, 'config.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n')
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=never-copy\n')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'wallet-secret.txt'), 'never-copy\n')

    const cfg = { paths: { dataDir } } as Config
    const result = refreshRepoMirror(cfg, root)
    const mirror = path.join(dataDir, 'sandbox', 'repo')

    expect(result.files).toBeGreaterThanOrEqual(4)
    expect(fs.readFileSync(path.join(mirror, 'src', 'marker.ts'), 'utf8')).toContain('marker')
    expect(fs.existsSync(path.join(mirror, '.env'))).toBe(false)
    expect(fs.existsSync(path.join(mirror, 'data'))).toBe(false)
  })

  it('repo mirror refresh replaces the prior snapshot rather than mixing generations', () => {
    const root = tempRoot()
    const dataDir = path.join(root, 'data')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'old.ts'), 'old\n')
    const cfg = { paths: { dataDir } } as Config

    refreshRepoMirror(cfg, root)
    fs.rmSync(path.join(root, 'src', 'old.ts'))
    fs.writeFileSync(path.join(root, 'src', 'new.ts'), 'new\n')
    refreshRepoMirror(cfg, root)

    const mirrorSrc = path.join(dataDir, 'sandbox', 'repo', 'src')
    expect(fs.existsSync(path.join(mirrorSrc, 'old.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(mirrorSrc, 'new.ts'), 'utf8')).toBe('new\n')
  })

  it('runtime_status remains available when writable hands are gated', () => {
    const registry = createToolRegistry(false)
    expect(registry.get('runtime_status')).toBeDefined()
    expect(registry.get('workspace_write')).toBeUndefined()
    expect(registry.get('exec_run')).toBeUndefined()
  })
})

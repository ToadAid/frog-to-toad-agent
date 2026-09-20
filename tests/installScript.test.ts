import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

describe('public installer', () => {
  it('is executable, non-root by design, and delegates secrets to onboarding', () => {
    const stat = fs.statSync('install.sh')
    const source = fs.readFileSync('install.sh', 'utf8')

    expect(stat.mode & 0o111).not.toBe(0)
    expect(source).toContain('npm ci')
    expect(source).toContain('exec npm run onboard')
    expect(source).toContain('MIN_NODE_MAJOR=24')
    expect(source).toContain('need_command bwrap')
    expect(source).not.toMatch(/^\s*sudo(?:\s|$)/m)
    expect(source).not.toMatch(/curl[^\n]*\|[^\n]*(?:ba)?sh/)
    expect(source).not.toMatch(/TELEGRAM_BOT_TOKEN|LLM_API_KEY/)
  })

  it('--check validates this checkout without installing or onboarding', () => {
    const result = spawnSync('bash', ['install.sh', '--check'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('prerequisites OK')
    expect(result.stdout).not.toContain('installing the reviewed dependency lock')
  })
})

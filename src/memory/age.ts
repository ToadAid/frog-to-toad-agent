/**
 * Memory staleness (mother-repo port: src/memdir/memoryAge.ts, 53 LOC,
 * zero deps). Models are poor at date arithmetic — a raw ISO timestamp or a
 * bare mtime doesn't trigger staleness reasoning the way "47 days ago" does.
 * A stale memory citing `file:line` reads as MORE authoritative, not less —
 * the freshness note is the counterweight.
 *
 * Desk adaptation: consumers use the plain `memoryFreshnessText()` and wrap
 * it in the desk's own bracket-provenance style ([memory nudge],
 * [after-turn hook]) rather than the mother's <system-reminder> tags.
 */

/** Days elapsed since mtime. Floor-rounded — 0 for today, 1 for yesterday,
 * 2+ for older. Negative inputs (future mtime, clock skew) clamp to 0. */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/** Human-readable age string: 'today' | 'yesterday' | 'N days ago'. */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/** Plain-text staleness caveat for memories >1 day old. Returns '' for
 * fresh (today/yesterday) memories — warning there is noise. */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current state before asserting as fact.`
  )
}
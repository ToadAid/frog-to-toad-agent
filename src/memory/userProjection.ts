import {
  digestCanonicalJson,
  serializeCanonicalJson,
} from './developmentalMemory.js'
import {
  validatePrincipalProvenance,
  type PrincipalProvenance,
  type PrincipalDeclarationType,
} from './principalProvenance.js'

export const USER_PROJECTION_SCHEMA_VERSION = 1 as const
export const USER_PROJECTION_ENTRY_SCHEMA_VERSION = 1 as const

export type UserProjectionDisposition =
  | 'PRINCIPAL_DECLARED'
  | 'UNVERIFIED_WORKING_NOTE'

export interface PrincipalDeclaredUserProjectionEntry {
  readonly schemaVersion: typeof USER_PROJECTION_ENTRY_SCHEMA_VERSION
  readonly disposition: 'PRINCIPAL_DECLARED'
  readonly ordinal: number
  readonly content: string
  readonly provenanceId: string
  readonly declarationType: PrincipalDeclarationType
  readonly authorityGranted: false
}

export interface UnverifiedWorkingNoteProjectionEntry {
  readonly schemaVersion: typeof USER_PROJECTION_ENTRY_SCHEMA_VERSION
  readonly disposition: 'UNVERIFIED_WORKING_NOTE'
  readonly ordinal: number
  readonly content: string
  readonly authorityGranted: false
}

export type UserProjectionEntry =
  | PrincipalDeclaredUserProjectionEntry
  | UnverifiedWorkingNoteProjectionEntry

export interface UserProjection {
  readonly schemaVersion: typeof USER_PROJECTION_SCHEMA_VERSION
  readonly projectionDigestSha256: string
  readonly entries: readonly Readonly<UserProjectionEntry>[]
  readonly authorityGranted: false
}

export interface UserProjectionInput {
  readonly schemaVersion: typeof USER_PROJECTION_SCHEMA_VERSION
  readonly entries: readonly string[]
  readonly provenanceCatalog: readonly unknown[]
  readonly authorityGranted: false
}

export type UserProjectionErrorCode =
  | 'INVALID_PROJECTION_INPUT'
  | 'INVALID_USER_ENTRY'
  | 'INVALID_PROVENANCE_CATALOG'
  | 'DUPLICATE_PROVENANCE'
  | 'AMBIGUOUS_PRINCIPAL_MATCH'
  | 'AUTHORITY_REQUESTED'

export class UserProjectionError extends Error {
  constructor(
    public readonly code: UserProjectionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'UserProjectionError'
  }
}

function fail(code: UserProjectionErrorCode, message: string): never {
  throw new UserProjectionError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function validateInput(value: unknown): asserts value is UserProjectionInput {
  if (
    isRecord(value) &&
    'authorityGranted' in value &&
    value.authorityGranted !== false
  ) {
    return fail('AUTHORITY_REQUESTED', 'USER projection cannot grant authority')
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'entries',
      'provenanceCatalog',
      'authorityGranted',
    ]) ||
    value.schemaVersion !== USER_PROJECTION_SCHEMA_VERSION ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.provenanceCatalog) ||
    value.authorityGranted !== false
  ) {
    return fail('INVALID_PROJECTION_INPUT', 'USER projection input is malformed')
  }

  for (const entry of value.entries) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.trim() !== entry
    ) {
      return fail(
        'INVALID_USER_ENTRY',
        'USER entries must be non-empty canonical parsed strings',
      )
    }
  }
}

function validateCatalog(
  catalog: readonly unknown[],
): readonly Readonly<PrincipalProvenance>[] {
  const validated: Readonly<PrincipalProvenance>[] = []
  const provenanceIds = new Set<string>()

  for (const candidate of catalog) {
    let provenance: Readonly<PrincipalProvenance>
    try {
      provenance = validatePrincipalProvenance(candidate)
    } catch {
      return fail(
        'INVALID_PROVENANCE_CATALOG',
        'every supplied provenance record must satisfy the P3A validator',
      )
    }
    if (provenanceIds.has(provenance.provenanceId)) {
      return fail(
        'DUPLICATE_PROVENANCE',
        'the provenance catalog contains a duplicate provenance identity',
      )
    }
    provenanceIds.add(provenance.provenanceId)
    validated.push(provenance)
  }

  return validated
}

/**
 * Project already-parsed canonical USER.md entries against an explicitly
 * supplied P3A provenance catalog. Matching is exact string equality only.
 * This pure boundary does not authenticate, interpret, normalize, persist, or
 * grant authority.
 */
export function projectUserEntries(
  input: UserProjectionInput | unknown,
): Readonly<UserProjection> {
  validateInput(input)
  const entries = [...input.entries]
  const catalog = validateCatalog(input.provenanceCatalog)
  const principalByContent = new Map<
    string,
    Array<Extract<PrincipalProvenance, { provenanceKind: 'PRINCIPAL_DECLARED' }>>
  >()

  for (const provenance of catalog) {
    if (provenance.provenanceKind !== 'PRINCIPAL_DECLARED') continue
    const matches = principalByContent.get(provenance.content) ?? []
    matches.push(provenance)
    principalByContent.set(provenance.content, matches)
  }

  const projected: UserProjectionEntry[] = entries.map((content, ordinal) => {
    const matches = principalByContent.get(content) ?? []
    if (matches.length > 1) {
      return fail(
        'AMBIGUOUS_PRINCIPAL_MATCH',
        'a USER entry matches more than one principal declaration',
      )
    }
    const match = matches[0]
    if (match === undefined) {
      return {
        schemaVersion: USER_PROJECTION_ENTRY_SCHEMA_VERSION,
        disposition: 'UNVERIFIED_WORKING_NOTE',
        ordinal,
        content,
        authorityGranted: false,
      }
    }
    return {
      schemaVersion: USER_PROJECTION_ENTRY_SCHEMA_VERSION,
      disposition: 'PRINCIPAL_DECLARED',
      ordinal,
      content,
      provenanceId: match.provenanceId,
      declarationType: match.declarationType,
      authorityGranted: false,
    }
  })

  const committed = {
    schemaVersion: USER_PROJECTION_SCHEMA_VERSION,
    entries: projected,
    authorityGranted: false as const,
  }
  return deepFreeze({
    ...clone(committed),
    projectionDigestSha256: digestCanonicalJson(committed),
  }) as Readonly<UserProjection>
}

/** Canonical, deterministic serialization for digest and fixture assertions. */
export function serializeUserProjection(projection: UserProjection): string {
  return serializeCanonicalJson(projection)
}

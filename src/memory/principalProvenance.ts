import {
  digestCanonicalJson,
  isValidDevelopmentalMemoryRevision,
  serializeCanonicalJson,
  type DevelopmentalMemoryRevision,
} from './developmentalMemory.js'

export const PRINCIPAL_PROVENANCE_SCHEMA_VERSION = 1 as const
export const PRINCIPAL_DECLARATION_REFERENCE_SCHEMA_VERSION = 1 as const
export const PRINCIPAL_DECLARATION_RECORD_SCHEMA_VERSION = 1 as const

export const PRINCIPAL_PROVENANCE_KINDS = [
  'PRINCIPAL_DECLARED',
  'EVIDENCE_DERIVED',
] as const

export type PrincipalProvenanceKind =
  typeof PRINCIPAL_PROVENANCE_KINDS[number]

export type PrincipalDeclarationType = 'INSTRUCTION' | 'PREFERENCE'

/**
 * This reference says an upstream boundary authenticated a declaration. This
 * pure module validates and binds the assertion; it does not authenticate a
 * human, account, transport, orchestrator, or runtime caller itself.
 */
export interface PrincipalDeclarationReference {
  readonly schemaVersion:
    typeof PRINCIPAL_DECLARATION_REFERENCE_SCHEMA_VERSION
  readonly source: 'UPSTREAM_AUTHENTICATED_PRINCIPAL_DECLARATION'
  readonly declarationId: string
  readonly principalReference: string
  readonly authenticationRecordId: string
  readonly contentDigestSha256: string
}

export interface PrincipalDeclarationRecord {
  readonly schemaVersion: typeof PRINCIPAL_DECLARATION_RECORD_SCHEMA_VERSION
  readonly declarationId: string
  readonly declarationType: PrincipalDeclarationType
  readonly content: string
  readonly contentDigestSha256: string
  readonly authorityGranted: false
}

export interface PrincipalDeclaredProvenance {
  readonly schemaVersion: typeof PRINCIPAL_PROVENANCE_SCHEMA_VERSION
  readonly provenanceId: string
  readonly provenanceKind: 'PRINCIPAL_DECLARED'
  readonly declarationReference: PrincipalDeclarationReference
  readonly declarationType: PrincipalDeclarationType
  readonly content: string
  readonly contentDigestSha256: string
  readonly trustBoundary:
    'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE'
  readonly authorityGranted: false
}

export interface EvidenceDerivedProvenance {
  readonly schemaVersion: typeof PRINCIPAL_PROVENANCE_SCHEMA_VERSION
  readonly provenanceId: string
  readonly provenanceKind: 'EVIDENCE_DERIVED'
  readonly sourceRevision: DevelopmentalMemoryRevision
  readonly contentDigestSha256: string
  readonly advisoryOnly: true
  readonly principalPolicy: false
  readonly authorityGranted: false
}

export type PrincipalProvenance =
  | PrincipalDeclaredProvenance
  | EvidenceDerivedProvenance

export interface PrincipalDeclaredProvenanceInput {
  readonly schemaVersion: typeof PRINCIPAL_PROVENANCE_SCHEMA_VERSION
  readonly declarationReference: PrincipalDeclarationReference
  readonly declarationRecord: PrincipalDeclarationRecord
  readonly authorityGranted: false
}

export interface EvidenceDerivedProvenanceInput {
  readonly schemaVersion: typeof PRINCIPAL_PROVENANCE_SCHEMA_VERSION
  readonly revision: DevelopmentalMemoryRevision
  readonly authorityGranted: false
}

export type PrincipalProvenanceErrorCode =
  | 'INVALID_PRINCIPAL_DECLARATION'
  | 'INVALID_EVIDENCE_REVISION'
  | 'INVALID_PROVENANCE'
  | 'UNKNOWN_PROVENANCE_KIND'
  | 'CONTENT_DIGEST_MISMATCH'
  | 'PROVENANCE_DIGEST_MISMATCH'
  | 'AUTHORITY_REQUESTED'

export class PrincipalProvenanceError extends Error {
  constructor(
    public readonly code: PrincipalProvenanceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'PrincipalProvenanceError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

function fail(code: PrincipalProvenanceErrorCode, message: string): never {
  throw new PrincipalProvenanceError(code, message)
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

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
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

function rejectAuthority(value: unknown, label: string): void {
  if (
    isRecord(value) &&
    'authorityGranted' in value &&
    value.authorityGranted !== false
  ) {
    return fail('AUTHORITY_REQUESTED', `${label} cannot grant authority`)
  }
}

function declarationContentDigest(
  declarationType: PrincipalDeclarationType,
  content: string,
): string {
  return digestCanonicalJson({ declarationType, content })
}

function evidenceContentDigest(revision: DevelopmentalMemoryRevision): string {
  return digestCanonicalJson({ summary: revision.summary })
}

function validDeclarationReference(
  value: unknown,
): value is PrincipalDeclarationReference {
  return isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'source',
      'declarationId',
      'principalReference',
      'authenticationRecordId',
      'contentDigestSha256',
    ]) &&
    value.schemaVersion === PRINCIPAL_DECLARATION_REFERENCE_SCHEMA_VERSION &&
    value.source === 'UPSTREAM_AUTHENTICATED_PRINCIPAL_DECLARATION' &&
    hasText(value.declarationId) &&
    hasText(value.principalReference) &&
    hasText(value.authenticationRecordId) &&
    isDigest(value.contentDigestSha256)
}

function validDeclarationRecord(
  value: unknown,
): value is PrincipalDeclarationRecord {
  return isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'declarationId',
      'declarationType',
      'content',
      'contentDigestSha256',
      'authorityGranted',
    ]) &&
    value.schemaVersion === PRINCIPAL_DECLARATION_RECORD_SCHEMA_VERSION &&
    hasText(value.declarationId) &&
    (value.declarationType === 'INSTRUCTION' ||
      value.declarationType === 'PREFERENCE') &&
    hasText(value.content) &&
    isDigest(value.contentDigestSha256) &&
    value.authorityGranted === false
}

function provenanceCommitment(
  value: Omit<PrincipalProvenance, 'provenanceId'>,
): string {
  return digestCanonicalJson(value)
}

function makeProvenance<T extends Omit<PrincipalProvenance, 'provenanceId'>>(
  committed: T,
): Readonly<T & { readonly provenanceId: string }> {
  return deepFreeze({
    ...clone(committed),
    provenanceId: provenanceCommitment(committed),
  })
}

/**
 * Bind an upstream-authenticated principal declaration. The upstream reference
 * is required evidence of that trust decision, not authentication performed by
 * this module. A declaration can express policy without statistical maturity,
 * but it grants no execution, trading, tool, approval, or bypass authority.
 */
export function createPrincipalDeclaredProvenance(
  input: PrincipalDeclaredProvenanceInput | unknown,
): Readonly<PrincipalDeclaredProvenance> {
  rejectAuthority(input, 'principal provenance input')
  if (!isRecord(input) || !hasExactKeys(input, [
    'schemaVersion',
    'declarationReference',
    'declarationRecord',
    'authorityGranted',
  ]) || input.schemaVersion !== PRINCIPAL_PROVENANCE_SCHEMA_VERSION ||
    input.authorityGranted !== false) {
    return fail(
      'INVALID_PRINCIPAL_DECLARATION',
      'principal declaration input is malformed',
    )
  }

  rejectAuthority(input.declarationRecord, 'principal declaration record')
  if (
    !validDeclarationReference(input.declarationReference) ||
    !validDeclarationRecord(input.declarationRecord)
  ) {
    return fail(
      'INVALID_PRINCIPAL_DECLARATION',
      'principal declaration reference or record is malformed',
    )
  }

  const reference = input.declarationReference
  const record = input.declarationRecord
  if (reference.declarationId !== record.declarationId) {
    return fail(
      'INVALID_PRINCIPAL_DECLARATION',
      'declaration reference and record identities do not match',
    )
  }
  const digest = declarationContentDigest(record.declarationType, record.content)
  if (
    record.contentDigestSha256 !== digest ||
    reference.contentDigestSha256 !== digest
  ) {
    return fail(
      'CONTENT_DIGEST_MISMATCH',
      'principal declaration content does not match both digest bindings',
    )
  }

  return makeProvenance({
    schemaVersion: PRINCIPAL_PROVENANCE_SCHEMA_VERSION,
    provenanceKind: 'PRINCIPAL_DECLARED',
    declarationReference: reference,
    declarationType: record.declarationType,
    content: record.content,
    contentDigestSha256: digest,
    trustBoundary: 'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE',
    authorityGranted: false,
  }) as Readonly<PrincipalDeclaredProvenance>
}

/**
 * Bind descriptive/advisory provenance to an actual P1 revision. No label,
 * maturity, repetition, storage location, or orchestrator write promotes it to
 * principal policy.
 */
export function createEvidenceDerivedProvenance(
  input: EvidenceDerivedProvenanceInput | unknown,
): Readonly<EvidenceDerivedProvenance> {
  rejectAuthority(input, 'evidence-derived provenance input')
  if (!isRecord(input) || !hasExactKeys(input, [
    'schemaVersion',
    'revision',
    'authorityGranted',
  ]) || input.schemaVersion !== PRINCIPAL_PROVENANCE_SCHEMA_VERSION ||
    input.authorityGranted !== false) {
    return fail(
      'INVALID_EVIDENCE_REVISION',
      'evidence-derived provenance input is malformed',
    )
  }

  rejectAuthority(input.revision, 'P1 revision')
  if (!isValidDevelopmentalMemoryRevision(input.revision)) {
    return fail(
      'INVALID_EVIDENCE_REVISION',
      'source revision does not satisfy the complete P1 revision law',
    )
  }

  return makeProvenance({
    schemaVersion: PRINCIPAL_PROVENANCE_SCHEMA_VERSION,
    provenanceKind: 'EVIDENCE_DERIVED',
    sourceRevision: input.revision,
    contentDigestSha256: evidenceContentDigest(input.revision),
    advisoryOnly: true,
    principalPolicy: false,
    authorityGranted: false,
  }) as Readonly<EvidenceDerivedProvenance>
}

function validatePrincipalVariant(
  value: Record<string, unknown>,
): boolean {
  if (!hasExactKeys(value, [
    'schemaVersion',
    'provenanceId',
    'provenanceKind',
    'declarationReference',
    'declarationType',
    'content',
    'contentDigestSha256',
    'trustBoundary',
    'authorityGranted',
  ]) || !validDeclarationReference(value.declarationReference) ||
    (value.declarationType !== 'INSTRUCTION' &&
      value.declarationType !== 'PREFERENCE') ||
    !hasText(value.content) ||
    !isDigest(value.contentDigestSha256) ||
    value.trustBoundary !==
      'UPSTREAM_AUTHENTICATION_REQUIRED_NOT_PERFORMED_HERE') {
    return false
  }

  const reference = value.declarationReference
  return value.contentDigestSha256 === reference.contentDigestSha256 &&
    value.contentDigestSha256 === declarationContentDigest(
      value.declarationType,
      value.content,
    )
}

function validateEvidenceVariant(
  value: Record<string, unknown>,
): boolean {
  return hasExactKeys(value, [
    'schemaVersion',
    'provenanceId',
    'provenanceKind',
    'sourceRevision',
    'contentDigestSha256',
    'advisoryOnly',
    'principalPolicy',
    'authorityGranted',
  ]) &&
    isValidDevelopmentalMemoryRevision(value.sourceRevision) &&
    isDigest(value.contentDigestSha256) &&
    value.contentDigestSha256 === evidenceContentDigest(value.sourceRevision) &&
    value.advisoryOnly === true &&
    value.principalPolicy === false
}

/** Validate a serialized projection and freeze a clone, never caller bytes. */
export function validatePrincipalProvenance(
  value: unknown,
): Readonly<PrincipalProvenance> {
  rejectAuthority(value, 'principal provenance')
  if (
    !isRecord(value) ||
    value.schemaVersion !== PRINCIPAL_PROVENANCE_SCHEMA_VERSION ||
    !isDigest(value.provenanceId) ||
    value.authorityGranted !== false
  ) {
    return fail('INVALID_PROVENANCE', 'principal provenance is malformed')
  }
  if (
    value.provenanceKind !== 'PRINCIPAL_DECLARED' &&
    value.provenanceKind !== 'EVIDENCE_DERIVED'
  ) {
    return fail('UNKNOWN_PROVENANCE_KIND', 'provenance kind is not supported')
  }

  const valid = value.provenanceKind === 'PRINCIPAL_DECLARED'
    ? validatePrincipalVariant(value)
    : validateEvidenceVariant(value)
  if (!valid) {
    return fail(
      'INVALID_PROVENANCE',
      'provenance fields, source binding, or content digest are invalid',
    )
  }

  const { provenanceId, ...committed } = value as unknown as PrincipalProvenance
  if (provenanceCommitment(committed) !== provenanceId) {
    return fail(
      'PROVENANCE_DIGEST_MISMATCH',
      'provenance commitment does not match its content',
    )
  }
  return deepFreeze(clone(value)) as Readonly<PrincipalProvenance>
}

/** Canonical serialization retains the discriminant and validates first. */
export function serializePrincipalProvenance(value: unknown): string {
  return serializeCanonicalJson(validatePrincipalProvenance(value))
}

import { z } from 'zod'

export const PERPS_MARKET_SCHEMA_VERSION = 1 as const

export const provenanceSchema = z.object({
  provider: z.string().min(1),
  endpoint: z.string().url(),
  supportingEndpoints: z.array(z.string().url()).min(1).optional(),
  requestType: z.enum(['MARKET_SNAPSHOT', 'FUNDING_HISTORY']),
}).strict()

export const freshnessSchema = z.object({
  state: z.enum(['FRESH', 'STALE']),
  ageMs: z.number().int().nonnegative(),
  maxAgeMs: z.number().int().positive(),
}).strict()

export const perpsMarketSnapshotSchema = z.object({
  schemaVersion: z.literal(PERPS_MARKET_SCHEMA_VERSION),
  instrument: z.string().regex(/^[A-Z0-9][A-Z0-9:._-]*-PERP$/),
  observedAt: z.number().int().nonnegative(),
  observationTimeSource: z.enum(['PROVIDER', 'RECEIPT']),
  receivedAt: z.number().int().nonnegative(),
  retrievedAt: z.number().int().nonnegative(),
  markPrice: z.number().finite().positive(),
  referencePrice: z.object({
    kind: z.enum(['INDEX', 'ORACLE']),
    value: z.number().finite().positive(),
  }).strict(),
  venueMidPrice: z.number().finite().positive().optional(),
  basis: z.object({
    definition: z.literal('MARK_MINUS_REFERENCE'),
    absolute: z.number().finite(),
    ratio: z.number().finite(),
    ratioUnit: z.literal('DECIMAL_FRACTION'),
  }).strict(),
  funding: z.object({
    rate: z.number().finite(),
    rateUnit: z.literal('DECIMAL_RATE_PER_INTERVAL'),
    intervalHours: z.number().int().positive().optional(),
    nextFundingAt: z.number().int().nonnegative().optional(),
  }).strict(),
  openInterest: z.object({
    value: z.number().finite().nonnegative(),
    unit: z.enum(['BASE_ASSET', 'PROVIDER_NATIVE_UNSPECIFIED']),
  }).strict(),
  provenance: provenanceSchema,
  freshness: freshnessSchema,
}).strict()

export type PerpsMarketSnapshot = z.infer<typeof perpsMarketSnapshotSchema>

export function calculateFreshness(
  observedAt: number,
  retrievedAt: number,
  maxAgeMs: number,
): PerpsMarketSnapshot['freshness'] {
  if (
    ![observedAt, retrievedAt, maxAgeMs].every(Number.isFinite) ||
    observedAt < 0 ||
    retrievedAt < observedAt ||
    maxAgeMs <= 0
  ) {
    throw new Error('freshness timestamps and maximum age are invalid')
  }
  const ageMs = retrievedAt - observedAt
  return {
    state: ageMs <= maxAgeMs ? 'FRESH' : 'STALE',
    ageMs,
    maxAgeMs,
  }
}

export type PerpsSetup = 'A' | 'B' | 'NONE'
export type PerpsDirection = 'LONG' | 'SHORT' | 'FLAT'

import { z } from 'zod'
import type { ToolDef } from '../types.js'

/**
 * Convert a Zod schema to a provider JSON schema, inlining any $ref (GLM and
 * several OpenAI-compatible endpoints choke on $ref / strict-mode schemas).
 * Throws at registration time if a ref can't be inlined — fail fast, not at 3am.
 */
export function zodToParameters(shape: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(shape, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >
  const inlined = inlineRefs(json)
  delete inlined['$schema']
  return inlined
}

function inlineRefs(node: unknown, root?: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const r = root ?? (node as Record<string, unknown>)
  if (depth > 20) throw new Error('tool schema: $ref nesting too deep')
  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, r, depth + 1)) as unknown as Record<string, unknown>
  }
  if (node === null || typeof node !== 'object') {
    return node as Record<string, unknown>
  }
  const obj = node as Record<string, unknown>
  if (typeof obj['$ref'] === 'string') {
    const refPath = obj['$ref']
    const resolved = resolveRef(r, refPath)
    if (!resolved) throw new Error(`tool schema: unresolved $ref ${refPath}`)
    return inlineRefs(resolved, r, depth + 1)
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    out[key] = inlineRefs(value, r, depth + 1)
  }
  return out
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let cur: unknown = root
  for (const seg of ref.slice(2).split('/')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  return cur
}

export function toToolDef(name: string, description: string, input: z.ZodType): ToolDef {
  return {
    type: 'function',
    function: { name, description, parameters: zodToParameters(input) },
  }
}
import { z } from 'zod'
import { deskRoot } from '../config.js'
import { exploreRepoCode, inspectRepoEyes } from '../repoEyes.js'
import { defineTool } from './registry.js'

export const repoEyesStatusTool = defineTool({
  name: 'repo_eyes_status',
  description: 'Read-only local CodeGraph and Git checkout status. Reports graph availability and HEAD relation to the last fetched origin/main; grants no authority.',
  danger: 'readonly',
  input: z.object({}).strict(),
  execute: async () => {
    const status = inspectRepoEyes(deskRoot())
    const text = [
      `Repo HEAD: ${status.repoHead}`,
      `Repo tree: ${status.repoTree}`,
      `Origin/main: ${status.originMain ?? 'unavailable'}`,
      `Relation: ${status.relation}`,
      `CodeGraph: ${status.graphState} (expected ${status.expectedCodegraphVersion}${status.observedCodegraphVersion ? `, observed ${status.observedCodegraphVersion}` : ''})`,
      'Graph-to-HEAD identity: unavailable from CodeGraph; no graphForHead is inferred.',
      'Authority: NONE — repository observations cannot approve or execute trades.',
    ]
    if (status.detail) text.push(`Detail: ${status.detail}`)
    return { text: text.join('\n'), data: status }
  },
})

export const repoCodeExploreTool = defineTool({
  name: 'repo_code_explore',
  description: 'Query the pinned local CodeGraph index for code structure and call paths. Read-only, repository-only, and non-authoritative.',
  danger: 'readonly',
  input: z.object({ query: z.string().trim().min(1).max(500) }).strict(),
  execute: async ({ query }) => {
    const result = exploreRepoCode(deskRoot(), query)
    return {
      text: result.ok
        ? `${result.text}\n\n[repo eyes: READONLY · authority NONE · never market/trade evidence]`
        : `[degraded] ${result.text}`,
      data: { available: result.ok, authorityGranted: false },
    }
  },
})

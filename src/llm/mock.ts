import type { ChatMessage, ToolDef } from '../types.js'
import type { CompleteResult, LlmClient } from './client.js'

export type MockTurn =
  | { text: string }
  | { toolCalls: Array<{ id: string; name: string; arguments: string }> }

/**
 * Scripted LLM provider for tests — feeds turns through the REAL agentLoop with
 * no network and no keys. Deterministic; throws when the script runs dry so
 * tests fail loudly instead of looping.
 */
export function createMockLlmClient(script: MockTurn[], model = 'mock-1'): LlmClient {
  let i = 0
  return {
    model,
    async complete({
      messages,
    }: {
      messages: ChatMessage[]
      tools: ToolDef[]
      signal?: AbortSignal
    }): Promise<CompleteResult> {
      const turn = script[i]
      i++
      if (!turn) {
        throw new Error(`mock LLM: script exhausted after ${i - 1} turns`)
      }
      if ('toolCalls' in turn) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: turn.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
          usage: { in: 10, out: 10 },
        }
      }
      return {
        message: { role: 'assistant', content: turn.text },
        usage: { in: 10, out: 10 },
      }
    },
  }
}
import { describe, it, expect } from 'vitest'
import { buildChatRequest, buildResponsesRequest, parseResponsesResponse } from '../src/llm/client.js'
import type { Config } from '../src/config.js'
import type { ChatMessage, ToolDef } from '../src/types.js'

function codexCfg(): Config {
  return {
    brain: 'glm',
    dryRun: true,
    executionMode: 'none',
    llm: {
      provider: 'codex',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.3-codex',
      apiKey: 'sk-test',
      temperature: 0.3,
      maxTokens: 1024,
    },
    telegram: { botToken: 'x', adminChatId: 1, allowedChatIds: [], progressDrafts: true },
    limits: {
      perTradeUsdMax: 50,
      dailyUsdMax: 200,
      maxOpenPositions: 10,
      approvalTimeoutSec: 120,
      approvalMaxPending: 3,
      approvalMinIntervalSec: 5,
      tokenAllowlist: [],
      blockedSymbols: [],
      blockedAddresses: [],
    },
    guardedTools: ['swap_execute'],
    mcp: { command: undefined, args: [], allowedTools: [], swapTool: 'swap', envFile: undefined },
    lessonsSampleMin: 5,
    memoryNudgeInterval: 10,
    briefCron: '47 8 * * *',
    sentinelCron: '19 */2 * * *',
    watchdogCron: '37 */2 * * *',
    sentinelMovePct: 5,
    paths: { dataDir: '/tmp', agentsDir: '/tmp', skillsDir: '/tmp', assetsDir: '/tmp' },
    statusPort: 8787,
    selftest: true,
    timezone: "America/New_York",
  }
}

const swapTool: ToolDef = {
  type: 'function',
  function: {
    name: 'swap_quote',
    description: 'quote a swap',
    parameters: { type: 'object', properties: { from: { type: 'string' } } },
  },
}

describe('Responses API wire format (Codex models)', () => {
  it('maps system→instructions, tool results→function_call_output, tools→flat defs', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'you are a desk' },
      { role: 'user', content: 'quote ETH' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'swap_quote', arguments: '{"from":"ETH"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'price 2400' },
    ]
    const { url, body } = buildResponsesRequest(codexCfg(), messages, [swapTool])
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(body['instructions']).toBe('you are a desk')
    expect(body['model']).toBe('gpt-5.3-codex')
    const input = body['input'] as Array<Record<string, unknown>>
    expect(input[0]).toEqual({ role: 'user', content: 'quote ETH' })
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'swap_quote' })
    expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'price 2400' })
    expect(body['tools']).toEqual([
      { type: 'function', name: 'swap_quote', description: 'quote a swap', parameters: expect.anything() },
    ])
  })

  it('parses output_text and function_call items back into one assistant message', () => {
    const result = parseResponsesResponse({
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'r1' },
        { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'ETH is at ' }] },
        { type: 'message', id: 'm2', content: [{ type: 'output_text', text: '$2400' }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    expect(result.message.content).toBe('ETH is at $2400')
    expect(result.message.tool_calls).toBeUndefined()
    expect(result.usage).toEqual({ in: 10, out: 5 })
  })

  it('parses function_call items into tool_calls with call_id preserved', () => {
    const result = parseResponsesResponse({
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call_9', name: 'swap_execute', arguments: '{"from":"USDC"}' },
      ],
    })
    expect(result.message.content).toBeNull()
    expect(result.message.tool_calls).toEqual([
      {
        id: 'call_9',
        type: 'function',
        function: { name: 'swap_execute', arguments: '{"from":"USDC"}' },
      },
    ])
  })

  it('surfaces API errors instead of returning an empty message', () => {
    expect(() => parseResponsesResponse({ error: { message: 'bad key' } })).toThrow('bad key')
    expect(() => parseResponsesResponse({ status: 'completed', output: [] })).toThrow(
      'no output items',
    )
  })
})
describe('vision wire format (user images)', () => {
  const dataUri = 'data:image/png;base64,AAAA'

  it('chat wire: user images explode to OpenAI content parts, text-first', () => {
    const cfg = codexCfg()
    const { body } = buildChatRequest(cfg, [{ role: 'user', content: 'what is this?', images: [dataUri] }], [])
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[0]?.['role']).toBe('user')
    const parts = messages[0]!['content'] as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: dataUri } })
  })

  it('chat wire: text-only user messages stay plain strings (no parts wrapper)', () => {
    const cfg = codexCfg()
    const { body } = buildChatRequest(cfg, [{ role: 'user', content: 'quote ETH' }], [])
    const messages = body['messages'] as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'user', content: 'quote ETH' })
  })

  it('Responses wire: user images become input_image parts', () => {
    const { body } = buildResponsesRequest(
      codexCfg(),
      [{ role: 'user', content: 'what is this?', images: [dataUri] }],
      [],
    )
    const input = body['input'] as Array<Record<string, unknown>>
    expect(input[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: dataUri },
      ],
    })
  })
})

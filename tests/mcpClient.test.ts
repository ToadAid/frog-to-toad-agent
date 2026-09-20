import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { McpClient } from '../src/mcp/client.js'

const HERE = import.meta.dirname
const SERVER = join(HERE, 'helpers', 'mockMcpServer.mjs')
const SERVER_DIE = join(HERE, 'helpers', 'mockMcpServerDie.mjs')

describe('McpClient — stdio JSON-RPC without an SDK', () => {
  it('handshakes, lists tools, and calls one', async () => {
    const c = new McpClient({ command: process.execPath, args: [SERVER] })
    await c.start()
    try {
      const tools = await c.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fling', 'slow_echo', 'swap'])
      expect((c.server as { name?: string }).name).toBe('mock-mcp')

      const res = await c.callTool('echo', { hello: 'desk' })
      expect(res.isError).toBe(false)
      expect(res.text).toBe('echo:{"hello":"desk"}')
    } finally {
      await c.stop()
    }
  })

  it('surfaces JSON-RPC errors as rejections', async () => {
    const c = new McpClient({ command: process.execPath, args: [SERVER] })
    await c.start()
    try {
      await expect(c.callTool('fling', {})).rejects.toThrow('flung')
    } finally {
      await c.stop()
    }
  })

  it('times out a request that never gets a response', async () => {
    const c = new McpClient({ command: process.execPath, args: [SERVER, 'silent'], requestTimeoutMs: 300 })
    await c.start()
    try {
      await expect(c.callTool('echo', {})).rejects.toThrow(/timed out/)
    } finally {
      await c.stop()
    }
  })

  it('rejects pending requests when the server dies', async () => {
    const c = new McpClient({ command: process.execPath, args: [SERVER, 'silent'], requestTimeoutMs: 60_000 })
    await c.start()
    const assertion = expect(c.callTool('echo', {})).rejects.toThrow(/stopped/)
    await c.stop()
    await assertion
    // A call after stop fails cleanly, no hang.
    await expect(c.callTool('echo', {})).rejects.toThrow(/not running/)
  })

  it('rejects in-flight requests when the server crashes mid-conversation', async () => {
    const c = new McpClient({ command: process.execPath, args: [SERVER_DIE], requestTimeoutMs: 60_000 })
    await c.start()
    const p = c.callTool('echo', {}) // server never answers, then exits
    await expect(p).rejects.toThrow(/exited/)
  })
})
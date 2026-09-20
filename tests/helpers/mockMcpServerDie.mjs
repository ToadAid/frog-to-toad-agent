// MCP server that completes the handshake and then exits WITHOUT answering
// any tools/call — used to test in-flight request rejection on crash.
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (typeof msg.id !== 'number') return
  if (msg.method === 'initialize') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'die-mcp', version: '0.1.0' },
        },
      }) + '\n',
    )
    // Answer nothing to tools/call; exit shortly after so the client sees it.
    setTimeout(() => process.exit(2), 150)
  }
})
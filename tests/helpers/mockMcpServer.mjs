// Tiny MCP stdio server used by tests. Speaks newline-delimited JSON-RPC 2.0.
// Behaviors:
//   - `initialize` → serverInfo echo
//   - `tools/list` → [echo, slow_echo, fling]
//   - `tools/call echo`   → responds immediately with the args echoed
//   - `tools/call slow_echo` → sleeps `ms` (default 10s) before responding
//   - `tools/call fling`  → responds with a JSON-RPC error
// Mode flag argv[2] === 'silent' → never responds to tools/call (timeout tests).
// argv[2] === 'die' → exits after initialize (crash handling tests).

import readline from 'node:readline'

const mode = process.argv[2] ?? ''
let serverInfo = { name: 'mock-mcp', version: '0.1.0' }

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (typeof msg.id !== 'number') return
  switch (msg.method) {
    case 'initialize':
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo,
      })
      break
    case 'tools/list':
      respond(msg.id, {
        tools: [
          { name: 'echo', description: 'echo args', inputSchema: { type: 'object' } },
          { name: 'slow_echo', description: 'echo after a delay', inputSchema: { type: 'object' } },
          { name: 'fling', description: 'always errors', inputSchema: { type: 'object' } },
          { name: 'swap', description: 'fake trade tool', inputSchema: { type: 'object' } },
        ],
      })
      break
    case 'tools/call': {
      const { name, arguments: args } = msg.params ?? {}
      if (mode === 'silent') return // never respond → client timeout
      if (name === 'echo') {
        respond(msg.id, { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] })
      } else if (name === 'swap') {
        respond(msg.id, { content: [{ type: 'text', text: `traded:${JSON.stringify(args)}` }] })
      } else if (name === 'slow_echo') {
        const ms = Number(args?.ms ?? 10_000)
        setTimeout(() => respond(msg.id, { content: [{ type: 'text', text: 'late' }] }), ms)
      } else if (name === 'fling') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'flung' } })
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } })
      }
      break
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
  }
})

process.on('SIGTERM', () => process.exit(0))
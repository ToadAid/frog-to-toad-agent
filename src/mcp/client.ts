import { spawn, type ChildProcess } from 'node:child_process'
import { log } from '../log.js'

/**
 * Minimal MCP (Model Context Protocol) stdio client — no SDK, ~180 lines.
 * Speaks the two things the desk needs: `tools/list` and `tools/call`, over
 * newline-delimited JSON-RPC 2.0 on a child process's stdio. This keeps any
 * signer (e.g. Coinbase CDP/AgentKit) OUT of this process — the desk holds no
 * keys, ever; the server does.
 */

export type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: unknown
}

export type McpToolResult = {
  isError: boolean
  text: string
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type McpClientOptions = {
  command: string
  args?: string[]
  env?: Record<string, string>
  requestTimeoutMs?: number
}

const INIT_TIMEOUT_MS = 15_000

export class McpClient {
  private proc: ChildProcess | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private serverInfo: unknown
  private stderrTail: string[] = []

  constructor(private opts: McpClientOptions) {}

  private get timeoutMs(): number {
    return this.opts.requestTimeoutMs ?? 30_000
  }

  /** Spawn the server and complete the initialize handshake. */
  async start(): Promise<void> {
    if (this.proc) throw new Error('MCP client already started')
    const proc = spawn(this.opts.command, this.opts.args ?? [], {
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc

    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => this.onData(chunk))
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (chunk: string) => {
      // Keep a small tail for honest errors — server logs never flood ours.
      this.stderrTail.push(chunk)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
    })
    proc.on('error', (err) => this.rejectAll(new Error(`MCP server process error: ${err.message}`)))
    proc.on('exit', (code) => {
      this.proc = undefined
      this.rejectAll(new Error(`MCP server exited (code ${code ?? '?'})${this.stderrHint()}`))
    })

    const res = (await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'frog-to-toad-agent', version: '0.1.0' },
    }, INIT_TIMEOUT_MS)) as { serverInfo?: unknown }

    this.serverInfo = (res as { serverInfo?: unknown }).serverInfo
    // Initialized notification — no id, no response expected.
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  get server(): unknown {
    return this.serverInfo
  }

  private stderrHint(): string {
    const all = this.stderrTail.join('').trim()
    if (!all) return ''
    // Error messages lead stderr; stack traces fill the tail — keep both ends.
    const head = all.split('\n')[0] ?? ''
    return ` — server stderr: ${head.slice(0, 200)}${all.length > 200 ? ` … ${all.slice(-120)}` : ''}`
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] }
    return res.tools ?? []
  }

  /** Call a tool; returns flattened text content. isError surfaces honestly. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      isError?: boolean
      content?: Array<{ type?: string; text?: string }>
    }
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text' || typeof c.text === 'string')
      .map((c) => c.text ?? '')
      .join('\n')
    return { isError: res.isError === true, text }
  }

  async stop(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    this.rejectAll(new Error('MCP client stopped'))
    if (!proc) return
    proc.stdin?.end()
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    proc.kill('SIGTERM')
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000))])
    if (!proc.killed || proc.exitCode === null) proc.kill('SIGKILL')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line === '') continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        log.debug(`mcp: dropping non-JSON line: ${line.slice(0, 120)}`)
        continue
      }
      if (typeof msg.id !== 'number') continue // notification — nothing pending
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`MCP error: ${msg.error.message ?? 'unknown'}`))
      else p.resolve(msg.result)
    }
  }

  private send(msg: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  private request(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error(`MCP server not running (${method})${this.stderrHint()}`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }
}

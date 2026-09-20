import fs from 'node:fs'
import path from 'node:path'
import { deskRoot } from './config.js'

type Level = 'debug' | 'info' | 'warn' | 'error'
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const minLevel: number =
  LEVELS[(process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? LEVELS['info']!

let logFile: string | undefined

function ensureLogFile(): string | undefined {
  if (logFile !== undefined) return logFile
  try {
    const dir = path.join(deskRoot(), 'data')
    fs.mkdirSync(dir, { recursive: true })
    logFile = path.join(dir, 'debug.log')
  } catch {
    logFile = undefined
  }
  return logFile
}

function write(level: Level, msg: string): void {
  if (LEVELS[level] < minLevel) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`
  // eslint-disable-next-line no-console
  console.error(line)
  const file = ensureLogFile()
  if (file) {
    try {
      fs.appendFileSync(file, line + '\n')
    } catch {
      /* logging must never crash the daemon */
    }
  }
}

export const log = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
}
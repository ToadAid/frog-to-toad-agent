import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { readJournal } from '../tools/journal.js'
import { signalAccuracy, recentGrades } from '../market/signalGrader.js'
import { readForecasts, forecastAccuracy } from '../market/forecastGrader.js'
import { fetchFearGreed } from '../market/sentiment.js'
import { fetchNews, type NewsItem } from '../market/news.js'
import { fetchTopChains, fetchStablecoins } from '../market/onchain.js'
import { loadDeskState, type DeskStateRecord } from '../safety/deskState.js'
import { readDoctorState, handsGateOpen } from '../doctor/doctor.js'
import { COINGECKO_IDS } from '../market/feeds.js'

/**
 * Read-only view builders for the dashboard's tabbed workbench (§12.9).
 * EVERY function here is safe to serve on the local status server: no secrets
 * (keys never leave config), caps on everything (rows, chars), and every
 * external fetch is guarded — a dead feed degrades its own panel, never the
 * whole endpoint. The dashboard renders; this file decides what it may see.
 */

const CHARS_CAP = 2_000 // per-message transcript cap (tool results can be huge)
const ROWS_CAP = 20

// ── Chat tab: transcript read-back ──────────────────────────────────────────

export type TranscriptMessage = {
  ts: number
  role: string
  /** Plain text; tool results truncated to CHARS_CAP. */
  content: string
  /** Assistant tool-call names (the "frog is working" trace). */
  tools?: string[]
  imageCount?: number
}

export type ThreadsView = {
  /** All chats with transcripts, admin first. */
  chats: Array<{ chatId: number; messages: number; isAdmin: boolean }>
  /** The requested chat's tail (newest last), capped. */
  chatId: number
  messages: TranscriptMessage[]
}

/** Chat ids that have transcripts, admin chat first. */
export function listTranscriptChats(cfg: Config): Array<{ chatId: number; messages: number; isAdmin: boolean }> {
  const dir = path.join(cfg.paths.dataDir, 'transcript')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const chats = files.map((f) => {
    const chatId = Number(f.replace('.jsonl', ''))
    let lines = 0
    try {
      lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim() !== '').length
    } catch {
      /* unreadable counts as empty */
    }
    return { chatId, messages: lines, isAdmin: chatId === cfg.telegram.adminChatId }
  }).filter((c) => Number.isFinite(c.chatId))
  return chats.sort((a, b) => (a.isAdmin === b.isAdmin ? b.messages - a.messages : a.isAdmin ? -1 : 1))
}

/** One chat's transcript tail (newest LAST so the UI appends in order). */
export function threadMessages(cfg: Config, chatId: number): TranscriptMessage[] {
  const file = path.join(cfg.paths.dataDir, 'transcript', `${chatId}.jsonl`)
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  } catch {
    return []
  }
  const out: TranscriptMessage[] = []
  for (const line of lines.slice(-ROWS_CAP * 4)) {
    try {
      const rec = JSON.parse(line) as { ts?: number; message?: { role?: string; content?: unknown; images?: unknown[] }; tool?: string }
      const m = rec.message
      if (!m) continue // transcript notes (approval cards etc.) are not chat turns
      const role = m.role ?? 'system'
      let content = ''
      if (typeof m.content === 'string') content = m.content
      else if (m.content === null) content = ''
      else content = JSON.stringify(m.content)
      const tools =
        role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)
          ? (m as { tool_calls: Array<{ function?: { name?: string } }> }).tool_calls
              .map((tc) => tc.function?.name ?? 'tool')
          : undefined
      out.push({
        ts: rec.ts ?? Date.now(),
        role,
        content: content.length > CHARS_CAP ? content.slice(0, CHARS_CAP) + ` …(+${content.length - CHARS_CAP} chars)` : content,
        tools: tools && tools.length > 0 ? tools : undefined,
        imageCount: Array.isArray(m.images) && m.images.length > 0 ? m.images.length : undefined,
      })
    } catch {
      /* skip corrupt */
    }
  }
  return out.slice(-ROWS_CAP * 2)
}

export function threadsView(cfg: Config, requested?: number): ThreadsView {
  const chats = listTranscriptChats(cfg)
  const chatId = requested ?? cfg.telegram.adminChatId ?? chats[0]?.chatId ?? 0
  return { chats: chats.slice(-ROWS_CAP), chatId, messages: Number.isFinite(chatId) ? threadMessages(cfg, chatId) : [] }
}

// ── Research tab: signals, journal, news, sentiment, onchain ────────────────

export type ResearchView = {
  taSignals: ReturnType<typeof signalAccuracy>
  recentGrades: ReturnType<typeof recentGrades>
  journal: ReturnType<typeof readJournal>
  lessons: string | null
  fng: Awaited<ReturnType<typeof fetchFearGreed>> | undefined
  news: NewsItem[]
  topChains: Awaited<ReturnType<typeof fetchTopChains>> | []
  stablecoins: Awaited<ReturnType<typeof fetchStablecoins>> | undefined
}

async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export async function researchView(cfg: Config): Promise<ResearchView> {
  let lessons: string | null = null
  try {
    const raw = fs.readFileSync(path.join(cfg.paths.dataDir, 'lessons', 'lessons.md'), 'utf8')
    lessons = raw.length > 24_000 ? raw.slice(0, 24_000) + ' …(truncated)' : raw
  } catch {
    /* no lessons yet */
  }
  return {
    taSignals: signalAccuracy(cfg),
    recentGrades: recentGrades(cfg, ROWS_CAP),
    journal: readJournal(cfg).slice(-ROWS_CAP).reverse(),
    lessons,
    fng: await safe(fetchFearGreed, undefined),
    news: await safe(() => fetchNews(8), []),
    topChains: await safe(() => fetchTopChains(6), []),
    stablecoins: await safe(fetchStablecoins, undefined),
  }
}

// ── Kronos tab: forecast records + accuracy + lane liveness ─────────────────

export type KronosView = {
  records: ReturnType<typeof readForecasts>
  accuracy: ReturnType<typeof forecastAccuracy>
  majors: string[]
  laneReady: boolean
}

export function kronosView(cfg: Config): KronosView {
  let laneReady = false
  try {
    laneReady = fs.existsSync(process.env.KRONOS_COMMAND ?? path.join(process.cwd(), 'kronos-server', 'run.sh'))
  } catch {
    /* default false */
  }
  return {
    records: readForecasts(cfg).slice(-ROWS_CAP).reverse(),
    accuracy: forecastAccuracy(cfg),
    majors: Object.keys(COINGECKO_IDS),
    laneReady,
  }
}

// ── Settings tab: read-only config + state, HALT/RESUME live in http.ts ─────

export type SettingsView = {
  dryRun: boolean
  executionMode: string
  brain: string
  provider?: string
  model: string
  baseUrl?: string
  limits: { perTradeUsdMax: number; dailyUsdMax: number; approvalTimeoutSec: number }
  timezone: string
  adminConfigured: boolean
  doctor: { cheapOk: boolean; lastRunTs?: number; lastTestGreenAt?: number; handsOpen: boolean }
  deskState: DeskStateRecord
  statusPort: number
}

export function settingsView(cfg: Config): SettingsView {
  const doctorState = readDoctorState(cfg)
  return {
    dryRun: cfg.dryRun,
    executionMode: cfg.executionMode,
    brain: cfg.brain,
    provider: cfg.llm.provider,
    model: cfg.llm.model,
    baseUrl: cfg.llm.baseUrl,
    limits: {
      perTradeUsdMax: cfg.limits.perTradeUsdMax,
      dailyUsdMax: cfg.limits.dailyUsdMax,
      approvalTimeoutSec: cfg.limits.approvalTimeoutSec,
    },
    timezone: cfg.timezone,
    adminConfigured: cfg.telegram.adminChatId !== undefined,
    doctor: {
      cheapOk: doctorState?.cheapOk === true,
      lastRunTs: doctorState?.lastRunTs,
      lastTestGreenAt: doctorState?.lastTestGreenAt,
      handsOpen: handsGateOpen(cfg),
    },
    deskState: loadDeskState(cfg),
    statusPort: cfg.statusPort,
  }
}
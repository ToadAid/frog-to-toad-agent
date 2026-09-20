import { loadConfig, describeConfig } from './config.js'
import { log } from './log.js'
import { setDeskState } from './safety/deskState.js'
import path from 'node:path'

async function selftest(): Promise<void> {
  const cfg = loadConfig()
  console.log(describeConfig(cfg))

  // Data dirs
  const fs = await import('node:fs')
  for (const dir of [
    cfg.paths.dataDir,
    `${cfg.paths.dataDir}/memory`,
    `${cfg.paths.dataDir}/workspace`,
    `${cfg.paths.dataDir}/lessons`,
    `${cfg.paths.dataDir}/transcript`,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // Seed the continuity stores with format hints on first boot only — the
  // orchestrator grows them from there (USER.md / DESK.md, §-delimited).
  const seedIfMissing = (file: string, body: string) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, body)
  }
  seedIfMissing(
    `${cfg.paths.dataDir}/workspace/USER.md`,
    `Everything below is what the desk has learned about the PRINCIPAL. '§' separates entries.\n§\n(empty — the orchestrator fills this as it learns the principal's style, risk appetite, and standing instructions)\n`,
  )
  seedIfMissing(
    `${cfg.paths.dataDir}/workspace/DESK.md`,
    `Desk-level facts every agent should know. '§' separates entries.\n§\n(empty — any agent can add durable facts here: feed quirks, provider behavior, recurring patterns)\n`,
  )
  console.log(`data dirs ready under ${cfg.paths.dataDir}`)

  // Safety invariant check
  console.log(
    cfg.dryRun
      ? 'SAFETY: dry-run active — no orders will ever be signed.'
      : 'SAFETY: WARNING — dry-run is OFF.',
  )
  console.log('selftest OK')
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest') || process.env.SELFTEST === '1') {
    await selftest()
    return
  }

  const cfg = loadConfig()
  log.info(
    cfg.brain === 'codex'
      ? `boot: brain=codex model=${cfg.llm.model} (ChatGPT keyfile lane), dryRun=${cfg.dryRun}`
      : `boot: ${cfg.llm.model} @ ${cfg.llm.baseUrl}, dryRun=${cfg.dryRun}`,
  )

  // D1-P8: before any tool or wallet lane can trade, classify durable live
  // execution evidence. An unresolved "prepared" attempt means the previous
  // process may have moved funds without proving local accounting completed.
  // Never infer or replay that outcome — fail CLOSED to HALTED.
  const { enforceLiveExecutionJournalAtBoot } = await import(
    './safety/liveExecutionJournal.js'
  )
  const liveExecutionJournal = enforceLiveExecutionJournalAtBoot(cfg)
  if (liveExecutionJournal.halted) {
    log.warn(
      `[live-execution] unresolved/invalid durable execution evidence — desk HALTED: ` +
        `${liveExecutionJournal.reason ?? 'unknown live execution ambiguity'}`,
    )
  }

  // Rotating state backups (Nautilus cache-snapshot steal): ledger + desk
  // state keep their last generations under data/backups/ BEFORE anything
  // can write — a bad write can never take the desk's memory unrecoverably.
  try {
    const { rotateStateBackups } = await import('./store/backup.js')
    const kept = rotateStateBackups(cfg)
    if (kept.length > 0) log.info(`state backups rotated: ${kept.map((p) => path.basename(p)).join(', ')}`)
  } catch (e) {
    log.warn(`state backup rotation failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Wire-up order: tools → agents → LLM → approval gate → bot → scheduler.
  const { createBot, createNullSender } = await import('./telegram/bot.js')
  const { loadAgentRegistry } = await import('./agents/registry.js')
  // Brain seam (§12.6): codex = ChatGPT OAuth keyfile client, glm = the
  // OpenAI-compatible lane. Both satisfy LlmClient, so everything downstream
  // (agent loop, subagents, bot) is unchanged.
  const llm = cfg.brain === 'codex'
    ? (await import('./llm/codex.js')).createCodexLlmClient(cfg)
    : (await import('./llm/client.js')).createLlmClient(cfg)
  const { createToolRegistry } = await import('./tools/index.js')
  const { createApprovalGate } = await import('./safety/approvals.js')
  const { startStatusServer, emitEvent, noteRunFinished } = await import('./status/http.js')

  const agentRegistry = await loadAgentRegistry(cfg)

  // Thread rehydration (§12.7 fix — the function existed, documented as
  // boot-only, but was never called): conversations survive a restart from
  // the transcripts. Best-effort inside; count is logged for visibility.
  const { restoreThreads } = await import('./loop/context.js')
  const restoredThreads = restoreThreads(cfg)
  if (restoredThreads > 0) log.info(`threads rehydrated from transcripts: ${restoredThreads}`)

  // Doctor gate (Phase 12.0) — the gate ships BEFORE the hands. Cheap stages
  // run at every boot; the hands tools (workspace/exec/coding/browser)
  // register ONLY when the gate is open, and re-check at execute time.
  const { runDoctor, handsGateOpen, formatDoctorReport } = await import('./doctor/doctor.js')
  const doctor = await runDoctor(cfg)
  const handsOpen = handsGateOpen(cfg)
  if (doctor.ok) {
    log.info(`doctor: healthy (${doctor.stages.length} stage(s) pass) · hands ${handsOpen ? 'OPEN' : 'gated (run npm run doctor)'}`)
  } else {
    log.warn(formatDoctorReport(doctor))
    log.warn(`hands ${handsOpen ? 'OPEN (gate stale — tools will re-check)' : 'CLOSED — workspace/exec/browser unavailable'}`)
  }

  // D0 sandbox sovereignty: refresh an explicit tracked-file allowlist into
  // data/sandbox/repo on every boot. It is reference context only.
  try {
    const { refreshRepoMirror } = await import('./tools/repoMirror.js')
    const mirror = refreshRepoMirror(cfg, frogRootForMirror(cfg))
    log.info(
      `repo mirror refreshed: ${mirror.files} file(s)` +
        (mirror.missing.length ? `, ${mirror.missing.length} optional path(s) absent` : ''),
    )
  } catch (e) {
    log.warn(
      `repo mirror refresh failed; hands will see the previous snapshot: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }

  const toolRegistry = createToolRegistry(handsOpen)

  // Wallet lane (REAL mode only): bridge the external MCP wallet server's
  // tools into the registry under an explicit allowlist, mcp_-prefixed.
  // Dry-run never spawns it — the signer stays outside this process.
  if (!cfg.dryRun) {
    const { registerMcpTools } = await import('./mcp/bridge.js')
    const bridge = await registerMcpTools(toolRegistry, cfg)
    log.info(
      `wallet lane: registered [${bridge.registered.join(', ') || 'none'}], ` +
        `skipped ${bridge.skipped.length} server tool(s) not on the allowlist`,
    )
  }

  // Live counters for the status endpoint.
  let activeRuns = 0
  let lastRunAt: number | undefined
  const bot = await createBot(cfg, {
    agentRegistry,
    toolRegistry,
    llm,
    onEvent: (e) => {
      if (e.kind === 'run_started') activeRuns += 1
      if (e.kind === 'final' || e.kind === 'error' || e.kind === 'aborted') {
        activeRuns = Math.max(0, activeRuns - 1)
        lastRunAt = Date.now()
        noteRunFinished()
      }
      emitEvent(e)
    },
  })

  // Validate agent tool allowlists against the real registry — fail fast on typos.
  for (const name of agentRegistry.names()) {
    const agent = agentRegistry.get(name)!
    if (agent.tools) {
      for (const toolName of agent.tools) {
        if (toolName === 'spawn_subagent' || toolRegistry.get(toolName)) continue
        if (toolName.startsWith('mcp_')) {
          // Wallet-lane tools may legitimately be absent — dry-run rollback never
          // spawns the lane, and the agent just sees them missing. Don't refuse boot.
          log.warn(`agent '${name}': wallet-lane tool '${toolName}' not registered (lane off?) — skipped`)
          continue
        }
        throw new Error(
          `agent '${name}' references unknown tool '${toolName}'. Registered: ${toolRegistry.names().join(', ')}`,
        )
      }
    }
  }

  const approvalGate = createApprovalGate(cfg, bot.sender, (e) => emitEvent(e))
  bot.setApprovalGate(approvalGate)
  bot.setPendingApprovals(() => approvalGate.pendingCount())

  // Local-only status endpoint + desktop dashboard (http://127.0.0.1:<port>/).
  const { abortAll } = await import('./loop/interrupt.js')
  startStatusServer(cfg, Object.assign(
    () => ({
      activeRuns,
      pendingApprovals: approvalGate.pendingCount(),
      lastRunAt,
    }),
    {
      killAll: () => {
        const runsAborted = abortAll()
        const approvalsDenied = approvalGate.denyAll('kill switch')
        // Nautilus steal: the kill switch also flips the persisted trading
        // state to HALTED — survives restarts, denies all submits in the
        // guard, until the principal resumes (/resume).
        const deskState = setDeskState(cfg, 'HALTED', 'kill switch')
        const admin = cfg.telegram.adminChatId
        if (admin !== undefined) {
          void bot.sender.send(
            admin,
            `🛑 KILL SWITCH (dashboard): ${runsAborted} run(s) aborted, ${approvalsDenied} approval(s) denied — desk now HALTED.`,
          )
        }
        return { runsAborted, approvalsDenied, deskState: deskState.state }
      },
      pendingList: () => approvalGate.pendingList(),
      // Desktop answer through the SAME gate — settle() edits the Telegram card,
      // so the admin chat shows the dashboard decision without a duplicate ping.
      decideApproval: (reqId: string, allow: boolean) => approvalGate.decide(reqId, allow),
      // TUI chat lane: typed prompts run as the admin through the same queue.
      submitPrompt: (text: string) => bot.startAdminRun(text),
      // TUI rewind lane: transcript mutation through the admin chat's queue.
      rewindThread: (n: number) => bot.rewindAdminThread(n),
      threadCheckpoints: () => bot.adminThreadCheckpoints(),
    },
  ))

  // Boot reconciliation (Nautilus live-node pattern): the ledger claims
  // positions — the wallet either has them or the ledger lies (phantom-ledger
  // incident, 2026-09-03). Fire-and-forget: never blocks boot; a phantom
  // fails CLOSED to HALTED and the principal hears about it immediately.
  if (cfg.executionMode === 'coinbase-mcp') {
    void import('./safety/reconcile.js').then(({ reconcileLedgerVsWallet }) =>
      reconcileLedgerVsWallet(cfg).then((rep) => {
        if (!rep.ran) return
        const admin = cfg.telegram.adminChatId
        const summary = rep.halted
          ? `⚖️ RECONCILE FAILED — desk HALTED. ${rep.mismatches.map((m) => `${m.symbol}: ledger ${m.ledgerQty} vs onchain ${m.onchainQty}`).join('; ')}. Fix or /resume after reconciling.`
          : rep.inflated.length > 0
            ? `⚖️ Reconcile: ${rep.checked} position(s) match, ${rep.inflated.length} untracked onchain asset(s) (${rep.inflated.map((m) => m.symbol).join(', ')}), ${rep.unchecked.length} unreadable.`
            : `⚖️ Reconcile: ledger matches the wallet (${rep.checked} checked${rep.unchecked.length ? `, ${rep.unchecked.length} unreadable` : ''}).`
        log.info(`[reconcile] ${summary}`)
        if (admin !== undefined) void bot.sender.send(admin, summary)
      }),
    )
  }

  // Scheduler: cron-fired prompts run as the orchestrator in the admin chat,
  // through the same loop and approval gate as chat-initiated runs.
  if (cfg.telegram.adminChatId !== undefined) {
    const { Scheduler } = await import('./scheduler/scheduler.js')
    const { setScheduler } = await import('./tools/schedule.js')
    const { distillLessons } = await import('./tools/journal.js')
    const adminChat = cfg.telegram.adminChatId
    const { noteCronFired } = await import('./rituals/watchdog.js')
    const {
      APPRENTICESHIP_WAKE_TASK_ID,
      configureAutonomousWakeTask,
      runAutonomousWake,
    } = await import('./apprenticeship/autonomousWake.js')
    const scheduler = new Scheduler(
      (task) => {
        log.info(`cron fired: ${task.cron} → "${task.prompt.slice(0, 60)}"`)
        noteCronFired(cfg)

        if (task.id === APPRENTICESHIP_WAKE_TASK_ID) {
          void runAutonomousWake(cfg, task, (prompt) => bot.startRunForCron(prompt))
            .then((outcome) => {
              log.info(
                `apprenticeship wake ${outcome.slot}: ${outcome.status}${
                  outcome.reason ? ` — ${outcome.reason}` : ''
                }`,
              )
            })
            .catch((err) => {
              log.error(
                `apprenticeship wake wrapper failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
            })
          return
        }

        void bot.startRunForCron(task.prompt)
      },
      path.join(cfg.paths.dataDir, 'scheduled_tasks.json'),
      cfg.timezone,
    )
    setScheduler(scheduler)

    // Normalize principal-owned wake config BEFORE jobs are armed. This means
    // blank config removes an old persisted wake and a changed cron replaces it
    // without briefly arming the stale schedule.
    const wakeTask = configureAutonomousWakeTask(scheduler, cfg)
    scheduler.start()
    if (wakeTask) {
      log.info(`autonomous apprenticeship wake scheduled: ${wakeTask.cron} (${cfg.timezone})`)
    }

    // Nightly reviewer: distill journal entries into gated lessons.
    const { Cron } = await import('croner')
    new Cron('0 6 * * *', () => {
      const result = distillLessons(cfg)
      if (result.written.length > 0 && adminChat !== undefined) {
        void bot.sender.send(
          adminChat,
          `📚 Reviewer: distilled ${result.written.length} new lesson(s): ${result.written.join(', ')}`,
        )
      }
    })

    // TA signal grading: once a day, grade every journaled ta:* signal that's
    // had 24h to be right or wrong. Results feed the dashboard track record.
    const { gradeDueSignals } = await import('./market/signalGrader.js')
    new Cron('23 7 * * *', async () => {
      const r = await gradeDueSignals(cfg)
      if (r.graded.length === 0) return
      const hits = r.graded.filter((g) => g.hit).length
      const lines = r.graded.map(
        (g) =>
          `• ${g.symbol} ${g.signal} @ $${g.entryPrice} → $${g.gradedPrice} (${g.movePct >= 0 ? '+' : ''}${g.movePct}%)` +
          (g.alphaPct === null || g.alphaPct === undefined
            ? ''
            : ` α${g.alphaPct >= 0 ? '+' : ''}${g.alphaPct}% vs ${g.benchSymbol ?? 'bench'}`) +
          ` ${g.hit === null ? '· held' : g.hit ? '✅' : '❌'}`,
      )
      if (adminChat !== undefined) {
        void bot.sender.send(
          adminChat,
          `🎯 Signal grading (alpha vs benchmark): ${hits}/${r.graded.length} beat their bench.\n${lines.join('\n')}` +
            (r.awaitingPrice > 0 ? `\n(${r.awaitingPrice} signal(s) awaiting a price — retried tomorrow)` : ''),
        )
      }
      log.info(`ta grading: ${hits}/${r.graded.length} hit`)
    })

    // Position guardian: every 4h, re-price open positions; alert on drawdown
    // crossings (−10% watch / −25% critical), once per crossing, no spam.
    const { checkPositions, formatGuardianReport } = await import('./safety/positionGuardian.js')
    new Cron('43 */4 * * *', async () => {
      const check = await checkPositions(cfg)
      const report = formatGuardianReport(check)
      if (report !== '' && adminChat !== undefined) void bot.sender.send(adminChat, report)
    })

    // Morning brief (Phase 10.1): the desk talks FIRST — deterministic digest
    // (portfolio + mood + headlines + Kronos record), no LLM in the loop.
    if (cfg.briefCron !== '') {
      const { composeMorningBrief } = await import('./rituals/brief.js')
      new Cron(cfg.briefCron, { timezone: cfg.timezone }, async () => {
        try {
          const text = await composeMorningBrief(cfg)
          void bot.sender.send(adminChat, text)
          log.info('morning brief sent')
        } catch (err) {
          log.error(`morning brief failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      log.info(`morning brief scheduled: ${cfg.briefCron} (${cfg.timezone})`)
    }

    // Forecast grading (Phase 10.3): judge yesterday's Kronos forecasts against
    // reality — in-band? direction right? Feeds the morning brief's record line.
    const { gradeDueForecasts } = await import('./market/forecastGrader.js')
    new Cron('17 7 * * *', { timezone: cfg.timezone }, async () => {
      try {
        const r = await gradeDueForecasts(cfg)
        if (r.graded.length === 0) return
        const inBand = r.graded.filter((g) => g.inBand).length
        const lines = r.graded.map(
          (g) =>
            `• ${g.symbol}: ${g.inBand ? 'in-band ✅' : 'band breached ❌'}` +
            (g.directionHit === null ? '' : g.directionHit ? ' · direction ✅' : ' · direction ❌') +
            ` (actual ${g.actualMovePct >= 0 ? '+' : ''}${g.actualMovePct}%)`,
        )
        void bot.sender.send(
          adminChat,
          `🔮 Forecast grading: ${inBand}/${r.graded.length} landed inside their published band.\n${lines.join('\n')}` +
            (r.awaitingPrice > 0 ? `\n(${r.awaitingPrice} awaiting a price — retried tomorrow)` : ''),
        )
        log.info(`forecast grading: ${inBand}/${r.graded.length} in-band`)
      } catch (err) {
        log.error(`forecast grading failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    // Proactive sentinel (Phase 10.4): the desk taps the principal's shoulder
    // when it sees opportunity or risk — sentiment extremes, outsized moves,
    // stablecoin shifts. Cooldowns prevent nagging.
    if (cfg.sentinelCron !== '') {
      const { runSentinel } = await import('./rituals/sentinel.js')
      new Cron(cfg.sentinelCron, { timezone: cfg.timezone }, async () => {
        try {
          const alerts = await runSentinel(cfg)
          for (const a of alerts) void bot.sender.send(adminChat, a)
        } catch (err) {
          log.error(`sentinel failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      log.info(`sentinel scheduled: ${cfg.sentinelCron}`)
    }

    // Watchdog (Nautilus steal): the desk watches ITSELF — brain reachability
    // + ritual staleness. The sentinel watches the market; this catches the
    // desk going silently dead.
    if (cfg.watchdogCron !== '') {
      const { runWatchdog } = await import('./rituals/watchdog.js')
      new Cron(cfg.watchdogCron, { timezone: cfg.timezone }, async () => {
        try {
          await runWatchdog(cfg, {
            emit: (alert) => {
              log.warn(`watchdog: ${alert}`)
              void bot.sender.send(adminChat, alert)
            },
          })
        } catch (err) {
          log.error(`watchdog failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
      log.info(`watchdog scheduled: ${cfg.watchdogCron}`)
    }
  }

  await bot.start()

  const admin = cfg.telegram.adminChatId
  if (admin !== undefined) {
    void bot.sender.send(
      admin,
      cfg.dryRun
        ? '🧪 *** DRY RUN — no orders will be signed *** Desk is live.'
        : '⚡ Desk is live (LIVE mode).',
    )
  } else {
    const nullSender = createNullSender()
    void nullSender.send(0, 'warning: TELEGRAM_ADMIN_CHAT_ID unset — approval gate will auto-deny')
  }

  log.info('frog-to-toad-agent is live. Ctrl+C to stop.')
}

function frogRootForMirror(cfg: { paths: { dataDir: string } }): string {
  return path.dirname(cfg.paths.dataDir)
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})

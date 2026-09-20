import { ToolRegistry } from './registry.js'
import { workspaceReadTool, workspaceWriteTool, workspaceListToolDef } from './workspace.js'
import { execRunTool } from './exec.js'
import { workspaceSnapshotTool, workspaceDiffTool } from './coding.js'
import { browserFetchTool } from './browser.js'
import { marketPriceTool, marketTrendingTool, marketTokenSearchTool, marketSentimentTool } from './market.js'
import { lpSpreadTool } from './spread.js'
import { marketTechnicalsTool } from './technicals.js'
import { marketNewsTool } from './news.js'
import { marketOnchainTool } from './onchain.js'
import { backtestStrategyTool } from './backtest.js'
import { kronosForecastTool } from './kronos.js'
import { tokenSafetyScanTool } from './safety.js'
import { tokenAuditTool } from './audit.js'
import { portfolioGetTool, portfolioHistoryTool } from './portfolio.js'
import { swapQuoteTool, swapExecuteTool } from './swap.js'
import { spawnSubagentTool } from './spawn.js'
import { skillTool } from './skill.js'
import { journalAppendTool, journalReadTool } from './journal.js'
import { memorySaveTool, memoryReadTool } from './memory.js'
import { scheduleCreateTool, scheduleListTool, scheduleDeleteTool } from './schedule.js'
import { mailboxSendTool, mailboxReadTool, mailboxRespondTool } from './mailbox.js'
import { sendAlertTool } from './alert.js'
import { runtimeStatusTool } from './runtime.js'
import { repoCodeExploreTool, repoEyesStatusTool } from './repoEyes.js'
import { taskCreateTool, taskListTool, taskGetTool, taskUpdateTool } from './tasks.js'

/**
 * All built-in tools. Allowlists in agents/*.md decide who sees what.
 *
 * The HANDS tools (workspace/exec/coding/browser) are capability-gated by the
 * doctor (Phase 12.0): the gate ships BEFORE the capability, so they register
 * only when `handsOpen` is true — a failed `npm run doctor` boot leaves the
 * desk talking and trading, minus the hands. Tools ALSO re-check the gate at
 * execute time (defense in depth — a mid-run doctor failure closes them).
 */
export function createToolRegistry(handsOpen = false): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(
    marketPriceTool,
    marketTrendingTool,
    marketTokenSearchTool,
    marketSentimentTool,
    marketNewsTool,
    marketOnchainTool,
    lpSpreadTool,
    marketTechnicalsTool,
    backtestStrategyTool,
    kronosForecastTool,
    tokenSafetyScanTool,
    tokenAuditTool,
    portfolioGetTool,
    portfolioHistoryTool,
    swapQuoteTool,
    swapExecuteTool,
    spawnSubagentTool,
    skillTool,
    journalAppendTool,
    journalReadTool,
    memorySaveTool,
    memoryReadTool,
    scheduleCreateTool,
    scheduleListTool,
    scheduleDeleteTool,
    sendAlertTool,
    runtimeStatusTool,
    repoEyesStatusTool,
    repoCodeExploreTool,
    taskCreateTool,
    taskListTool,
    taskGetTool,
    taskUpdateTool,
    mailboxSendTool,
    mailboxReadTool,
    mailboxRespondTool,
  )
  if (handsOpen) {
    registry.register(
      workspaceReadTool,
      workspaceWriteTool,
      workspaceListToolDef,
      execRunTool,
      workspaceSnapshotTool,
      workspaceDiffTool,
      browserFetchTool,
    )
  }
  return registry
}

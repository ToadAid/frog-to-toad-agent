import type { Config } from '../config.js'

/**
 * Frog-to-Toad A0 — the one and only autonomous approval exception.
 *
 * This deliberately does NOT mean "turn approvals off in dry-run". The exception
 * is exact and conjunctive: the operator opted in, the whole desk is DRY_RUN,
 * the tool is exactly swap_execute, and the registered danger class is trade.
 *
 * Raw MCP transfers/approvals/spend-permissions, workspace writes, exec tools,
 * and every future guarded tool remain on the ordinary approval path.
 */
export function allowsAutonomousDryRunTrade(
  cfg: Config,
  tool: { name: string; danger: string },
): boolean {
  return (
    cfg.autonomousDryRun === true &&
    cfg.dryRun === true &&
    tool.name === 'swap_execute' &&
    tool.danger === 'trade'
  )
}

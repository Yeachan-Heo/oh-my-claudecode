#!/usr/bin/env node

/**
 * claud - Shell launcher for Claude Code with OMC integration
 *
 * A thin wrapper that launches Claude Code inside a tmux session
 * with OMC hooks, HUD, and session management.
 *
 * Usage:
 *   claud                          Launch Claude Code
 *   claud --notify false           Launch without CCNotifier events (OMC_NOTIFY=0)
 *   claud --madmax                 Launch with permissions bypass
 *   claud --yolo                   Launch with permissions bypass (alias)
 *   claud [claude-flags...]        Pass flags directly to Claude CLI
 *
 * All unrecognized flags are forwarded to the Claude CLI.
 */

import { launchCommand } from './launch.js';

const args = process.argv.slice(2);

launchCommand(args).catch((err) => {
  console.error(`[claud] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

/**
 * Native tmux shell launch for omc
 * Launches Claude Code with tmux session management and HUD integration
 */

import { execFileSync } from 'child_process';
import {
  resolveLaunchPolicy,
  buildTmuxSessionName,
  buildTmuxShellCommand,
  quoteShellArg,
  listHudWatchPaneIdsInCurrentWindow,
  createHudWatchPane,
  killTmuxPane,
  isClaudeAvailable,
  type ClaudeLaunchPolicy,
} from './tmux-utils.js';

// Flag mapping
const MADMAX_FLAG = '--madmax';
const YOLO_FLAG = '--yolo';
const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';
const NOTIFY_FLAG = '--notify';

/**
 * Extract the OMC-specific --notify flag from launch args.
 * --notify false  → disable notifications (OMC_NOTIFY=0)
 * --notify true   → enable notifications (default)
 * This flag must be stripped before passing args to Claude CLI.
 */
export function extractNotifyFlag(args: string[]): { notifyEnabled: boolean; remainingArgs: string[] } {
  let notifyEnabled = true;
  const remainingArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === NOTIFY_FLAG && i + 1 < args.length) {
      const val = args[i + 1].toLowerCase();
      notifyEnabled = val !== 'false' && val !== '0';
      i++; // skip value
    } else if (arg.startsWith(`${NOTIFY_FLAG}=`)) {
      const val = arg.slice(NOTIFY_FLAG.length + 1).toLowerCase();
      notifyEnabled = val !== 'false' && val !== '0';
    } else {
      remainingArgs.push(arg);
    }
  }

  return { notifyEnabled, remainingArgs };
}

/**
 * Normalize Claude launch arguments
 * Maps --madmax/--yolo to --dangerously-skip-permissions
 * All other flags pass through unchanged
 */
export function normalizeClaudeLaunchArgs(args: string[]): string[] {
  const normalized: string[] = [];
  let wantsBypass = false;
  let hasBypass = false;

  for (const arg of args) {
    if (arg === MADMAX_FLAG || arg === YOLO_FLAG) {
      wantsBypass = true;
      continue;
    }

    if (arg === CLAUDE_BYPASS_FLAG) {
      wantsBypass = true;
      if (!hasBypass) {
        normalized.push(arg);
        hasBypass = true;
      }
      continue;
    }

    normalized.push(arg);
  }

  if (wantsBypass && !hasBypass) {
    normalized.push(CLAUDE_BYPASS_FLAG);
  }

  return normalized;
}

/**
 * preLaunch: Prepare environment before Claude starts
 * Currently a placeholder - can be extended for:
 * - Session state initialization
 * - Environment setup
 * - Pre-launch checks
 */
export async function preLaunch(_cwd: string, _sessionId: string): Promise<void> {
  // Placeholder for future pre-launch logic
  // e.g., session state, environment prep, etc.
}

/**
 * runClaude: Launch Claude CLI (blocks until exit)
 * Handles 3 scenarios:
 * 1. inside-tmux: Launch claude in current pane, HUD in bottom split
 * 2. outside-tmux: Create new tmux session with claude + HUD pane
 * 3. direct: tmux not available, run claude directly
 */
export function runClaude(cwd: string, args: string[], sessionId: string): void {
  const omcBin = process.argv[1];
  const policy = resolveLaunchPolicy(process.env);

  // Check if omc has a HUD command
  // For now, use a simple placeholder or skip HUD if not available
  const hasHudCommand = false; // TODO: Check if omc has hud command
  const hudCmd = hasHudCommand ? buildTmuxShellCommand('node', [omcBin, 'hud', '--watch']) : '';

  switch (policy) {
    case 'inside-tmux':
      runClaudeInsideTmux(cwd, args, hudCmd);
      break;
    case 'outside-tmux':
      runClaudeOutsideTmux(cwd, args, sessionId, hudCmd);
      break;
    case 'direct':
      runClaudeDirect(cwd, args);
      break;
  }
}

/**
 * Run Claude inside existing tmux session
 * Splits pane for HUD, launches Claude in current pane
 */
function runClaudeInsideTmux(cwd: string, args: string[], hudCmd: string): void {
  const currentPaneId = process.env.TMUX_PANE;

  // Clean up stale HUD panes
  const staleHudPaneIds = listHudWatchPaneIdsInCurrentWindow(currentPaneId);
  for (const paneId of staleHudPaneIds) {
    killTmuxPane(paneId);
  }

  // Create HUD pane if command is available
  let hudPaneId: string | null = null;
  if (hudCmd) {
    try {
      hudPaneId = createHudWatchPane(cwd, hudCmd);
    } catch {
      // HUD split failed, continue without it
    }
  }

  // Launch Claude in current pane
  try {
    execFileSync('claude', args, { cwd, stdio: 'inherit' });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.error('[omc] Error: claude CLI not found in PATH.');
      process.exit(1);
    }
    // Normal exit (non-zero status codes throw in execFileSync) — ignore
  } finally {
    // Cleanup HUD pane on exit
    if (hudPaneId) {
      killTmuxPane(hudPaneId);
    }
    // Clean up any remaining HUD panes
    const remainingHudPaneIds = listHudWatchPaneIdsInCurrentWindow(currentPaneId);
    for (const paneId of remainingHudPaneIds) {
      killTmuxPane(paneId);
    }
  }
}

/**
 * Run Claude outside tmux - create new session
 * Creates tmux session with Claude + HUD pane
 */
function runClaudeOutsideTmux(cwd: string, args: string[], sessionId: string, hudCmd: string): void {
  const claudeCmd = buildTmuxShellCommand('claude', args);
  const tmuxSessionId = `omc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionName = buildTmuxSessionName(cwd, tmuxSessionId);

  const tmuxArgs = [
    'new-session', '-d', '-s', sessionName, '-c', cwd,
    claudeCmd,
  ];

  // Add HUD pane if available
  if (hudCmd) {
    tmuxArgs.push(
      ';',
      'split-window', '-v', '-l', '4', '-d', '-c', cwd, hudCmd,
      ';',
      'select-pane', '-t', '0',
    );
  }

  // Attach to session
  tmuxArgs.push(';', 'attach-session', '-t', sessionName);

  try {
    execFileSync('tmux', tmuxArgs, { stdio: 'inherit' });
  } catch {
    // tmux failed, fall back to direct launch
    runClaudeDirect(cwd, args);
  }
}

/**
 * Run Claude directly (no tmux)
 * Fallback when tmux is not available
 */
function runClaudeDirect(cwd: string, args: string[]): void {
  try {
    execFileSync('claude', args, { cwd, stdio: 'inherit' });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.error('[omc] Error: claude CLI not found in PATH.');
      process.exit(1);
    }
    // Normal exit (non-zero status codes throw in execFileSync) — ignore
  }
}

/**
 * postLaunch: Cleanup after Claude exits
 * Currently a placeholder - can be extended for:
 * - Session cleanup
 * - State finalization
 * - Post-launch reporting
 */
export async function postLaunch(_cwd: string, _sessionId: string): Promise<void> {
  // Placeholder for future post-launch logic
  // e.g., cleanup, finalization, etc.
}

/**
 * Main launch command entry point
 * Orchestrates the 3-phase launch: preLaunch -> run -> postLaunch
 */
export async function launchCommand(args: string[]): Promise<void> {
  // Extract OMC-specific --notify flag before passing remaining args to Claude CLI
  const { notifyEnabled, remainingArgs } = extractNotifyFlag(args);
  if (!notifyEnabled) {
    process.env.OMC_NOTIFY = '0';
  }

  const cwd = process.cwd();

  // Pre-flight: check for nested session
  if (process.env.CLAUDECODE) {
    console.error('[omc] Error: Already inside a Claude Code session. Nested launches are not supported.');
    process.exit(1);
  }

  // Pre-flight: check claude CLI availability
  if (!isClaudeAvailable()) {
    console.error('[omc] Error: claude CLI not found. Install Claude Code first:');
    console.error('  npm install -g @anthropic-ai/claude-code');
    process.exit(1);
  }

  const normalizedArgs = normalizeClaudeLaunchArgs(remainingArgs);
  const sessionId = `omc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Phase 1: preLaunch
  try {
    await preLaunch(cwd, sessionId);
  } catch (err) {
    // preLaunch errors must NOT prevent Claude from starting
    console.error(`[omc] preLaunch warning: ${err instanceof Error ? err.message : err}`);
  }

  // Phase 2: run
  try {
    runClaude(cwd, normalizedArgs, sessionId);
  } finally {
    // Phase 3: postLaunch
    await postLaunch(cwd, sessionId);
  }
}

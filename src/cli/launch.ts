/**
 * Native tmux shell launch for omc
 * Launches Claude Code with tmux session management
 */

import { execFileSync } from 'child_process';
import {
  resolveLaunchPolicy,
  buildTmuxSessionName,
  buildTmuxShellCommand,
  wrapWithLoginShell,
  isClaudeAvailable,
} from './tmux-utils.js';

// Flag mapping
const MADMAX_FLAG = '--madmax';
const YOLO_FLAG = '--yolo';
const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';

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
 * 1. inside-tmux: Launch claude in current pane
 * 2. outside-tmux: Create new tmux session with claude
 * 3. direct: tmux not available, run claude directly
 */
export function runClaude(cwd: string, args: string[], sessionId: string): void {
  const policy = resolveLaunchPolicy(process.env);

  switch (policy) {
    case 'inside-tmux':
      runClaudeInsideTmux(cwd, args);
      break;
    case 'outside-tmux':
      runClaudeOutsideTmux(cwd, args, sessionId);
      break;
    case 'direct':
      runClaudeDirect(cwd, args);
      break;
  }
}

/**
 * Run Claude inside existing tmux session
 * Launches Claude in current pane
 */
function runClaudeInsideTmux(cwd: string, args: string[]): void {
  // Enable mouse scrolling in the current tmux session (non-fatal if it fails)
  try {
    execFileSync('tmux', ['set-option', 'mouse', 'on'], { stdio: 'ignore' });
  } catch { /* non-fatal — user's tmux may not support these options */ }

  // Launch Claude in current pane
  try {
    execFileSync('claude', args, { cwd, stdio: 'inherit' });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { status?: number | null };
    if (err.code === 'ENOENT') {
      console.error('[omc] Error: claude CLI not found in PATH.');
      process.exit(1);
    }
    // Propagate Claude's exit code so omc does not swallow failures
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
}

/**
 * Run Claude outside tmux - create new session
 * Creates tmux session with Claude
 */
function runClaudeOutsideTmux(cwd: string, args: string[], _sessionId: string): void {
  const rawClaudeCmd = buildTmuxShellCommand('claude', args);
  // Drain any pending terminal Device Attributes (DA1) response from stdin.
  // When tmux attach-session sends a DA1 query, the terminal replies with
  // \e[?6c which lands in the pty buffer before Claude reads input.
  // A short sleep lets the response arrive, then tcflush discards it.
  // Wrap in login shell so .bashrc/.zshrc are sourced (PATH, nvm, etc.)
  const claudeCmd = wrapWithLoginShell(`sleep 0.3; perl -e 'use POSIX;tcflush(0,TCIFLUSH)' 2>/dev/null; ${rawClaudeCmd}`);
  const sessionName = buildTmuxSessionName(cwd);

  const tmuxArgs = [
    'new-session', '-d', '-s', sessionName, '-c', cwd,
    claudeCmd,
    ';', 'set-option', '-t', sessionName, 'mouse', 'on',
  ];

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
    const err = error as NodeJS.ErrnoException & { status?: number | null };
    if (err.code === 'ENOENT') {
      console.error('[omc] Error: claude CLI not found in PATH.');
      process.exit(1);
    }
    // Propagate Claude's exit code so omc does not swallow failures
    process.exit(typeof err.status === 'number' ? err.status : 1);
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

  const normalizedArgs = normalizeClaudeLaunchArgs(args);
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

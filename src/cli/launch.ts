/**
 * Native tmux shell launch for omc
 * Launches Claude Code with tmux session management
 */

import { execFileSync } from 'child_process';
import {
  resolveLaunchPolicy,
  buildTmuxSessionName,
  buildTmuxShellCommand,
  isClaudeAvailable,
} from './tmux-utils.js';

// Flag mapping
const MADMAX_FLAG = '--madmax';
const YOLO_FLAG = '--yolo';
const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';
const NOTIFY_FLAG = '--notify';
const OPENCLAW_FLAG = '--openclaw';
const TELEGRAM_FLAG = '--telegram';
const DISCORD_FLAG = '--discord';
const SLACK_FLAG = '--slack';
const WEBHOOK_FLAG = '--webhook';

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
 * Extract the OMC-specific --openclaw flag from launch args.
 * Purely presence-based (like --madmax/--yolo):
 *   --openclaw        -> enable OpenClaw (OMC_OPENCLAW=1)
 *   --openclaw=true   -> enable OpenClaw
 *   --openclaw=false  -> disable OpenClaw
 *   --openclaw=1      -> enable OpenClaw
 *   --openclaw=0      -> disable OpenClaw
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export function extractOpenClawFlag(args: string[]): { openclawEnabled: boolean; remainingArgs: string[] } {
  let openclawEnabled = false;
  const remainingArgs: string[] = [];

  for (const arg of args) {
    if (arg === OPENCLAW_FLAG) {
      // Bare --openclaw means enabled (does NOT consume next arg)
      openclawEnabled = true;
      continue;
    }

    if (arg.startsWith(`${OPENCLAW_FLAG}=`)) {
      const val = arg.slice(OPENCLAW_FLAG.length + 1).toLowerCase();
      openclawEnabled = val !== 'false' && val !== '0';
      continue;
    }

    remainingArgs.push(arg);
  }

  return { openclawEnabled, remainingArgs };
}

/**
 * Extract the OMC-specific --telegram flag from launch args.
 * Purely presence-based:
 *   --telegram        -> enable Telegram notifications (OMC_TELEGRAM=1)
 *   --telegram=true   -> enable
 *   --telegram=false  -> disable
 *   --telegram=1      -> enable
 *   --telegram=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export function extractTelegramFlag(args: string[]): { telegramEnabled: boolean | undefined; remainingArgs: string[] } {
  let telegramEnabled: boolean | undefined = undefined;
  const remainingArgs: string[] = [];
  for (const arg of args) {
    if (arg === TELEGRAM_FLAG) { telegramEnabled = true; continue; }
    if (arg.startsWith(`${TELEGRAM_FLAG}=`)) {
      const val = arg.slice(TELEGRAM_FLAG.length + 1).toLowerCase();
      telegramEnabled = val !== 'false' && val !== '0';
      continue;
    }
    remainingArgs.push(arg);
  }
  return { telegramEnabled, remainingArgs };
}

/**
 * Extract the OMC-specific --discord flag from launch args.
 * Purely presence-based:
 *   --discord        -> enable Discord notifications (OMC_DISCORD=1)
 *   --discord=true   -> enable
 *   --discord=false  -> disable
 *   --discord=1      -> enable
 *   --discord=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export function extractDiscordFlag(args: string[]): { discordEnabled: boolean | undefined; remainingArgs: string[] } {
  let discordEnabled: boolean | undefined = undefined;
  const remainingArgs: string[] = [];
  for (const arg of args) {
    if (arg === DISCORD_FLAG) { discordEnabled = true; continue; }
    if (arg.startsWith(`${DISCORD_FLAG}=`)) {
      const val = arg.slice(DISCORD_FLAG.length + 1).toLowerCase();
      discordEnabled = val !== 'false' && val !== '0';
      continue;
    }
    remainingArgs.push(arg);
  }
  return { discordEnabled, remainingArgs };
}

/**
 * Extract the OMC-specific --slack flag from launch args.
 * Purely presence-based:
 *   --slack        -> enable Slack notifications (OMC_SLACK=1)
 *   --slack=true   -> enable
 *   --slack=false  -> disable
 *   --slack=1      -> enable
 *   --slack=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export function extractSlackFlag(args: string[]): { slackEnabled: boolean | undefined; remainingArgs: string[] } {
  let slackEnabled: boolean | undefined = undefined;
  const remainingArgs: string[] = [];
  for (const arg of args) {
    if (arg === SLACK_FLAG) { slackEnabled = true; continue; }
    if (arg.startsWith(`${SLACK_FLAG}=`)) {
      const val = arg.slice(SLACK_FLAG.length + 1).toLowerCase();
      slackEnabled = val !== 'false' && val !== '0';
      continue;
    }
    remainingArgs.push(arg);
  }
  return { slackEnabled, remainingArgs };
}

/**
 * Extract the OMC-specific --webhook flag from launch args.
 * Purely presence-based:
 *   --webhook        -> enable Webhook notifications (OMC_WEBHOOK=1)
 *   --webhook=true   -> enable
 *   --webhook=false  -> disable
 *   --webhook=1      -> enable
 *   --webhook=0      -> disable
 *
 * Does NOT consume the next positional arg (no space-separated value).
 * This flag is stripped before passing args to Claude CLI.
 */
export function extractWebhookFlag(args: string[]): { webhookEnabled: boolean | undefined; remainingArgs: string[] } {
  let webhookEnabled: boolean | undefined = undefined;
  const remainingArgs: string[] = [];
  for (const arg of args) {
    if (arg === WEBHOOK_FLAG) { webhookEnabled = true; continue; }
    if (arg.startsWith(`${WEBHOOK_FLAG}=`)) {
      const val = arg.slice(WEBHOOK_FLAG.length + 1).toLowerCase();
      webhookEnabled = val !== 'false' && val !== '0';
      continue;
    }
    remainingArgs.push(arg);
  }
  return { webhookEnabled, remainingArgs };
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
  const claudeCmd = `sleep 0.3; perl -e 'use POSIX;tcflush(0,TCIFLUSH)' 2>/dev/null; ${rawClaudeCmd}`;
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
  // Extract OMC-specific --notify flag before passing remaining args to Claude CLI
  const { notifyEnabled, remainingArgs } = extractNotifyFlag(args);
  if (!notifyEnabled) {
    process.env.OMC_NOTIFY = '0';
  }

  // Extract OMC-specific --openclaw flag (presence-based, no value consumption)
  const { openclawEnabled, remainingArgs: argsAfterOpenclaw } = extractOpenClawFlag(remainingArgs);
  if (openclawEnabled === true) {
    process.env.OMC_OPENCLAW = '1';
  } else if (openclawEnabled === false) {
    process.env.OMC_OPENCLAW = '0';
  }

  // Extract OMC-specific --telegram flag (presence-based)
  const { telegramEnabled, remainingArgs: argsAfterTelegram } = extractTelegramFlag(argsAfterOpenclaw);
  if (telegramEnabled === true) {
    process.env.OMC_TELEGRAM = '1';
  } else if (telegramEnabled === false) {
    process.env.OMC_TELEGRAM = '0';
  }

  // Extract OMC-specific --discord flag (presence-based)
  const { discordEnabled, remainingArgs: argsAfterDiscord } = extractDiscordFlag(argsAfterTelegram);
  if (discordEnabled === true) {
    process.env.OMC_DISCORD = '1';
  } else if (discordEnabled === false) {
    process.env.OMC_DISCORD = '0';
  }

  // Extract OMC-specific --slack flag (presence-based)
  const { slackEnabled, remainingArgs: argsAfterSlack } = extractSlackFlag(argsAfterDiscord);
  if (slackEnabled === true) {
    process.env.OMC_SLACK = '1';
  } else if (slackEnabled === false) {
    process.env.OMC_SLACK = '0';
  }

  // Extract OMC-specific --webhook flag (presence-based)
  const { webhookEnabled, remainingArgs: argsAfterWebhook } = extractWebhookFlag(argsAfterSlack);
  if (webhookEnabled === true) {
    process.env.OMC_WEBHOOK = '1';
  } else if (webhookEnabled === false) {
    process.env.OMC_WEBHOOK = '0';
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

  const normalizedArgs = normalizeClaudeLaunchArgs(argsAfterWebhook);
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

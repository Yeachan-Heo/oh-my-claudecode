/**
 * Rate Limit Wait Daemon
 *
 * Background daemon that monitors rate limits and auto-resumes
 * Claude Code sessions when rate limits reset.
 *
 * Security considerations:
 * - State/PID/log files use restrictive permissions (0600)
 * - No sensitive data (tokens, credentials) is logged or stored
 * - Input validation for tmux pane IDs
 *
 * Reference: https://github.com/EvanOman/cc-wait
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { checkRateLimitStatus, formatRateLimitStatus, formatTimeUntilReset } from './rate-limit-monitor.js';
import {
  isTmuxAvailable,
  scanForBlockedPanes,
  sendResumeSequence,
  formatBlockedPanesSummary,
} from './tmux-detector.js';
import type {
  DaemonState,
  DaemonConfig,
  BlockedPane,
  DaemonResponse,
} from './types.js';

/** Default configuration */
const DEFAULT_CONFIG: Required<DaemonConfig> = {
  pollIntervalMs: 60 * 1000, // 1 minute
  paneLinesToCapture: 15,
  verbose: false,
  stateFilePath: join(homedir(), '.omc', 'state', 'rate-limit-daemon.json'),
  pidFilePath: join(homedir(), '.omc', 'state', 'rate-limit-daemon.pid'),
  logFilePath: join(homedir(), '.omc', 'state', 'rate-limit-daemon.log'),
};

/** Maximum log file size before rotation (1MB) */
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;

/** Restrictive file permissions (owner read/write only) */
const SECURE_FILE_MODE = 0o600;

/**
 * Allowlist of environment variables safe to pass to daemon child process.
 * This prevents leaking sensitive variables like ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.
 */
const DAEMON_ENV_ALLOWLIST = [
  // Core system paths
  'PATH', 'HOME', 'USERPROFILE',
  // User identification
  'USER', 'USERNAME', 'LOGNAME',
  // Locale settings
  'LANG', 'LC_ALL', 'LC_CTYPE',
  // Terminal/tmux (required for tmux integration)
  'TERM', 'TMUX', 'TMUX_PANE',
  // Temp directories
  'TMPDIR', 'TMP', 'TEMP',
  // XDG directories (Linux)
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  // Shell
  'SHELL',
  // Node.js
  'NODE_ENV',
  // Proxy settings
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
  // Windows system
  'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC',
] as const;

/**
 * Create a minimal environment for daemon child processes.
 * Only includes allowlisted variables to prevent credential leakage.
 */
function createMinimalDaemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DAEMON_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * Get effective configuration by merging with defaults
 */
function getConfig(config?: DaemonConfig): Required<DaemonConfig> {
  return { ...DEFAULT_CONFIG, ...config };
}

/**
 * Ensure state directory exists with secure permissions
 */
function ensureStateDir(config: Required<DaemonConfig>): void {
  const stateDir = dirname(config.stateFilePath);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write file with secure permissions (0600 - owner read/write only)
 */
function writeSecureFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
  // Ensure permissions are set even if file existed
  try {
    chmodSync(filePath, SECURE_FILE_MODE);
  } catch {
    // Ignore permission errors (e.g., on Windows)
  }
}

/**
 * Rotate log file if it exceeds maximum size
 */
function rotateLogIfNeeded(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;

    const stats = statSync(logPath);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const backupPath = `${logPath}.old`;
      // Remove old backup if exists
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
      // Rename current to backup
      const { renameSync } = require('fs');
      renameSync(logPath, backupPath);
    }
  } catch {
    // Ignore rotation errors
  }
}

/**
 * Read daemon state from disk
 */
export function readDaemonState(config?: DaemonConfig): DaemonState | null {
  const cfg = getConfig(config);

  try {
    if (!existsSync(cfg.stateFilePath)) {
      return null;
    }

    const content = readFileSync(cfg.stateFilePath, 'utf-8');
    const state = JSON.parse(content) as DaemonState;

    // Restore Date objects
    if (state.startedAt) state.startedAt = new Date(state.startedAt);
    if (state.lastPollAt) state.lastPollAt = new Date(state.lastPollAt);
    if (state.rateLimitStatus?.lastCheckedAt) {
      state.rateLimitStatus.lastCheckedAt = new Date(state.rateLimitStatus.lastCheckedAt);
    }
    if (state.rateLimitStatus?.fiveHourResetsAt) {
      state.rateLimitStatus.fiveHourResetsAt = new Date(state.rateLimitStatus.fiveHourResetsAt);
    }
    if (state.rateLimitStatus?.weeklyResetsAt) {
      state.rateLimitStatus.weeklyResetsAt = new Date(state.rateLimitStatus.weeklyResetsAt);
    }
    if (state.rateLimitStatus?.nextResetAt) {
      state.rateLimitStatus.nextResetAt = new Date(state.rateLimitStatus.nextResetAt);
    }

    for (const pane of state.blockedPanes || []) {
      if (pane.firstDetectedAt) pane.firstDetectedAt = new Date(pane.firstDetectedAt);
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Write daemon state to disk with secure permissions
 * Note: State file contains only non-sensitive operational data
 */
function writeDaemonState(state: DaemonState, config: Required<DaemonConfig>): void {
  ensureStateDir(config);
  writeSecureFile(config.stateFilePath, JSON.stringify(state, null, 2));
}

/**
 * Read PID file
 */
function readPidFile(config: Required<DaemonConfig>): number | null {
  try {
    if (!existsSync(config.pidFilePath)) {
      return null;
    }
    const content = readFileSync(config.pidFilePath, 'utf-8');
    return parseInt(content.trim(), 10);
  } catch {
    return null;
  }
}

/**
 * Write PID file with secure permissions
 */
function writePidFile(pid: number, config: Required<DaemonConfig>): void {
  ensureStateDir(config);
  writeSecureFile(config.pidFilePath, String(pid));
}

/**
 * Remove PID file
 */
function removePidFile(config: Required<DaemonConfig>): void {
  if (existsSync(config.pidFilePath)) {
    unlinkSync(config.pidFilePath);
  }
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send a signal, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is currently running
 */
export function isDaemonRunning(config?: DaemonConfig): boolean {
  const cfg = getConfig(config);
  const pid = readPidFile(cfg);

  if (pid === null) {
    return false;
  }

  if (!isProcessRunning(pid)) {
    // Stale PID file, clean up
    removePidFile(cfg);
    return false;
  }

  return true;
}

/**
 * Log message to daemon log file with rotation
 * Note: Only operational messages are logged, never credentials or tokens
 */
function log(message: string, config: Required<DaemonConfig>): void {
  if (config.verbose) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }

  try {
    ensureStateDir(config);

    // Rotate log if needed (prevents unbounded growth)
    rotateLogIfNeeded(config.logFilePath);

    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;

    // Append to log file with secure permissions
    const { appendFileSync } = require('fs');
    appendFileSync(config.logFilePath, logLine, { mode: SECURE_FILE_MODE });
  } catch {
    // Ignore log write errors
  }
}

/**
 * Create initial daemon state
 */
function createInitialState(): DaemonState {
  return {
    isRunning: true,
    pid: process.pid,
    startedAt: new Date(),
    lastPollAt: null,
    rateLimitStatus: null,
    blockedPanes: [],
    resumedPaneIds: [],
    totalResumeAttempts: 0,
    successfulResumes: 0,
    errorCount: 0,
  };
}

/**
 * Main daemon polling loop
 */
async function pollLoop(config: Required<DaemonConfig>): Promise<void> {
  const state = readDaemonState(config) || createInitialState();
  state.isRunning = true;
  state.pid = process.pid;

  log('Starting poll loop', config);

  while (state.isRunning) {
    try {
      state.lastPollAt = new Date();

      // Check rate limit status
      const rateLimitStatus = await checkRateLimitStatus();
      const wasLimited = state.rateLimitStatus?.isLimited ?? false;
      const isNowLimited = rateLimitStatus?.isLimited ?? false;

      state.rateLimitStatus = rateLimitStatus;

      if (rateLimitStatus) {
        log(`Rate limit status: ${formatRateLimitStatus(rateLimitStatus)}`, config);
      } else {
        log('Rate limit status unavailable (no OAuth credentials?)', config);
      }

      // If currently rate limited, scan for blocked panes
      if (isNowLimited && isTmuxAvailable()) {
        log('Rate limited - scanning for blocked panes', config);

        const blockedPanes = scanForBlockedPanes(config.paneLinesToCapture);

        // Add newly detected blocked panes
        for (const pane of blockedPanes) {
          const existing = state.blockedPanes.find((p) => p.id === pane.id);
          if (!existing) {
            state.blockedPanes.push(pane);
            log(`Detected blocked pane: ${pane.id} in ${pane.session}:${pane.windowIndex}`, config);
          }
        }

        // Remove panes that are no longer blocked
        state.blockedPanes = state.blockedPanes.filter((tracked) =>
          blockedPanes.some((current) => current.id === tracked.id)
        );
      }

      // If rate limit just cleared (was limited, now not), attempt resume
      if (wasLimited && !isNowLimited && state.blockedPanes.length > 0) {
        log('Rate limit cleared! Attempting to resume blocked panes', config);

        for (const pane of state.blockedPanes) {
          if (state.resumedPaneIds.includes(pane.id)) {
            log(`Skipping already resumed pane: ${pane.id}`, config);
            continue;
          }

          state.totalResumeAttempts++;
          log(`Attempting resume for pane: ${pane.id}`, config);

          const success = sendResumeSequence(pane.id);
          pane.resumeAttempted = true;
          pane.resumeSuccessful = success;

          if (success) {
            state.successfulResumes++;
            state.resumedPaneIds.push(pane.id);
            log(`Successfully sent resume to pane: ${pane.id}`, config);
          } else {
            state.errorCount++;
            log(`Failed to send resume to pane: ${pane.id}`, config);
          }
        }

        // Clear blocked panes after resume attempt
        state.blockedPanes = [];
      }

      // If rate limit cleared and no blocked panes, clear resumed list
      if (!isNowLimited && state.blockedPanes.length === 0) {
        state.resumedPaneIds = [];
      }

      writeDaemonState(state, config);
    } catch (error) {
      state.errorCount++;
      state.lastError = error instanceof Error ? error.message : String(error);
      log(`Poll error: ${state.lastError}`, config);
      writeDaemonState(state, config);
    }

    // Wait for next poll
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

/**
 * Start the daemon
 */
export function startDaemon(config?: DaemonConfig): DaemonResponse {
  const cfg = getConfig(config);

  // Check if already running
  if (isDaemonRunning(cfg)) {
    const state = readDaemonState(cfg);
    return {
      success: false,
      message: 'Daemon is already running',
      state: state ?? undefined,
    };
  }

  // Check for tmux
  if (!isTmuxAvailable()) {
    console.warn('[RateLimitDaemon] tmux not available - resume functionality will be limited');
  }

  ensureStateDir(cfg);

  // Fork a new process for the daemon
  const daemonScript = `
    const { pollLoop } = require('${__filename.replace(/\.ts$/, '.js')}');
    const config = ${JSON.stringify(cfg)};
    pollLoop(config).catch(console.error);
  `;

  try {
    // Use node to run the daemon in background
    // Note: Using minimal env to prevent leaking sensitive credentials
    const child = spawn('node', ['-e', daemonScript], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: createMinimalDaemonEnv(),
    });

    child.unref();

    const pid = child.pid;
    if (pid) {
      writePidFile(pid, cfg);

      const state = createInitialState();
      state.pid = pid;
      writeDaemonState(state, cfg);

      return {
        success: true,
        message: `Daemon started with PID ${pid}`,
        state,
      };
    }

    return {
      success: false,
      message: 'Failed to start daemon process',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to start daemon',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run daemon in foreground (for direct execution)
 */
export async function runDaemonForeground(config?: DaemonConfig): Promise<void> {
  const cfg = getConfig(config);

  // Check if already running
  if (isDaemonRunning(cfg)) {
    console.error('Daemon is already running. Use "omc wait daemon stop" first.');
    process.exit(1);
  }

  // Write PID file
  writePidFile(process.pid, cfg);

  // Handle shutdown
  const shutdown = () => {
    console.log('\nShutting down daemon...');
    removePidFile(cfg);
    const state = readDaemonState(cfg);
    if (state) {
      state.isRunning = false;
      writeDaemonState(state, cfg);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Rate Limit Wait daemon starting in foreground mode...');
  console.log('Press Ctrl+C to stop.\n');

  // Run poll loop
  await pollLoop(cfg);
}

/**
 * Stop the daemon
 */
export function stopDaemon(config?: DaemonConfig): DaemonResponse {
  const cfg = getConfig(config);
  const pid = readPidFile(cfg);

  if (pid === null) {
    return {
      success: true,
      message: 'Daemon is not running',
    };
  }

  if (!isProcessRunning(pid)) {
    removePidFile(cfg);
    return {
      success: true,
      message: 'Daemon was not running (cleaned up stale PID file)',
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
    removePidFile(cfg);

    // Update state
    const state = readDaemonState(cfg);
    if (state) {
      state.isRunning = false;
      state.pid = null;
      writeDaemonState(state, cfg);
    }

    return {
      success: true,
      message: `Daemon stopped (PID ${pid})`,
      state: state ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to stop daemon',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get daemon status
 */
export function getDaemonStatus(config?: DaemonConfig): DaemonResponse {
  const cfg = getConfig(config);
  const state = readDaemonState(cfg);
  const running = isDaemonRunning(cfg);

  if (!running && !state) {
    return {
      success: true,
      message: 'Daemon has never been started',
    };
  }

  if (!running && state) {
    return {
      success: true,
      message: 'Daemon is not running',
      state: { ...state, isRunning: false, pid: null },
    };
  }

  return {
    success: true,
    message: 'Daemon is running',
    state: state ?? undefined,
  };
}

/**
 * Detect blocked panes (one-time scan)
 */
export async function detectBlockedPanes(config?: DaemonConfig): Promise<DaemonResponse> {
  const cfg = getConfig(config);

  if (!isTmuxAvailable()) {
    return {
      success: false,
      message: 'tmux is not available',
    };
  }

  const rateLimitStatus = await checkRateLimitStatus();
  const blockedPanes = scanForBlockedPanes(cfg.paneLinesToCapture);

  return {
    success: true,
    message: formatBlockedPanesSummary(blockedPanes),
    state: {
      isRunning: isDaemonRunning(cfg),
      pid: readPidFile(cfg),
      startedAt: null,
      lastPollAt: new Date(),
      rateLimitStatus,
      blockedPanes,
      resumedPaneIds: [],
      totalResumeAttempts: 0,
      successfulResumes: 0,
      errorCount: 0,
    },
  };
}

/**
 * Format daemon state for CLI display
 */
export function formatDaemonState(state: DaemonState): string {
  const lines: string[] = [];

  // Status header
  if (state.isRunning) {
    lines.push(`✓ Daemon running (PID: ${state.pid})`);
  } else {
    lines.push('✗ Daemon not running');
  }

  // Timing info
  if (state.startedAt) {
    lines.push(`  Started: ${state.startedAt.toLocaleString()}`);
  }
  if (state.lastPollAt) {
    lines.push(`  Last poll: ${state.lastPollAt.toLocaleString()}`);
  }

  // Rate limit status
  lines.push('');
  if (state.rateLimitStatus) {
    if (state.rateLimitStatus.isLimited) {
      lines.push(`⚠ ${formatRateLimitStatus(state.rateLimitStatus)}`);
    } else {
      lines.push('✓ Not rate limited');
    }
  } else {
    lines.push('? Rate limit status unavailable');
  }

  // Blocked panes
  if (state.blockedPanes.length > 0) {
    lines.push('');
    lines.push(formatBlockedPanesSummary(state.blockedPanes));
  }

  // Statistics
  lines.push('');
  lines.push('Statistics:');
  lines.push(`  Resume attempts: ${state.totalResumeAttempts}`);
  lines.push(`  Successful: ${state.successfulResumes}`);
  lines.push(`  Errors: ${state.errorCount}`);

  if (state.lastError) {
    lines.push(`  Last error: ${state.lastError}`);
  }

  return lines.join('\n');
}

// Export pollLoop for use by the daemon subprocess
export { pollLoop };

/**
 * Reply Listener Daemon
 *
 * Background daemon that polls Discord and Telegram for replies to notification messages,
 * sanitizes input, verifies the target pane, and injects reply text via sendToPane().
 *
 * Security considerations:
 * - State/PID/log files use restrictive permissions (0600)
 * - Bot tokens stored in state file, NOT in environment variables
 * - Two-layer input sanitization (sanitizeReplyInput + sanitizeForTmux)
 * - Pane verification via analyzePaneContent before every injection
 * - Authorization: only configured user IDs (Discord) / chat ID (Telegram) can inject
 * - Rate limiting to prevent spam/abuse
 *
 * Follows the daemon pattern from src/features/rate-limit-wait/daemon.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, statSync, appendFileSync, renameSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { request as httpsRequest } from 'https';
import {
  capturePaneContent,
  analyzePaneContent,
  sendToPane,
  isTmuxAvailable,
} from '../features/rate-limit-wait/tmux-detector.js';
import {
  lookupByMessageId,
  removeMessagesByPane,
  pruneStale,
} from './session-registry.js';
import type { ReplyConfig } from './types.js';
import { parseMentionAllowedMentions } from './config.js';

// ESM compatibility: __filename is not available in ES modules
const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// Constants and Types
// ============================================================================

/** Restrictive file permissions (owner read/write only) */
const SECURE_FILE_MODE = 0o600;

/** Maximum log file size before rotation (1MB) */
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Allowlist of environment variables safe to pass to daemon child process.
 * This prevents leaking sensitive variables like ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.
 * OMC_* notification env vars are forwarded so the daemon can call getNotificationConfig().
 */
const DAEMON_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USERPROFILE',
  'USER', 'USERNAME', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMUX', 'TMUX_PANE',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'SHELL',
  'NODE_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC',
] as const;

/** Default paths */
const DEFAULT_STATE_DIR = join(homedir(), '.omc', 'state');
const PID_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener.pid');
const STATE_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener-state.json');
const LOG_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener.log');

/** Reply listener daemon state */
export interface ReplyListenerState {
  isRunning: boolean;
  pid: number | null;
  startedAt: string | null;
  lastPollAt: string | null;
  telegramLastUpdateId: number | null;
  discordLastMessageId: string | null;
  messagesInjected: number;
  errors: number;
  lastError?: string;
}

/** Daemon configuration (written to state file) */
export interface ReplyListenerDaemonConfig extends ReplyConfig {
  // Bot tokens stored here (0600 file), NOT in env vars
  telegramBotToken?: string;
  telegramChatId?: string;
  discordBotToken?: string;
  discordChannelId?: string;
  /** Discord mention tag to include in injection feedback (e.g. "<@123456>") */
  discordMention?: string;
}

/** Response from daemon operations */
export interface DaemonResponse {
  success: boolean;
  message: string;
  state?: ReplyListenerState;
  error?: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

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
  // Forward OMC_* env vars so the daemon can call getNotificationConfig()
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OMC_')) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * Ensure state directory exists with secure permissions
 */
function ensureStateDir(): void {
  if (!existsSync(DEFAULT_STATE_DIR)) {
    mkdirSync(DEFAULT_STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write file with secure permissions (0600 - owner read/write only)
 */
function writeSecureFile(filePath: string, content: string): void {
  ensureStateDir();
  writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
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
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
      renameSync(logPath, backupPath);
    }
  } catch {
    // Ignore rotation errors
  }
}

/**
 * Log message to daemon log file with rotation
 */
function log(message: string): void {
  try {
    ensureStateDir();
    rotateLogIfNeeded(LOG_FILE_PATH);

    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;

    appendFileSync(LOG_FILE_PATH, logLine, { mode: SECURE_FILE_MODE });
  } catch {
    // Ignore log write errors
  }
}

/**
 * Read daemon state from disk
 */
function readDaemonState(): ReplyListenerState | null {
  try {
    if (!existsSync(STATE_FILE_PATH)) {
      return null;
    }

    const content = readFileSync(STATE_FILE_PATH, 'utf-8');
    const state = JSON.parse(content) as ReplyListenerState;
    return state;
  } catch {
    return null;
  }
}

/**
 * Write daemon state to disk with secure permissions
 */
function writeDaemonState(state: ReplyListenerState): void {
  writeSecureFile(STATE_FILE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Build daemon config from notification config.
 * Derives bot tokens, channel IDs, and reply settings from getNotificationConfig().
 */
async function buildDaemonConfig(): Promise<ReplyListenerDaemonConfig | null> {
  try {
    const { getReplyConfig, getNotificationConfig, getReplyListenerPlatformConfig } = await import('./config.js');
    const replyConfig = getReplyConfig();
    if (!replyConfig) return null;
    const notifConfig = getNotificationConfig();
    const platformConfig = getReplyListenerPlatformConfig(notifConfig);
    return { ...replyConfig, ...platformConfig };
  } catch {
    return null;
  }
}

/**
 * Read PID file
 */
function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE_PATH)) {
      return null;
    }
    const content = readFileSync(PID_FILE_PATH, 'utf-8');
    return parseInt(content.trim(), 10);
  } catch {
    return null;
  }
}

/**
 * Write PID file with secure permissions
 */
function writePidFile(pid: number): void {
  writeSecureFile(PID_FILE_PATH, String(pid));
}

/**
 * Remove PID file
 */
function removePidFile(): void {
  if (existsSync(PID_FILE_PATH)) {
    unlinkSync(PID_FILE_PATH);
  }
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is currently running
 */
export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) {
    return false;
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    return false;
  }

  return true;
}

// ============================================================================
// Input Sanitization
// ============================================================================

/**
 * Sanitize reply input from Discord/Telegram before tmux injection.
 * Applied BEFORE sendToPane()'s own sanitizeForTmux().
 *
 * Defenses:
 * - Newlines replaced with spaces (prevents multi-command injection)
 * - Backticks escaped (prevents command substitution in some shells)
 * - $() and ${} patterns escaped (prevents command substitution)
 * - Backslashes escaped (prevents escape sequence injection)
 * - Control characters stripped
 */
export function sanitizeReplyInput(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // Strip control chars (keep \n, \r, \t)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')      // Strip bidi override characters
    .replace(/\r?\n/g, ' ')                            // Newlines -> spaces
    .replace(/\\/g, '\\\\')                            // Escape backslashes
    .replace(/`/g, '\\`')                              // Escape backticks
    .replace(/\$\(/g, '\\$(')                          // Escape $()
    .replace(/\$\{/g, '\\${')                          // Escape ${}
    .trim();
}

// ============================================================================
// Rate Limiting
// ============================================================================

class RateLimiter {
  private timestamps: number[] = [];
  private readonly windowMs = 60 * 1000; // 1 minute

  constructor(private readonly maxPerMinute: number) {}

  canProceed(): boolean {
    const now = Date.now();
    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}

// ============================================================================
// Injection
// ============================================================================

/**
 * Inject reply text into a tmux pane after verification and sanitization.
 *
 * Returns true if injection succeeded, false otherwise.
 */
function injectReply(
  paneId: string,
  text: string,
  platform: string,
  config: ReplyListenerDaemonConfig,
): boolean {
  // 1. Verify pane is running Claude Code
  const content = capturePaneContent(paneId, 15);
  const analysis = analyzePaneContent(content);

  if (analysis.confidence < 0.4) {
    log(`WARN: Pane ${paneId} does not appear to be running Claude Code (confidence: ${analysis.confidence}). Skipping injection, removing stale mapping.`);
    removeMessagesByPane(paneId);
    return false;
  }

  // 2. Build prefixed text if configured
  const prefix = config.includePrefix ? `[reply:${platform}] ` : '';

  // 3. Sanitize the reply text
  const sanitized = sanitizeReplyInput(prefix + text);

  // 4. Truncate to max length
  const truncated = sanitized.slice(0, config.maxMessageLength);

  // 5. Inject via sendToPane (which applies its own sanitizeForTmux)
  const success = sendToPane(paneId, truncated, true);

  if (success) {
    log(`Injected reply from ${platform} into pane ${paneId}: "${truncated.slice(0, 50)}${truncated.length > 50 ? '...' : ''}"`);
  } else {
    log(`ERROR: Failed to inject reply into pane ${paneId}`);
  }

  return success;
}

// ============================================================================
// Discord Polling
// ============================================================================

/** Track when to back off Discord polling due to rate limits */
let discordBackoffUntil = 0;

/**
 * Poll Discord for new replies and inject them.
 */
async function pollDiscord(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: RateLimiter,
): Promise<void> {
  if (!config.discordBotToken || !config.discordChannelId) {
    return;
  }

  if (config.authorizedDiscordUserIds.length === 0) {
    // Discord reply listening disabled when no authorized users
    return;
  }

  // Rate limit backoff
  if (Date.now() < discordBackoffUntil) {
    return;
  }

  try {
    const after = state.discordLastMessageId ? `?after=${state.discordLastMessageId}&limit=10` : '?limit=10';
    const url = `https://discord.com/api/v10/channels/${config.discordChannelId}/messages${after}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bot ${config.discordBotToken}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    // Read rate limit headers and back off when remaining < 2
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null && parseInt(remaining, 10) < 2) {
      const resetTime = reset ? parseFloat(reset) * 1000 : Date.now() + 10_000;
      discordBackoffUntil = resetTime;
      log(`WARN: Discord rate limit low (remaining: ${remaining}), backing off until ${new Date(resetTime).toISOString()}`);
    }

    if (!response.ok) {
      log(`Discord API error: HTTP ${response.status}`);
      return;
    }

    const messages = await response.json() as Array<{
      id: string;
      author: { id: string };
      content: string;
      message_reference?: { message_id: string };
    }>;

    if (!Array.isArray(messages) || messages.length === 0) return;

    // Process messages in chronological order (oldest first; Discord returns newest first)
    const sorted = [...messages].reverse();

    for (const msg of sorted) {
      // Filter: message has message_reference (it's a reply)
      if (!msg.message_reference?.message_id) {
        // Still advance the offset
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        continue;
      }

      // Filter: author is in authorizedDiscordUserIds
      if (!config.authorizedDiscordUserIds.includes(msg.author.id)) {
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        continue;
      }

      // Filter: referenced message exists in session registry
      const mapping = lookupByMessageId('discord-bot', msg.message_reference.message_id);
      if (!mapping) {
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        continue;
      }

      // Rate limiting
      if (!rateLimiter.canProceed()) {
        log(`WARN: Rate limit exceeded, dropping Discord message ${msg.id}`);
        state.discordLastMessageId = msg.id;
        writeDaemonState(state);
        state.errors++;
        continue;
      }

      // AT-MOST-ONCE: persist offset BEFORE injection
      state.discordLastMessageId = msg.id;
      writeDaemonState(state);

      // Inject reply
      const success = injectReply(mapping.tmuxPaneId, msg.content, 'discord', config);
      if (success) {
        state.messagesInjected++;

        // Send confirmation reaction (non-critical)
        try {
          await fetch(
            `https://discord.com/api/v10/channels/${config.discordChannelId}/messages/${msg.id}/reactions/%E2%9C%85/@me`,
            {
              method: 'PUT',
              headers: { 'Authorization': `Bot ${config.discordBotToken}` },
              signal: AbortSignal.timeout(5000),
            }
          );
        } catch (e) {
          log(`WARN: Failed to add confirmation reaction: ${e}`);
        }

        // Send injection notification to channel (non-critical)
        try {
          const mentionPrefix = config.discordMention ? `${config.discordMention} ` : '';
          const feedbackAllowedMentions = config.discordMention
            ? parseMentionAllowedMentions(config.discordMention)
            : { parse: [] as string[] };
          await fetch(
            `https://discord.com/api/v10/channels/${config.discordChannelId}/messages`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bot ${config.discordBotToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                content: `${mentionPrefix}Injected into Claude Code session.`,
                message_reference: { message_id: msg.id },
                allowed_mentions: feedbackAllowedMentions,
              }),
              signal: AbortSignal.timeout(5000),
            }
          );
        } catch (e) {
          log(`WARN: Failed to send injection channel notification: ${e}`);
        }
      } else {
        state.errors++;
      }
    }

  } catch (error) {
    state.errors++;
    state.lastError = error instanceof Error ? error.message : String(error);
    log(`Discord polling error: ${state.lastError}`);
  }
}

// ============================================================================
// Telegram Polling
// ============================================================================

/**
 * Poll Telegram for new replies and inject them.
 * Uses httpsRequest with family:4 to match sendTelegram() pattern.
 */
async function pollTelegram(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: RateLimiter,
): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return;
  }

  try {
    const offset = state.telegramLastUpdateId ? state.telegramLastUpdateId + 1 : 0;
    const path = `/bot${config.telegramBotToken}/getUpdates?offset=${offset}&timeout=0`;

    const updates = await new Promise<any[]>((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: 'api.telegram.org',
          path,
          method: 'GET',
          family: 4, // Force IPv4
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve(body.result || []);
              } else {
                reject(new Error(`HTTP ${res.statusCode}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });

    for (const update of updates) {
      const msg = update.message;
      if (!msg) {
        // Always advance offset even for non-message updates
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      // Filter: message has reply_to_message
      if (!msg.reply_to_message?.message_id) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      // Filter: chat.id matches configured chatId
      if (String(msg.chat.id) !== config.telegramChatId) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      // Filter: referenced message exists in session registry
      const mapping = lookupByMessageId('telegram', String(msg.reply_to_message.message_id));
      if (!mapping) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      const text = msg.text || '';
      if (!text) {
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        continue;
      }

      // Rate limiting
      if (!rateLimiter.canProceed()) {
        log(`WARN: Rate limit exceeded, dropping Telegram message ${msg.message_id}`);
        state.telegramLastUpdateId = update.update_id;
        writeDaemonState(state);
        state.errors++;
        continue;
      }

      // AT-MOST-ONCE: persist offset BEFORE injection
      state.telegramLastUpdateId = update.update_id;
      writeDaemonState(state);

      // Inject reply
      const success = injectReply(mapping.tmuxPaneId, text, 'telegram', config);
      if (success) {
        state.messagesInjected++;

        // Send confirmation reply (non-critical)
        try {
          const replyBody = JSON.stringify({
            chat_id: config.telegramChatId,
            text: 'Injected into Claude Code session.',
            reply_to_message_id: msg.message_id,
          });

          await new Promise<void>((resolve) => {
            const replyReq = httpsRequest(
              {
                hostname: 'api.telegram.org',
                path: `/bot${config.telegramBotToken}/sendMessage`,
                method: 'POST',
                family: 4,
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(replyBody),
                },
                timeout: 5000,
              },
              (res) => {
                res.resume(); // Drain response
                resolve();
              }
            );

            replyReq.on('error', () => resolve());
            replyReq.on('timeout', () => {
              replyReq.destroy();
              resolve();
            });

            replyReq.write(replyBody);
            replyReq.end();
          });
        } catch (e) {
          log(`WARN: Failed to send confirmation reply: ${e}`);
        }
      } else {
        state.errors++;
      }
    }

  } catch (error) {
    state.errors++;
    state.lastError = error instanceof Error ? error.message : String(error);
    log(`Telegram polling error: ${state.lastError}`);
  }
}

// ============================================================================
// Main Daemon Loop
// ============================================================================

/** Prune stale registry entries every hour */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Main daemon polling loop
 */
async function pollLoop(): Promise<void> {
  log('Reply listener daemon starting poll loop');

  const config = await buildDaemonConfig();
  if (!config) {
    log('ERROR: No notification config found for reply listener, exiting');
    process.exit(1);
  }

  const state = readDaemonState() || {
    isRunning: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastPollAt: null,
    telegramLastUpdateId: null,
    discordLastMessageId: null,
    messagesInjected: 0,
    errors: 0,
  };

  state.isRunning = true;
  state.pid = process.pid;

  const rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  let lastPruneAt = Date.now();

  // Graceful shutdown handlers
  const shutdown = () => {
    log('Shutdown signal received');
    state.isRunning = false;
    writeDaemonState(state);
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Prune stale registry entries on startup
  try {
    pruneStale();
    log('Pruned stale registry entries');
  } catch (e) {
    log(`WARN: Failed to prune stale entries: ${e}`);
  }

  while (state.isRunning) {
    try {
      state.lastPollAt = new Date().toISOString();

      // Poll platforms sequentially (shared state, avoid race conditions)
      await pollDiscord(config, state, rateLimiter);
      await pollTelegram(config, state, rateLimiter);

      // Periodic prune (every hour)
      if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
        try {
          pruneStale();
          lastPruneAt = Date.now();
          log('Pruned stale registry entries');
        } catch (e) {
          log(`WARN: Prune failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      writeDaemonState(state);

      // Wait for next poll
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));

    } catch (error) {
      state.errors++;
      state.lastError = error instanceof Error ? error.message : String(error);
      log(`Poll error: ${state.lastError}`);
      writeDaemonState(state);

      // Back off on repeated errors
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs * 2));
    }
  }

  log('Poll loop ended');
}

// ============================================================================
// Daemon Control
// ============================================================================

/**
 * Start the reply listener daemon.
 *
 * Forks a daemon process that derives its config from getNotificationConfig().
 * OMC_* env vars are forwarded so the daemon can read both file and env config.
 *
 * Idempotent: if daemon is already running, returns success.
 *
 * @param config - Daemon config (used only for validation, daemon reads config independently)
 */
export function startReplyListener(_config: ReplyListenerDaemonConfig): DaemonResponse {
  // Check if already running (idempotent)
  if (isDaemonRunning()) {
    const state = readDaemonState();
    return {
      success: true,
      message: 'Reply listener daemon is already running',
      state: state ?? undefined,
    };
  }

  // Check for tmux
  if (!isTmuxAvailable()) {
    return {
      success: false,
      message: 'tmux not available - reply injection requires tmux',
    };
  }

  ensureStateDir();

  // Fork a new process for the daemon
  const modulePath = __filename.replace(/\.ts$/, '.js');
  const daemonScript = `
    import('${modulePath}').then(({ pollLoop }) => {
      return pollLoop();
    }).catch((err) => { console.error(err); process.exit(1); });
  `;

  try {
    const child = spawn('node', ['-e', daemonScript], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: createMinimalDaemonEnv(),
    });

    child.unref();

    const pid = child.pid;
    if (pid) {
      writePidFile(pid);

      const state: ReplyListenerState = {
        isRunning: true,
        pid,
        startedAt: new Date().toISOString(),
        lastPollAt: null,
        telegramLastUpdateId: null,
        discordLastMessageId: null,
        messagesInjected: 0,
        errors: 0,
      };
      writeDaemonState(state);

      log(`Reply listener daemon started with PID ${pid}`);

      return {
        success: true,
        message: `Reply listener daemon started with PID ${pid}`,
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
 * Stop the reply listener daemon
 */
export function stopReplyListener(): DaemonResponse {
  const pid = readPidFile();

  if (pid === null) {
    return {
      success: true,
      message: 'Reply listener daemon is not running',
    };
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    return {
      success: true,
      message: 'Reply listener daemon was not running (cleaned up stale PID file)',
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
    removePidFile();

    const state = readDaemonState();
    if (state) {
      state.isRunning = false;
      state.pid = null;
      writeDaemonState(state);
    }

    log(`Reply listener daemon stopped (PID ${pid})`);

    return {
      success: true,
      message: `Reply listener daemon stopped (PID ${pid})`,
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
export function getReplyListenerStatus(): DaemonResponse {
  const state = readDaemonState();
  const running = isDaemonRunning();

  if (!running && !state) {
    return {
      success: true,
      message: 'Reply listener daemon has never been started',
    };
  }

  if (!running && state) {
    return {
      success: true,
      message: 'Reply listener daemon is not running',
      state: { ...state, isRunning: false, pid: null },
    };
  }

  return {
    success: true,
    message: 'Reply listener daemon is running',
    state: state ?? undefined,
  };
}

// Export pollLoop for use by the daemon subprocess
export { pollLoop };

/**
 * Auto-Update System
 *
 * Provides version checking and auto-update functionality for oh-my-claudecode.
 *
 * Features:
 * - Check for new versions from GitHub releases
 * - Download and install updates automatically
 * - Store version metadata for installed components
 * - Configurable update notifications
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync, execFileSync } from 'child_process';
import { TaskTool } from '../hooks/beads-context/types.js';
import { install as installOmc, HOOKS_DIR, isProjectScopedPlugin, isRunningAsPlugin } from '../installer/index.js';
import { getConfigDir } from '../utils/config-dir.js';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';
import type { NotificationConfig } from '../notifications/types.js';

/** GitHub repository information */
export const REPO_OWNER = 'Yeachan-Heo';
export const REPO_NAME = 'oh-my-claudecode';
export const GITHUB_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
export const GITHUB_RAW_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}`;

/**
 * Best-effort sync of the Claude Code marketplace clone.
 * The marketplace clone at ~/.claude/plugins/marketplaces/omc/ is used by
 * Claude Code to populate the plugin cache. If it's stale, `/plugin install`
 * and cache rebuilds reinstall old versions. (See #506)
 */
function syncMarketplaceClone(verbose: boolean = false): { ok: boolean; message: string } {
  const marketplacePath = join(getConfigDir(), 'plugins', 'marketplaces', 'omc');
  if (!existsSync(marketplacePath)) {
    return { ok: true, message: 'Marketplace clone not found; skipping' };
  }

  const stdio = verbose ? 'inherit' : 'pipe';
  const execOpts = { encoding: 'utf-8' as const, stdio: stdio as any, timeout: 60000 };

  try {
    execFileSync('git', ['-C', marketplacePath, 'fetch', '--all', '--prune'], execOpts);
  } catch (err) {
    return { ok: false, message: `Failed to fetch marketplace clone: ${err instanceof Error ? err.message : err}` };
  }

  // Ensure we're on main (ignore errors for older clones on different branches)
  try { execFileSync('git', ['-C', marketplacePath, 'checkout', 'main'], { ...execOpts, timeout: 15000 }); } catch { /* ignore checkout errors on older clones */ }

  // Reset to upstream state -- the marketplace clone is a managed read-only
  // checkout, so any local modifications (e.g. regenerated dist files) can be
  // safely discarded.  This avoids the "dirty worktree" failure that
  // `git pull --ff-only` would hit when untracked/modified files exist (#978).
  try {
    execFileSync('git', ['-C', marketplacePath, 'reset', '--hard', 'origin/main'], execOpts);
  } catch (err) {
    return { ok: false, message: `Failed to reset marketplace clone: ${err instanceof Error ? err.message : err}` };
  }

  try {
    execFileSync('git', ['-C', marketplacePath, 'clean', '-fd'], execOpts);
  } catch {
    // clean is best-effort; untracked leftovers won't break anything
  }

  return { ok: true, message: 'Marketplace clone updated' };
}

/** Installation paths (respects CLAUDE_CONFIG_DIR env var) */
export const CLAUDE_CONFIG_DIR = getConfigDir();
export const VERSION_FILE = join(CLAUDE_CONFIG_DIR, '.omc-version.json');
export const CONFIG_FILE = join(CLAUDE_CONFIG_DIR, '.omc-config.json');

/**
 * Stop hook callback configuration for file logging
 */
export interface StopCallbackFileConfig {
  enabled: boolean;
  /** File path with placeholders: {session_id}, {date}, {time} */
  path: string;
  /** Output format */
  format?: 'markdown' | 'json';
}

/**
 * Stop hook callback configuration for Telegram
 */
export interface StopCallbackTelegramConfig {
  enabled: boolean;
  /** Telegram bot token */
  botToken?: string;
  /** Chat ID to send messages to */
  chatId?: string;
  /** Optional tags/usernames to prefix in notifications */
  tagList?: string[];
}

/**
 * Stop hook callback configuration for Discord
 */
export interface StopCallbackDiscordConfig {
  enabled: boolean;
  /** Discord webhook URL */
  webhookUrl?: string;
  /** Optional tags/user IDs/roles to prefix in notifications */
  tagList?: string[];
}

/**
 * Stop hook callback configuration for Slack
 */
export interface StopCallbackSlackConfig {
  enabled: boolean;
  /** Slack incoming webhook URL */
  webhookUrl?: string;
  /** Optional tags/mentions to include in notifications */
  tagList?: string[];
}

/**
 * Stop hook callbacks configuration
 */
export interface StopHookCallbacksConfig {
  file?: StopCallbackFileConfig;
  telegram?: StopCallbackTelegramConfig;
  discord?: StopCallbackDiscordConfig;
  slack?: StopCallbackSlackConfig;
}

/**
 * OMC configuration (stored in .omc-config.json)
 */
export interface OMCConfig {
  /** Whether silent auto-updates are enabled (opt-in for security) */
  silentAutoUpdate: boolean;
  /** When the configuration was set */
  configuredAt?: string;
  /** Configuration schema version */
  configVersion?: number;
  /** Preferred task management tool */
  taskTool?: TaskTool;
  /** Configuration for the selected task tool */
  taskToolConfig?: {
    /** Use beads-mcp instead of CLI */
    useMcp?: boolean;
    /** Inject usage instructions at session start (default: true) */
    injectInstructions?: boolean;
  };
  /** Whether initial setup has been completed (ISO timestamp) */
  setupCompleted?: string;
  /** Version of setup wizard that was completed */
  setupVersion?: string;
  /** Stop hook callback configuration (legacy, use notifications instead) */
  stopHookCallbacks?: StopHookCallbacksConfig;
  /** Multi-platform lifecycle notification configuration */
  notifications?: NotificationConfig;
  /** Named notification profiles (keyed by profile name) */
  notificationProfiles?: Record<string, NotificationConfig>;
  /** Whether HUD statusline is enabled (default: true). Set to false to skip HUD installation. */
  hudEnabled?: boolean;
  /** Whether to prompt for upgrade at session start when a new version is available (default: true).
   *  Set to false to show a passive notification instead of an interactive prompt. */
  autoUpgradePrompt?: boolean;
  /** Absolute path to the Node.js binary detected at setup time.
   *  Used by find-node.sh so hooks work for nvm/fnm users where node is not on PATH. */
  nodeBinary?: string;
}

/**
 * Read the OMC configuration
 */
export function getOMCConfig(): OMCConfig {
  if (!existsSync(CONFIG_FILE)) {
    // No config file = disabled by default for security
    return { silentAutoUpdate: false };
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as OMCConfig;
    return {
      silentAutoUpdate: config.silentAutoUpdate ?? false,
      configuredAt: config.configuredAt,
      configVersion: config.configVersion,
      taskTool: config.taskTool,
      taskToolConfig: config.taskToolConfig,
      setupCompleted: config.setupCompleted,
      setupVersion: config.setupVersion,
      stopHookCallbacks: config.stopHookCallbacks,
      notifications: config.notifications,
      notificationProfiles: config.notificationProfiles,
      hudEnabled: config.hudEnabled,
      autoUpgradePrompt: config.autoUpgradePrompt,
    };
  } catch {
    // If config file is invalid, default to disabled for security
    return { silentAutoUpdate: false };
  }
}

/**
 * Check if silent auto-updates are enabled
 */
export function isSilentAutoUpdateEnabled(): boolean {
  return getOMCConfig().silentAutoUpdate;
}

/**
 * Check if auto-upgrade prompt is enabled at session start
 * Returns true by default - users must explicitly opt out
 */
export function isAutoUpgradePromptEnabled(): boolean {
  return getOMCConfig().autoUpgradePrompt !== false;
}

/**
 * Check if team feature is enabled
 * Returns false by default - requires explicit opt-in
 * Checks ~/.claude/settings.json first, then env var fallback
 */
export function isTeamEnabled(): boolean {
  try {
    const settingsPath = join(CLAUDE_CONFIG_DIR, 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const val = settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      if (val === '1' || val === 'true') {
        return true;
      }
    }
  } catch {
    // Fall through to env check
  }
  const envVal = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  return envVal === '1' || envVal === 'true';
}

/**
 * Version metadata stored after installation
 */
export interface VersionMetadata {
  /** Currently installed version */
  version: string;
  /** Installation timestamp */
  installedAt: string;
  /** Last update check timestamp */
  lastCheckAt?: string;
  /** Git commit hash if installed from source */
  commitHash?: string;
  /** Installation method: 'script' | 'npm' | 'source' */
  installMethod: 'script' | 'npm' | 'source';
}

/**
 * GitHub release information
 */
export interface ReleaseInfo {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
}

/**
 * Update check result
 */
export interface UpdateCheckResult {
  currentVersion: string | null;
  latestVersion: string;
  updateAvailable: boolean;
  releaseInfo: ReleaseInfo;
  releaseNotes: string;
}

/**
 * Update result
 */
export interface UpdateResult {
  success: boolean;
  previousVersion: string | null;
  newVersion: string;
  message: string;
  errors?: string[];
}

export interface UpdateReconcileResult {
  success: boolean;
  message: string;
  errors?: string[];
}

/**
 * Read the current version metadata
 */
export function getInstalledVersion(): VersionMetadata | null {
  if (!existsSync(VERSION_FILE)) {
    // Try to detect version from package.json if installed via npm
    try {
      // Check if we can find the package in node_modules
      const result = execSync('npm list -g oh-my-claude-sisyphus --json', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe'
      });
      const data = JSON.parse(result);
      if (data.dependencies?.['oh-my-claude-sisyphus']?.version) {
        return {
          version: data.dependencies['oh-my-claude-sisyphus'].version,
          installedAt: new Date().toISOString(),
          installMethod: 'npm'
        };
      }
    } catch {
      // Not installed via npm or command failed
    }
    return null;
  }

  try {
    const content = readFileSync(VERSION_FILE, 'utf-8');
    return JSON.parse(content) as VersionMetadata;
  } catch (error) {
    console.error('Error reading version file:', error);
    return null;
  }
}

/**
 * Save version metadata after installation/update
 */
export function saveVersionMetadata(metadata: VersionMetadata): void {
  const dir = dirname(VERSION_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(VERSION_FILE, JSON.stringify(metadata, null, 2));
}

/**
 * Update the last check timestamp
 */
export function updateLastCheckTime(): void {
  const current = getInstalledVersion();
  if (current) {
    current.lastCheckAt = new Date().toISOString();
    saveVersionMetadata(current);
  }
}

/**
 * Fetch the latest release from GitHub
 */
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const response = await fetch(`${GITHUB_API_URL}/releases/latest`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'oh-my-claudecode-updater'
    }
  });

  if (response.status === 404) {
    // No releases found - try to get version from package.json in repo
    const pkgResponse = await fetch(`${GITHUB_RAW_URL}/main/package.json`, {
      headers: {
        'User-Agent': 'oh-my-claudecode-updater'
      }
    });

    if (pkgResponse.ok) {
      const pkg = await pkgResponse.json() as { version: string };
      return {
        tag_name: `v${pkg.version}`,
        name: `Version ${pkg.version}`,
        published_at: new Date().toISOString(),
        html_url: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
        body: 'No release notes available (fetched from package.json)',
        prerelease: false,
        draft: false
      };
    }

    throw new Error('No releases found and could not fetch package.json');
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch release info: ${response.status} ${response.statusText}`);
  }

  return await response.json() as ReleaseInfo;
}

/**
 * Compare semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  // Remove 'v' prefix if present
  const cleanA = a.replace(/^v/, '');
  const cleanB = b.replace(/^v/, '');

  const partsA = cleanA.split('.').map(n => parseInt(n, 10) || 0);
  const partsB = cleanB.split('.').map(n => parseInt(n, 10) || 0);

  const maxLength = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLength; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;

    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }

  return 0;
}

/**
 * Check for available updates
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const installed = getInstalledVersion();
  const release = await fetchLatestRelease();

  const currentVersion = installed?.version ?? null;
  const latestVersion = release.tag_name.replace(/^v/, '');

  const updateAvailable = currentVersion === null || compareVersions(currentVersion, latestVersion) < 0;

  // Update last check time
  updateLastCheckTime();

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseInfo: release,
    releaseNotes: release.body || 'No release notes available.'
  };
}

/**
 * Reconcile runtime state after update
 *
 * This is safe to run repeatedly and refreshes local runtime artifacts that may
 * lag behind an updated package or plugin cache.
 */
export function reconcileUpdateRuntime(options?: { verbose?: boolean }): UpdateReconcileResult {
  const errors: string[] = [];

  const projectScopedPlugin = isProjectScopedPlugin();
  if (!projectScopedPlugin) {
    try {
      if (!existsSync(HOOKS_DIR)) {
        mkdirSync(HOOKS_DIR, { recursive: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to prepare hooks directory: ${message}`);
    }
  }

  try {
    const installResult = installOmc({
      force: true,
      verbose: options?.verbose ?? false,
      skipClaudeCheck: true,
      forceHooks: true,
      refreshHooksInPlugin: !projectScopedPlugin,
    });

    if (!installResult.success) {
      errors.push(...installResult.errors);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Failed to refresh installer artifacts: ${message}`);
  }

  // Purge stale plugin cache versions (non-fatal)
  try {
    const purgeResult = purgeStalePluginCacheVersions();
    if (purgeResult.removed > 0 && options?.verbose) {
      console.log(`[omc] Purged ${purgeResult.removed} stale plugin cache version(s)`);
    }
    if (purgeResult.errors.length > 0 && options?.verbose) {
      for (const err of purgeResult.errors) {
        console.warn(`[omc] Cache purge warning: ${err}`);
      }
    }
  } catch {
    // Cache purge is best-effort; never block reconciliation
  }

  if (errors.length > 0) {
    return {
      success: false,
      message: 'Runtime reconciliation failed',
      errors,
    };
  }

  return {
    success: true,
    message: 'Runtime state reconciled successfully',
  };
}

/**
 * Download and execute the install script to perform an update
 */
export async function performUpdate(options?: {
  skipConfirmation?: boolean;
  verbose?: boolean;
  standalone?: boolean;
}): Promise<UpdateResult> {
  const installed = getInstalledVersion();
  const previousVersion = installed?.version ?? null;

  try {
    // Check if running as plugin - prevent npm global update from corrupting plugin
    if (isRunningAsPlugin() && !options?.standalone) {
      return {
        success: false,
        previousVersion,
        newVersion: 'unknown',
        message: 'Running as a Claude Code plugin. Use "/plugin install oh-my-claudecode" to update, or pass --standalone to force npm update.',
      };
    }

    // Fetch the latest release to get the version
    const release = await fetchLatestRelease();
    const newVersion = release.tag_name.replace(/^v/, '');

    // Use npm for updates on all platforms (install.sh was removed)
    try {
      execSync('npm install -g oh-my-claude-sisyphus@latest', {
        encoding: 'utf-8',
        stdio: options?.verbose ? 'inherit' : 'pipe',
        timeout: 120000, // 2 minute timeout for npm
        ...(process.platform === 'win32' ? { windowsHide: true } : {})
      });

      // Sync Claude Code marketplace clone so plugin cache picks up new version (#506)
      const marketplaceSync = syncMarketplaceClone(options?.verbose ?? false);
      if (!marketplaceSync.ok && options?.verbose) {
        console.warn(`[omc update] ${marketplaceSync.message}`);
      }

      // CRITICAL FIX: After npm updates the global package, the current process
      // still has OLD code loaded in memory. We must re-exec to run reconciliation
      // with the NEW code. Otherwise, installOmc() runs OLD logic against NEW files.
      if (!process.env.OMC_UPDATE_RECONCILE) {
        // Set flag to prevent infinite loop
        process.env.OMC_UPDATE_RECONCILE = '1';

        // Find the omc binary path
        const omcPath = execSync('which omc 2>/dev/null || where omc 2>NUL', {
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim().split('\n')[0];

        // Re-exec with reconcile subcommand
        try {
          execFileSync(omcPath, ['update-reconcile'], {
            encoding: 'utf-8',
            stdio: options?.verbose ? 'inherit' : 'pipe',
            timeout: 60000,
            env: { ...process.env, OMC_UPDATE_RECONCILE: '1' }
          });
        } catch (reconcileError) {
          return {
            success: false,
            previousVersion,
            newVersion,
            message: `Updated to ${newVersion}, but runtime reconciliation failed`,
            errors: [reconcileError instanceof Error ? reconcileError.message : String(reconcileError)],
          };
        }

        // Update version metadata after reconciliation succeeds
        saveVersionMetadata({
          version: newVersion,
          installedAt: new Date().toISOString(),
          installMethod: 'npm',
          lastCheckAt: new Date().toISOString()
        });

        return {
          success: true,
          previousVersion,
          newVersion,
          message: `Successfully updated from ${previousVersion ?? 'unknown'} to ${newVersion}`
        };
      } else {
        // We're in the re-exec'd process - run reconciliation directly
        const reconcileResult = reconcileUpdateRuntime({ verbose: options?.verbose });
        if (!reconcileResult.success) {
          return {
            success: false,
            previousVersion,
            newVersion,
            message: `Updated to ${newVersion}, but runtime reconciliation failed`,
            errors: reconcileResult.errors?.map(e => `Reconciliation failed: ${e}`),
          };
        }
        return {
          success: true,
          previousVersion,
          newVersion,
          message: 'Reconciliation completed successfully'
        };
      }
    } catch (npmError) {
      throw new Error(
        'Auto-update via npm failed. Please run manually:\n' +
        '  npm install -g oh-my-claude-sisyphus@latest\n' +
        'Or use: /plugin install oh-my-claudecode\n' +
        `Error: ${npmError instanceof Error ? npmError.message : npmError}`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      previousVersion,
      newVersion: 'unknown',
      message: `Update failed: ${errorMessage}`,
      errors: [errorMessage]
    };
  }
}

/**
 * Get a formatted update notification message
 */
export function formatUpdateNotification(checkResult: UpdateCheckResult): string {
  if (!checkResult.updateAvailable) {
    return `oh-my-claudecode is up to date (v${checkResult.currentVersion ?? 'unknown'})`;
  }

  const lines = [
    '╔═══════════════════════════════════════════════════════════╗',
    '║           oh-my-claudecode Update Available!              ║',
    '╚═══════════════════════════════════════════════════════════╝',
    '',
    `  Current version: ${checkResult.currentVersion ?? 'unknown'}`,
    `  Latest version:  ${checkResult.latestVersion}`,
    '',
    '  To update, run: /update',
    '  Or reinstall via: /plugin install oh-my-claudecode',
    ''
  ];

  // Add truncated release notes if available
  if (checkResult.releaseNotes && checkResult.releaseNotes !== 'No release notes available.') {
    lines.push('  Release notes:');
    const notes = checkResult.releaseNotes.split('\n').slice(0, 5);
    notes.forEach(line => lines.push(`    ${line}`));
    if (checkResult.releaseNotes.split('\n').length > 5) {
      lines.push('    ...');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check if enough time has passed since the last update check
 */
export function shouldCheckForUpdates(intervalHours: number = 24): boolean {
  const installed = getInstalledVersion();

  if (!installed?.lastCheckAt) {
    return true;
  }

  const lastCheck = new Date(installed.lastCheckAt).getTime();
  const now = Date.now();
  const hoursSinceLastCheck = (now - lastCheck) / (1000 * 60 * 60);

  return hoursSinceLastCheck >= intervalHours;
}

/**
 * Perform a background update check (non-blocking)
 */
export function backgroundUpdateCheck(callback?: (result: UpdateCheckResult) => void): void {
  if (!shouldCheckForUpdates()) {
    return;
  }

  // Run the check asynchronously without blocking
  checkForUpdates()
    .then(result => {
      if (callback) {
        callback(result);
      } else if (result.updateAvailable) {
        // Default behavior: print notification to console
        console.log('\n' + formatUpdateNotification(result));
      }
    })
    .catch(error => {
      // Silently ignore errors in background checks
      if (process.env.OMC_DEBUG) {
        console.error('Background update check failed:', error);
      }
    });
}

/**
 * CLI helper: perform interactive update
 */
export async function interactiveUpdate(): Promise<void> {
  console.log('Checking for updates...');

  try {
    const checkResult = await checkForUpdates();

    if (!checkResult.updateAvailable) {
      console.log(`✓ You are running the latest version (${checkResult.currentVersion})`);
      return;
    }

    console.log(formatUpdateNotification(checkResult));
    console.log('Starting update...\n');

    const result = await performUpdate({ verbose: true });

    if (result.success) {
      console.log(`\n✓ ${result.message}`);
      console.log('\nPlease restart your Claude Code session to use the new version.');
    } else {
      console.error(`\n✗ ${result.message}`);
      if (result.errors) {
        result.errors.forEach(err => console.error(`  - ${err}`));
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('Update check failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Silent auto-update configuration
 */
export interface SilentUpdateConfig {
  /** Minimum hours between update checks (default: 24) */
  checkIntervalHours?: number;
  /** Whether to auto-apply updates without confirmation (default: true) */
  autoApply?: boolean;
  /** Log file path for silent update activity (optional) */
  logFile?: string;
  /** Maximum retries on failure (default: 3) */
  maxRetries?: number;
}

/** State file for tracking silent update status */
const SILENT_UPDATE_STATE_FILE = join(CLAUDE_CONFIG_DIR, '.omc-silent-update.json');

interface SilentUpdateState {
  lastAttempt?: string;
  lastSuccess?: string;
  consecutiveFailures: number;
  pendingRestart: boolean;
  lastVersion?: string;
}

/**
 * Read silent update state
 */
function getSilentUpdateState(): SilentUpdateState {
  if (!existsSync(SILENT_UPDATE_STATE_FILE)) {
    return { consecutiveFailures: 0, pendingRestart: false };
  }
  try {
    return JSON.parse(readFileSync(SILENT_UPDATE_STATE_FILE, 'utf-8'));
  } catch {
    return { consecutiveFailures: 0, pendingRestart: false };
  }
}

/**
 * Save silent update state
 */
function saveSilentUpdateState(state: SilentUpdateState): void {
  const dir = dirname(SILENT_UPDATE_STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SILENT_UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Log message to silent update log file (if configured)
 */
function silentLog(message: string, logFile?: string): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  if (logFile) {
    try {
      const dir = dirname(logFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(logFile, logMessage, { flag: 'a' });
    } catch {
      // Silently ignore log errors
    }
  }
}

/**
 * Perform a completely silent update check and installation
 *
 * This function runs without any user interaction or console output.
 * It's designed to be called from hooks or startup scripts to keep
 * the system updated automatically without user awareness.
 *
 * Features:
 * - Rate-limited to prevent excessive checks
 * - Exponential backoff on failures
 * - Optional logging to file for debugging
 * - Tracks pending restart state
 *
 * @param config - Silent update configuration
 * @returns Promise resolving to update result or null if skipped
 */
export async function silentAutoUpdate(config: SilentUpdateConfig = {}): Promise<UpdateResult | null> {
  const {
    checkIntervalHours = 24,
    autoApply = true,
    logFile = join(CLAUDE_CONFIG_DIR, '.omc-update.log'),
    maxRetries = 3
  } = config;

  // SECURITY: Check if silent auto-update is enabled in configuration
  // Default is disabled - users must explicitly opt-in during installation
  if (!isSilentAutoUpdateEnabled()) {
    silentLog('Silent auto-update is disabled (run installer to enable, or use /update)', logFile);
    return null;
  }

  const state = getSilentUpdateState();

  // Check rate limiting
  if (!shouldCheckForUpdates(checkIntervalHours)) {
    return null;
  }

  // Check for consecutive failures and apply exponential backoff
  if (state.consecutiveFailures >= maxRetries) {
    const backoffHours = Math.min(24 * state.consecutiveFailures, 168); // Max 1 week
    const lastAttempt = state.lastAttempt ? new Date(state.lastAttempt).getTime() : 0;
    const hoursSinceLastAttempt = (Date.now() - lastAttempt) / (1000 * 60 * 60);

    if (hoursSinceLastAttempt < backoffHours) {
      silentLog(`Skipping update check (in backoff period: ${backoffHours}h)`, logFile);
      return null;
    }
  }

  silentLog('Starting silent update check...', logFile);
  state.lastAttempt = new Date().toISOString();

  try {
    // Check for updates
    const checkResult = await checkForUpdates();

    if (!checkResult.updateAvailable) {
      silentLog(`No update available (current: ${checkResult.currentVersion})`, logFile);
      state.consecutiveFailures = 0;
      state.pendingRestart = false;
      saveSilentUpdateState(state);
      return null;
    }

    silentLog(`Update available: ${checkResult.currentVersion} -> ${checkResult.latestVersion}`, logFile);

    if (!autoApply) {
      silentLog('Auto-apply disabled, skipping installation', logFile);
      return null;
    }

    // Perform the update silently
    const result = await performUpdate({
      skipConfirmation: true,
      verbose: false
    });

    if (result.success) {
      silentLog(`Update successful: ${result.previousVersion} -> ${result.newVersion}`, logFile);
      state.consecutiveFailures = 0;
      state.pendingRestart = true;
      state.lastSuccess = new Date().toISOString();
      state.lastVersion = result.newVersion;
      saveSilentUpdateState(state);
      return result;
    } else {
      silentLog(`Update failed: ${result.message}`, logFile);
      state.consecutiveFailures++;
      saveSilentUpdateState(state);
      return result;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    silentLog(`Update check error: ${errorMessage}`, logFile);
    state.consecutiveFailures++;
    saveSilentUpdateState(state);
    return {
      success: false,
      previousVersion: null,
      newVersion: 'unknown',
      message: `Silent update failed: ${errorMessage}`,
      errors: [errorMessage]
    };
  }
}

/**
 * Check if there's a pending restart after a silent update
 */
export function hasPendingUpdateRestart(): boolean {
  const state = getSilentUpdateState();
  return state.pendingRestart;
}

/**
 * Clear the pending restart flag (call after notifying user or restart)
 */
export function clearPendingUpdateRestart(): void {
  const state = getSilentUpdateState();
  state.pendingRestart = false;
  saveSilentUpdateState(state);
}

/**
 * Get the version that was silently updated to (if pending restart)
 */
export function getPendingUpdateVersion(): string | null {
  const state = getSilentUpdateState();
  return state.pendingRestart ? (state.lastVersion ?? null) : null;
}

/**
 * Initialize silent auto-update on startup
 *
 * This is the main entry point for the silent update system.
 * Call this function once when the application starts or from a hook.
 * It runs the update check completely in the background without blocking.
 *
 * @param config - Silent update configuration
 */
export function initSilentAutoUpdate(config: SilentUpdateConfig = {}): void {
  // Run update check in background without blocking
  silentAutoUpdate(config).catch(() => {
    // Silently ignore any errors - they're already logged
  });
}

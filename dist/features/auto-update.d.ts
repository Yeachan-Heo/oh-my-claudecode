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
import { TaskTool } from '../hooks/beads-context/types.js';
/** GitHub repository information */
export declare const REPO_OWNER = "Yeachan-Heo";
export declare const REPO_NAME = "oh-my-claudecode";
export declare const GITHUB_API_URL = "https://api.github.com/repos/Yeachan-Heo/oh-my-claudecode";
export declare const GITHUB_RAW_URL = "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode";
/** Installation paths */
export declare const CLAUDE_CONFIG_DIR: string;
export declare const VERSION_FILE: string;
export declare const CONFIG_FILE: string;
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
}
/**
 * Stop hook callback configuration for Discord
 */
export interface StopCallbackDiscordConfig {
    enabled: boolean;
    /** Discord webhook URL */
    webhookUrl?: string;
}
/**
 * Stop hook callbacks configuration
 */
export interface StopHookCallbacksConfig {
    file?: StopCallbackFileConfig;
    telegram?: StopCallbackTelegramConfig;
    discord?: StopCallbackDiscordConfig;
}
/**
 * OMC configuration (stored in .omc-config.json)
 */
export interface SisyphusConfig {
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
    /** Preferred execution mode for parallel work (set by omc-setup Step 3.7) */
    defaultExecutionMode?: 'ultrawork' | 'ecomode';
    /** Ecomode-specific configuration */
    ecomode?: {
        /** Whether ecomode is enabled (default: true). Set to false to disable ecomode completely. */
        enabled?: boolean;
    };
    /** Whether initial setup has been completed (ISO timestamp) */
    setupCompleted?: string;
    /** Version of setup wizard that was completed */
    setupVersion?: string;
    /** Stop hook callback configuration */
    stopHookCallbacks?: StopHookCallbacksConfig;
}
/**
 * Read the Sisyphus configuration
 */
export declare function getSisyphusConfig(): SisyphusConfig;
/**
 * Check if silent auto-updates are enabled
 */
export declare function isSilentAutoUpdateEnabled(): boolean;
/**
 * Check if ecomode is enabled
 * Returns true by default if not explicitly disabled
 */
export declare function isEcomodeEnabled(): boolean;
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
export declare function getInstalledVersion(): VersionMetadata | null;
/**
 * Save version metadata after installation/update
 */
export declare function saveVersionMetadata(metadata: VersionMetadata): void;
/**
 * Update the last check timestamp
 */
export declare function updateLastCheckTime(): void;
/**
 * Fetch the latest release from GitHub
 */
export declare function fetchLatestRelease(): Promise<ReleaseInfo>;
/**
 * Compare semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export declare function compareVersions(a: string, b: string): number;
/**
 * Check for available updates
 */
export declare function checkForUpdates(): Promise<UpdateCheckResult>;
/**
 * Reconcile runtime state after update
 *
 * This is safe to run repeatedly and refreshes local runtime artifacts that may
 * lag behind an updated package or plugin cache.
 */
export declare function reconcileUpdateRuntime(options?: {
    verbose?: boolean;
}): UpdateReconcileResult;
/**
 * Download and execute the install script to perform an update
 */
export declare function performUpdate(options?: {
    skipConfirmation?: boolean;
    verbose?: boolean;
    standalone?: boolean;
}): Promise<UpdateResult>;
/**
 * Get a formatted update notification message
 */
export declare function formatUpdateNotification(checkResult: UpdateCheckResult): string;
/**
 * Check if enough time has passed since the last update check
 */
export declare function shouldCheckForUpdates(intervalHours?: number): boolean;
/**
 * Perform a background update check (non-blocking)
 */
export declare function backgroundUpdateCheck(callback?: (result: UpdateCheckResult) => void): void;
/**
 * CLI helper: perform interactive update
 */
export declare function interactiveUpdate(): Promise<void>;
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
export declare function silentAutoUpdate(config?: SilentUpdateConfig): Promise<UpdateResult | null>;
/**
 * Check if there's a pending restart after a silent update
 */
export declare function hasPendingUpdateRestart(): boolean;
/**
 * Clear the pending restart flag (call after notifying user or restart)
 */
export declare function clearPendingUpdateRestart(): void;
/**
 * Get the version that was silently updated to (if pending restart)
 */
export declare function getPendingUpdateVersion(): string | null;
/**
 * Initialize silent auto-update on startup
 *
 * This is the main entry point for the silent update system.
 * Call this function once when the application starts or from a hook.
 * It runs the update check completely in the background without blocking.
 *
 * @param config - Silent update configuration
 */
export declare function initSilentAutoUpdate(config?: SilentUpdateConfig): void;
//# sourceMappingURL=auto-update.d.ts.map
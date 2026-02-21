/**
 * OMC HUD - State Management
 *
 * Manages HUD state file for background task tracking.
 * Follows patterns from ultrawork-state.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import { DEFAULT_HUD_CONFIG, PRESET_CONFIGS } from './types.js';
import { cleanupStaleBackgroundTasks, markOrphanedTasksAsStale } from './background-cleanup.js';
// ============================================================================
// Path Helpers
// ============================================================================
/**
 * Get the HUD state file path in the project's .omc/state directory
 */
function getLocalStateFilePath(directory) {
    const baseDir = directory || process.cwd();
    const omcStateDir = join(baseDir, '.omc', 'state');
    return join(omcStateDir, 'hud-state.json');
}
/**
 * Get Claude Code settings.json path
 */
function getSettingsFilePath() {
    return join(getClaudeConfigDir(), 'settings.json');
}
/**
 * Get the HUD config file path (legacy)
 */
function getConfigFilePath() {
    return join(getClaudeConfigDir(), '.omc', 'hud-config.json');
}
/**
 * Ensure the .omc/state directory exists
 */
function ensureStateDir(directory) {
    const baseDir = directory || process.cwd();
    const omcStateDir = join(baseDir, '.omc', 'state');
    if (!existsSync(omcStateDir)) {
        mkdirSync(omcStateDir, { recursive: true });
    }
}
// ============================================================================
// HUD State Operations
// ============================================================================
/**
 * Read HUD state from disk (checks new local and legacy local only)
 */
export function readHudState(directory) {
    // Check new local state first (.omc/state/hud-state.json)
    const localStateFile = getLocalStateFilePath(directory);
    if (existsSync(localStateFile)) {
        try {
            const content = readFileSync(localStateFile, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            // Fall through to legacy check
        }
    }
    // Check legacy local state (.omc/hud-state.json)
    const baseDir = directory || process.cwd();
    const legacyStateFile = join(baseDir, '.omc', 'hud-state.json');
    if (existsSync(legacyStateFile)) {
        try {
            const content = readFileSync(legacyStateFile, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            return null;
        }
    }
    return null;
}
/**
 * Write HUD state to disk (local only)
 */
export function writeHudState(state, directory) {
    try {
        // Write to local .omc/state only
        ensureStateDir(directory);
        const localStateFile = getLocalStateFilePath(directory);
        writeFileSync(localStateFile, JSON.stringify(state, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Create a new empty HUD state
 */
export function createEmptyHudState() {
    return {
        timestamp: new Date().toISOString(),
        backgroundTasks: [],
    };
}
/**
 * Get running background tasks from state
 */
export function getRunningTasks(state) {
    if (!state)
        return [];
    return state.backgroundTasks.filter((task) => task.status === 'running');
}
/**
 * Get background task count string (e.g., "3/5")
 */
export function getBackgroundTaskCount(state) {
    const MAX_CONCURRENT = 5;
    const running = state
        ? state.backgroundTasks.filter((t) => t.status === 'running').length
        : 0;
    return { running, max: MAX_CONCURRENT };
}
// ============================================================================
// HUD Config Operations
// ============================================================================
/**
 * Read HUD configuration from disk.
 * Priority: settings.json > hud-config.json (legacy) > defaults
 */
export function readHudConfig() {
    // 1. Try reading from ~/.claude/settings.json (omcHud key)
    const settingsFile = getSettingsFilePath();
    if (existsSync(settingsFile)) {
        try {
            const content = readFileSync(settingsFile, 'utf-8');
            const settings = JSON.parse(content);
            if (settings.omcHud) {
                const config = settings.omcHud;
                return mergeWithDefaults(config);
            }
        }
        catch {
            // Fall through to legacy config
        }
    }
    // 2. Try reading from ~/.claude/.omc/hud-config.json (legacy)
    const configFile = getConfigFilePath();
    if (existsSync(configFile)) {
        try {
            const content = readFileSync(configFile, 'utf-8');
            const config = JSON.parse(content);
            return mergeWithDefaults(config);
        }
        catch {
            // Fall through to defaults
        }
    }
    // 3. Return defaults
    return DEFAULT_HUD_CONFIG;
}
/**
 * Merge partial config with defaults
 */
function mergeWithDefaults(config) {
    const preset = config.preset ?? DEFAULT_HUD_CONFIG.preset;
    const presetElements = PRESET_CONFIGS[preset] ?? {};
    return {
        preset,
        elements: {
            ...DEFAULT_HUD_CONFIG.elements, // Base defaults
            ...presetElements, // Preset overrides
            ...config.elements, // User overrides
        },
        thresholds: {
            ...DEFAULT_HUD_CONFIG.thresholds,
            ...config.thresholds,
        },
        staleTaskThresholdMinutes: config.staleTaskThresholdMinutes ?? DEFAULT_HUD_CONFIG.staleTaskThresholdMinutes,
        contextLimitWarning: {
            ...DEFAULT_HUD_CONFIG.contextLimitWarning,
            ...config.contextLimitWarning,
        },
        ...(config.rateLimitsProvider ? { rateLimitsProvider: config.rateLimitsProvider } : {}),
    };
}
/**
 * Write HUD configuration to ~/.claude/settings.json (omcHud key)
 */
export function writeHudConfig(config) {
    try {
        const settingsFile = getSettingsFilePath();
        let settings = {};
        // Read existing settings
        if (existsSync(settingsFile)) {
            const content = readFileSync(settingsFile, 'utf-8');
            settings = JSON.parse(content);
        }
        // Update omcHud key
        settings.omcHud = config;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Apply a preset to the configuration
 */
export function applyPreset(preset) {
    const config = readHudConfig();
    const presetElements = PRESET_CONFIGS[preset];
    const newConfig = {
        ...config,
        preset,
        elements: {
            ...config.elements,
            ...presetElements,
        },
    };
    writeHudConfig(newConfig);
    return newConfig;
}
/**
 * Initialize HUD state with cleanup of stale/orphaned tasks.
 * Should be called on HUD startup.
 */
export async function initializeHUDState() {
    // Clean up stale background tasks from previous sessions
    const removedStale = await cleanupStaleBackgroundTasks();
    const markedOrphaned = await markOrphanedTasksAsStale();
    if (removedStale > 0 || markedOrphaned > 0) {
        console.error(`HUD cleanup: removed ${removedStale} stale tasks, marked ${markedOrphaned} orphaned tasks`);
    }
}
//# sourceMappingURL=state.js.map
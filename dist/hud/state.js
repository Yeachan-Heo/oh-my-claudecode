/**
 * OMC HUD - State Management
 *
 * Manages HUD state file for background task tracking.
 * Follows patterns from ultrawork-state.
 */
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getClaudeConfigDir } from "../utils/paths.js";
import { validateWorkingDirectory, getOmcRoot } from "../lib/worktree-paths.js";
import { atomicWriteFileSync, atomicWriteJsonSync, } from "../lib/atomic-write.js";
import { DEFAULT_HUD_CONFIG, PRESET_CONFIGS } from "./types.js";
import { DEFAULT_MISSION_BOARD_CONFIG } from "./mission-board.js";
import { cleanupStaleBackgroundTasks, markOrphanedTasksAsStale, } from "./background-cleanup.js";
// ============================================================================
// Path Helpers
// ============================================================================
/**
 * Get the HUD state file path in the project's .omc/state directory
 */
function getLocalStateFilePath(directory) {
    const baseDir = validateWorkingDirectory(directory);
    const omcStateDir = join(getOmcRoot(baseDir), "state");
    return join(omcStateDir, "hud-state.json");
}
/**
 * Get Claude Code settings.json path
 */
function getSettingsFilePath() {
    return join(getClaudeConfigDir(), "settings.json");
}
/**
 * Get the HUD config file path (legacy)
 */
function getConfigFilePath() {
    return join(getClaudeConfigDir(), ".omc", "hud-config.json");
}
function readJsonFile(filePath) {
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
function getLegacyHudConfig() {
    return readJsonFile(getConfigFilePath());
}
function mergeElements(primary, secondary) {
    return {
        ...(primary ?? {}),
        ...(secondary ?? {}),
    };
}
function mergeThresholds(primary, secondary) {
    return {
        ...(primary ?? {}),
        ...(secondary ?? {}),
    };
}
function mergeContextLimitWarning(primary, secondary) {
    return {
        ...(primary ?? {}),
        ...(secondary ?? {}),
    };
}
function mergeMissionBoardConfig(primary, secondary) {
    return {
        ...(primary ?? {}),
        ...(secondary ?? {}),
    };
}
function mergeElementsForWrite(legacyElements, nextElements) {
    const merged = { ...(legacyElements ?? {}) };
    for (const [key, value] of Object.entries(nextElements)) {
        const defaultValue = DEFAULT_HUD_CONFIG.elements[key];
        const legacyValue = legacyElements?.[key];
        merged[key] =
            value === defaultValue && legacyValue !== undefined ? legacyValue : value;
    }
    return merged;
}
/**
 * Ensure the .omc/state directory exists
 */
function ensureStateDir(directory) {
    const baseDir = validateWorkingDirectory(directory);
    const omcStateDir = join(getOmcRoot(baseDir), "state");
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
            const content = readFileSync(localStateFile, "utf-8");
            return JSON.parse(content);
        }
        catch (error) {
            console.error("[HUD] Failed to read local state:", error instanceof Error ? error.message : error);
            // Fall through to legacy check
        }
    }
    // Check legacy local state (.omc/hud-state.json)
    const baseDir = validateWorkingDirectory(directory);
    const legacyStateFile = join(getOmcRoot(baseDir), "hud-state.json");
    if (existsSync(legacyStateFile)) {
        try {
            const content = readFileSync(legacyStateFile, "utf-8");
            return JSON.parse(content);
        }
        catch (error) {
            console.error("[HUD] Failed to read legacy state:", error instanceof Error ? error.message : error);
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
        atomicWriteJsonSync(localStateFile, state);
        return true;
    }
    catch (error) {
        console.error("[HUD] Failed to write state:", error instanceof Error ? error.message : error);
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
    return state.backgroundTasks.filter((task) => task.status === "running");
}
/**
 * Get background task count string (e.g., "3/5")
 */
export function getBackgroundTaskCount(state) {
    const MAX_CONCURRENT = 5;
    const running = state
        ? state.backgroundTasks.filter((t) => t.status === "running").length
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
    const settingsFile = getSettingsFilePath();
    const legacyConfig = getLegacyHudConfig();
    if (existsSync(settingsFile)) {
        try {
            const content = readFileSync(settingsFile, "utf-8");
            const settings = JSON.parse(content);
            if (settings.omcHud) {
                return mergeWithDefaults({
                    ...legacyConfig,
                    ...settings.omcHud,
                    elements: mergeElements(legacyConfig?.elements, settings.omcHud.elements),
                    thresholds: mergeThresholds(legacyConfig?.thresholds, settings.omcHud.thresholds),
                    contextLimitWarning: mergeContextLimitWarning(legacyConfig?.contextLimitWarning, settings.omcHud.contextLimitWarning),
                    missionBoard: mergeMissionBoardConfig(legacyConfig?.missionBoard, settings.omcHud.missionBoard),
                });
            }
        }
        catch (error) {
            console.error("[HUD] Failed to read settings.json:", error instanceof Error ? error.message : error);
        }
    }
    if (legacyConfig) {
        return mergeWithDefaults(legacyConfig);
    }
    return DEFAULT_HUD_CONFIG;
}
/**
 * Merge partial config with defaults
 */
function mergeWithDefaults(config) {
    const preset = config.preset ?? DEFAULT_HUD_CONFIG.preset;
    const presetElements = PRESET_CONFIGS[preset] ?? {};
    const missionBoardEnabled = config.missionBoard?.enabled ??
        config.elements?.missionBoard ??
        DEFAULT_HUD_CONFIG.missionBoard?.enabled ??
        false;
    const missionBoard = {
        ...DEFAULT_MISSION_BOARD_CONFIG,
        ...DEFAULT_HUD_CONFIG.missionBoard,
        ...config.missionBoard,
        enabled: missionBoardEnabled,
    };
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
        staleTaskThresholdMinutes: config.staleTaskThresholdMinutes ??
            DEFAULT_HUD_CONFIG.staleTaskThresholdMinutes,
        contextLimitWarning: {
            ...DEFAULT_HUD_CONFIG.contextLimitWarning,
            ...config.contextLimitWarning,
        },
        missionBoard,
        usageApiPollIntervalMs: config.usageApiPollIntervalMs ??
            DEFAULT_HUD_CONFIG.usageApiPollIntervalMs,
        wrapMode: config.wrapMode ?? DEFAULT_HUD_CONFIG.wrapMode,
        ...(config.rateLimitsProvider
            ? { rateLimitsProvider: config.rateLimitsProvider }
            : {}),
        ...(config.maxWidth != null ? { maxWidth: config.maxWidth } : {}),
    };
}
/**
 * Write HUD configuration to ~/.claude/settings.json (omcHud key)
 */
export function writeHudConfig(config) {
    try {
        const settingsFile = getSettingsFilePath();
        const legacyConfig = getLegacyHudConfig();
        let settings = {};
        if (existsSync(settingsFile)) {
            const content = readFileSync(settingsFile, "utf-8");
            settings = JSON.parse(content);
        }
        const mergedConfig = mergeWithDefaults({
            ...legacyConfig,
            ...config,
            elements: mergeElementsForWrite(legacyConfig?.elements, config.elements),
            thresholds: mergeThresholds(legacyConfig?.thresholds, config.thresholds),
            contextLimitWarning: mergeContextLimitWarning(legacyConfig?.contextLimitWarning, config.contextLimitWarning),
            missionBoard: mergeMissionBoardConfig(legacyConfig?.missionBoard, config.missionBoard),
        });
        settings.omcHud = mergedConfig;
        atomicWriteFileSync(settingsFile, JSON.stringify(settings, null, 2));
        return true;
    }
    catch (error) {
        console.error("[HUD] Failed to write config:", error instanceof Error ? error.message : error);
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
/**
 * Hook Notification Config Reader
 *
 * Reads omc_config.hook.json for user-customizable message templates.
 * Follows the OpenClaw config reader pattern (file-based, cached).
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getClaudeConfigDir } from "../utils/config-dir.js";
const DEFAULT_CONFIG_PATH = join(getClaudeConfigDir(), "omc_config.hook.json");
/** Cached hook config. `undefined` = not yet read, `null` = read but absent/disabled. */
let cachedConfig;
/**
 * Read and cache the hook notification config.
 *
 * - Returns null when file does not exist (no error)
 * - Returns null when file has `enabled: false`
 * - Caches after first read for performance
 * - File path overridable via OMC_HOOK_CONFIG env var (for testing)
 */
export function getHookConfig() {
    if (cachedConfig !== undefined)
        return cachedConfig;
    const configPath = process.env.OMC_HOOK_CONFIG || DEFAULT_CONFIG_PATH;
    if (!existsSync(configPath)) {
        cachedConfig = null;
        return null;
    }
    try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || raw.enabled === false) {
            cachedConfig = null;
            return null;
        }
        cachedConfig = raw;
        return cachedConfig;
    }
    catch {
        cachedConfig = null;
        return null;
    }
}
/**
 * Clear the cached hook config. Call in tests to reset state.
 */
export function resetHookConfigCache() {
    cachedConfig = undefined;
}
/**
 * Resolve the template for a specific event and platform.
 *
 * Cascade: platform override > event template > defaultTemplate > null
 */
export function resolveEventTemplate(hookConfig, event, platform) {
    if (!hookConfig)
        return null;
    const eventConfig = hookConfig.events?.[event];
    if (eventConfig) {
        // Platform-specific override
        const platformOverride = eventConfig.platforms?.[platform];
        if (platformOverride?.template)
            return platformOverride.template;
        // Event-level template
        if (eventConfig.template)
            return eventConfig.template;
    }
    // Global default template
    return hookConfig.defaultTemplate || null;
}
/**
 * Merge hook config event enabled/disabled flags into a NotificationConfig.
 *
 * Hook config takes precedence for event gating:
 * - hook event `enabled: false` overrides `.omc-config.json` event `enabled: true`
 * - Platform credentials are NOT affected (they stay in .omc-config.json)
 */
export function mergeHookConfigIntoNotificationConfig(hookConfig, notifConfig) {
    if (!hookConfig.events)
        return notifConfig;
    const merged = { ...notifConfig };
    const events = { ...(merged.events || {}) };
    for (const [eventName, hookEventConfig] of Object.entries(hookConfig.events)) {
        if (!hookEventConfig)
            continue;
        const event = eventName;
        const existing = events[event];
        events[event] = {
            ...(existing || {}),
            enabled: hookEventConfig.enabled,
        };
    }
    merged.events = events;
    return merged;
}
//# sourceMappingURL=hook-config.js.map
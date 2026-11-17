/**
 * Hook Notification Config Reader
 *
 * Reads omc_config.hook.json for user-customizable message templates.
 * Follows the OpenClaw config reader pattern (file-based, cached).
 */
import type { HookNotificationConfig } from "./hook-config-types.js";
import type { NotificationConfig, NotificationEvent, NotificationPlatform } from "./types.js";
/**
 * Read and cache the hook notification config.
 *
 * - Returns null when file does not exist (no error)
 * - Returns null when file has `enabled: false`
 * - Caches after first read for performance
 * - File path overridable via OMC_HOOK_CONFIG env var (for testing)
 */
export declare function getHookConfig(): HookNotificationConfig | null;
/**
 * Clear the cached hook config. Call in tests to reset state.
 */
export declare function resetHookConfigCache(): void;
/**
 * Resolve the template for a specific event and platform.
 *
 * Cascade: platform override > event template > defaultTemplate > null
 */
export declare function resolveEventTemplate(hookConfig: HookNotificationConfig | null, event: NotificationEvent, platform: NotificationPlatform): string | null;
/**
 * Merge hook config event enabled/disabled flags into a NotificationConfig.
 *
 * Hook config takes precedence for event gating:
 * - hook event `enabled: false` overrides `.omc-config.json` event `enabled: true`
 * - Platform credentials are NOT affected (they stay in .omc-config.json)
 */
export declare function mergeHookConfigIntoNotificationConfig(hookConfig: HookNotificationConfig, notifConfig: NotificationConfig): NotificationConfig;
//# sourceMappingURL=hook-config.d.ts.map
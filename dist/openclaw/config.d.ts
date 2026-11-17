/**
 * OpenClaw Configuration Reader
 *
 * Reads OpenClaw config from ~/.claude/omc_config.openclaw.json.
 * Config is cached after first read (env vars don't change during process lifetime).
 * Config file path can be overridden via OMC_OPENCLAW_CONFIG env var.
 */
import type { OpenClawConfig, OpenClawHookEvent, OpenClawGatewayConfig } from "./types.js";
/**
 * Read and cache the OpenClaw configuration.
 *
 * Returns null when:
 * - OMC_OPENCLAW env var is not "1"
 * - Config file does not exist
 * - Config file is invalid JSON
 * - Config has enabled: false
 */
export declare function getOpenClawConfig(): OpenClawConfig | null;
/**
 * Resolve gateway config for a specific hook event.
 * Returns null if the event is not mapped or disabled.
 * Returns the gateway name alongside config to avoid O(n) reverse lookup.
 */
export declare function resolveGateway(config: OpenClawConfig, event: OpenClawHookEvent): {
    gatewayName: string;
    gateway: OpenClawGatewayConfig;
    instruction: string;
} | null;
/**
 * Reset the config cache (for testing only).
 */
export declare function resetOpenClawConfigCache(): void;
//# sourceMappingURL=config.d.ts.map
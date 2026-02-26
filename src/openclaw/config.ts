/**
 * OpenClaw Configuration Reader
 *
 * Reads OpenClaw config from ~/.claude/omc_config.openclaw.json.
 * Config is cached after first read (env vars don't change during process lifetime).
 * Config file path can be overridden via OMC_OPENCLAW_CONFIG env var.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getClaudeConfigDir } from "../utils/paths.js";
import type { OpenClawConfig, OpenClawHookEvent, OpenClawGatewayConfig, OpenClawCommandGatewayConfig } from "./types.js";

const CONFIG_FILE = process.env.OMC_OPENCLAW_CONFIG
  || join(getClaudeConfigDir(), "omc_config.openclaw.json");

/** Cached config (null = not yet read, undefined = read but file missing/invalid) */
let _cachedConfig: OpenClawConfig | undefined | null = null;

/**
 * Read and cache the OpenClaw configuration.
 *
 * Returns null when:
 * - OMC_OPENCLAW env var is not "1"
 * - Config file does not exist
 * - Config file is invalid JSON
 * - Config has enabled: false
 */
export function getOpenClawConfig(): OpenClawConfig | null {
  // Gate: only active when --openclaw flag was used
  if (process.env.OMC_OPENCLAW !== "1") {
    return null;
  }

  // Return cached result
  if (_cachedConfig !== null) {
    return _cachedConfig ?? null;
  }

  if (!existsSync(CONFIG_FILE)) {
    _cachedConfig = undefined;
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as OpenClawConfig;
    if (!raw.enabled || !raw.gateways || !raw.hooks) {
      _cachedConfig = undefined;
      return null;
    }
    _cachedConfig = raw;
    return raw;
  } catch {
    _cachedConfig = undefined;
    return null;
  }
}

/**
 * Resolve gateway config for a specific hook event.
 * Returns null if the event is not mapped or disabled.
 * Returns the gateway name alongside config to avoid O(n) reverse lookup.
 */
export function resolveGateway(
  config: OpenClawConfig,
  event: OpenClawHookEvent,
): { gatewayName: string; gateway: OpenClawGatewayConfig; instruction: string } | null {
  const mapping = config.hooks[event];
  if (!mapping || !mapping.enabled) {
    return null;
  }

  const gateway = config.gateways[mapping.gateway];
  if (!gateway) {
    return null;
  }
  // Validate based on gateway type
  if ((gateway as OpenClawCommandGatewayConfig).type === "command") {
    if (!(gateway as OpenClawCommandGatewayConfig).command) return null;
  } else {
    // HTTP gateway (default when type is absent or "http")
    if (!("url" in gateway) || !gateway.url) return null;
  }

  return { gatewayName: mapping.gateway, gateway, instruction: mapping.instruction };
}

/**
 * Reset the config cache (for testing only).
 */
export function resetOpenClawConfigCache(): void {
  _cachedConfig = null;
}

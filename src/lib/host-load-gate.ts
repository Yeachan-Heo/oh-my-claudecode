/**
 * Host Load Gate for Cross-Session Resource Contention
 *
 * Observes real host state (CPU load, free memory) and counts live sibling
 * OMC sessions to gate expensive operations (browser launches, test runners,
 * package installs) when the host is saturated or too many sessions are active.
 *
 * Fails open: never deadlocks, never blocks when metrics are unavailable.
 * Disable-able via OMC_HOST_LOAD_GATE_DISABLED environment variable.
 */

import { cpus, freemem, loadavg, totalmem } from 'os';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getGlobalOmcStateRoot } from '../utils/paths.js';

/**
 * Configuration for host load gating.
 * All thresholds are configurable via environment variables.
 */
export interface HostLoadGateConfig {
  /** CPU load average threshold (cores-relative). Disable with negative value. */
  cpuLoadThreshold: number;

  /** Free memory threshold in bytes. Disable with negative value. */
  freeMemoryThreshold: number;

  /** Maximum sibling sessions before gating. Disable with negative value. */
  maxSiblingSessions: number;

  /** Whether gating is enabled. */
  enabled: boolean;

  /** Maximum time to wait before timing out and failing open (ms). */
  gateTimeoutMs: number;

  /** Interval to check host state before retrying (ms). */
  checkIntervalMs: number;
}

/**
 * Result of a host load gate check.
 */
export interface HostLoadGateResult {
  /** Whether the operation is allowed to proceed. */
  allowed: boolean;

  /** Reason why the operation was gated (if not allowed). */
  reason?: string;

  /** Recommended wait time in ms before retrying (if not allowed). */
  waitMs?: number;

  /** Host state metrics at the time of check. */
  metrics: {
    cpuLoad: number;
    freeMemoryBytes: number;
    totalMemoryBytes: number;
    freeMemoryPercent: number;
    siblingSessions: number;
  };
}

/**
 * Default configuration for host load gating.
 * Thresholds are conservative to allow most operations through.
 */
export function getDefaultGateConfig(): HostLoadGateConfig {
  return {
    // CPU load threshold: 80% of available cores
    cpuLoadThreshold: cpus().length * 0.8,

    // Free memory threshold: 256 MB (allow through if more than this free)
    freeMemoryThreshold: 256 * 1024 * 1024,

    // Max sibling sessions: 8 (allow 8+ concurrent sessions)
    maxSiblingSessions: 8,

    // Gate is enabled by default
    enabled: !process.env['OMC_HOST_LOAD_GATE_DISABLED'],

    // Default timeout: 30 seconds
    gateTimeoutMs: 30_000,

    // Check interval: 2 seconds
    checkIntervalMs: 2_000,
  };
}

/**
 * Parse configuration from environment variables.
 * Environment variables override defaults:
 * - OMC_HOST_LOAD_THRESHOLD: CPU load threshold (float)
 * - OMC_FREE_MEMORY_THRESHOLD: Free memory in MB (int)
 * - OMC_MAX_SIBLING_SESSIONS: Max sibling sessions (int)
 * - OMC_HOST_LOAD_GATE_DISABLED: Disable gating entirely (any value disables)
 */
export function parseGateConfig(overrides?: Partial<HostLoadGateConfig>): HostLoadGateConfig {
  const defaults = getDefaultGateConfig();

  const config: HostLoadGateConfig = {
    cpuLoadThreshold: parseFloatEnv('OMC_HOST_LOAD_THRESHOLD') ?? defaults.cpuLoadThreshold,
    freeMemoryThreshold: parseIntEnv('OMC_FREE_MEMORY_THRESHOLD')
      ? parseIntEnv('OMC_FREE_MEMORY_THRESHOLD')! * 1024 * 1024
      : defaults.freeMemoryThreshold,
    maxSiblingSessions: parseIntEnv('OMC_MAX_SIBLING_SESSIONS') ?? defaults.maxSiblingSessions,
    enabled: defaults.enabled,
    gateTimeoutMs: defaults.gateTimeoutMs,
    checkIntervalMs: defaults.checkIntervalMs,
    ...overrides,
  };

  return config;
}

function parseFloatEnv(key: string): number | null {
  const val = process.env[key];
  if (!val) return null;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? null : parsed;
}

function parseIntEnv(key: string): number | null {
  const val = process.env[key];
  if (!val) return null;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Count live sibling OMC sessions on this host.
 * Scans .omc/state/sessions/ for directories, treating each as a session.
 * Returns 0 if the state directory doesn't exist (fails open).
 */
export function countLiveSessions(): number {
  try {
    const stateRoot = getGlobalOmcStateRoot();
    const sessionsDir = join(stateRoot, 'sessions');

    if (!existsSync(sessionsDir)) {
      return 0;
    }

    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    // Count only directories (each directory is one session)
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    // Fail open: if we can't count sessions, assume zero
    return 0;
  }
}

/**
 * Get current host metrics (CPU load, free memory, sibling sessions).
 * Returns 0/defaults if metrics are unavailable (fails open).
 */
export function getHostMetrics() {
  try {
    const loads = loadavg();
    const cpuLoad = loads[0]; // 1-minute load average
    const freeMemoryBytes = freemem();
    const totalMemoryBytes = totalmem();
    const freeMemoryPercent = (freeMemoryBytes / totalMemoryBytes) * 100;
    const siblingSessions = countLiveSessions();

    return {
      cpuLoad,
      freeMemoryBytes,
      totalMemoryBytes,
      freeMemoryPercent,
      siblingSessions,
    };
  } catch {
    // Fail open: if metrics unavailable, return safe defaults
    return {
      cpuLoad: 0,
      freeMemoryBytes: totalmem(),
      totalMemoryBytes: totalmem(),
      freeMemoryPercent: 100,
      siblingSessions: 0,
    };
  }
}

/**
 * Check if a host load gate should allow an operation to proceed.
 * Gate is disabled if OMC_HOST_LOAD_GATE_DISABLED is set.
 * Returns { allowed: true } if all conditions pass or gate is disabled.
 * Returns { allowed: false, reason, waitMs } if any threshold is exceeded.
 */
export function checkHostLoadGate(config?: HostLoadGateConfig): HostLoadGateResult {
  const gateConfig = config ?? parseGateConfig();
  const metrics = getHostMetrics();

  // If gating is disabled, always allow
  if (!gateConfig.enabled) {
    return {
      allowed: true,
      metrics,
    };
  }

  // Check CPU load
  if (gateConfig.cpuLoadThreshold >= 0 && metrics.cpuLoad > gateConfig.cpuLoadThreshold) {
    return {
      allowed: false,
      reason: `CPU load (${metrics.cpuLoad.toFixed(2)}) exceeds threshold (${gateConfig.cpuLoadThreshold.toFixed(2)})`,
      waitMs: gateConfig.checkIntervalMs,
      metrics,
    };
  }

  // Check free memory
  if (gateConfig.freeMemoryThreshold >= 0 && metrics.freeMemoryBytes < gateConfig.freeMemoryThreshold) {
    const freeMemMB = (metrics.freeMemoryBytes / (1024 * 1024)).toFixed(0);
    const thresholdMB = (gateConfig.freeMemoryThreshold / (1024 * 1024)).toFixed(0);
    return {
      allowed: false,
      reason: `Free memory (${freeMemMB}MB) below threshold (${thresholdMB}MB)`,
      waitMs: gateConfig.checkIntervalMs,
      metrics,
    };
  }

  // Check sibling sessions
  if (gateConfig.maxSiblingSessions >= 0 && metrics.siblingSessions > gateConfig.maxSiblingSessions) {
    return {
      allowed: false,
      reason: `Too many sibling sessions (${metrics.siblingSessions}) exceeds max (${gateConfig.maxSiblingSessions})`,
      waitMs: gateConfig.checkIntervalMs,
      metrics,
    };
  }

  return {
    allowed: true,
    metrics,
  };
}

/**
 * Wait for the gate to allow an operation, with timeout.
 * Polls the gate at regular intervals until allowed or timeout.
 * Always returns eventually (fails open, never deadlocks).
 *
 * @param config Gate configuration (uses defaults if not provided)
 * @param timeoutMs Override for max wait time
 * @returns Gate result (allowed: true if successful, false if timeout)
 */
export async function waitForHostLoadGate(
  config?: HostLoadGateConfig,
  timeoutMs?: number,
): Promise<HostLoadGateResult> {
  const gateConfig = config ?? parseGateConfig();
  const deadline = Date.now() + (timeoutMs ?? gateConfig.gateTimeoutMs);

   
  while (true) {
    const result = checkHostLoadGate(gateConfig);

    if (result.allowed) {
      return result;
    }

    // Check timeout
    if (Date.now() >= deadline) {
      // Fail open: return allowed=true after timeout
      return {
        allowed: true,
        reason: 'Gate timeout - allowing operation to proceed',
        metrics: result.metrics,
      };
    }

    // Wait before retrying
    const waitMs = result.waitMs ?? gateConfig.checkIntervalMs;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, deadline - Date.now())));
  }
}

/**
 * Gate an expensive operation with a timeout message.
 * Returns { allowed: true } if operation can proceed.
 * Returns { allowed: false, message } if gated, suggesting to try again later.
 */
export function gateExpensiveOperation(operationName: string, config?: HostLoadGateConfig) {
  const result = checkHostLoadGate(config);

  if (result.allowed) {
    return { allowed: true };
  }

  const message = [
    `Host load gate: cannot start ${operationName}`,
    result.reason,
    `Sibling sessions: ${result.metrics.siblingSessions}`,
    `CPU load: ${result.metrics.cpuLoad.toFixed(2)}, Free memory: ${((result.metrics.freeMemoryBytes / (1024 * 1024)) | 0)}MB`,
    `Try again in a few moments or disable with: export OMC_HOST_LOAD_GATE_DISABLED=1`,
  ].join('\n');

  return {
    allowed: false,
    message,
    result,
  };
}

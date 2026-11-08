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
export declare function getDefaultGateConfig(): HostLoadGateConfig;
/**
 * Parse configuration from environment variables.
 * Environment variables override defaults:
 * - OMC_HOST_LOAD_THRESHOLD: CPU load threshold (float)
 * - OMC_FREE_MEMORY_THRESHOLD: Free memory in MB (int)
 * - OMC_MAX_SIBLING_SESSIONS: Max sibling sessions (int)
 * - OMC_HOST_LOAD_GATE_DISABLED: Disable gating entirely (any value disables)
 */
export declare function parseGateConfig(overrides?: Partial<HostLoadGateConfig>): HostLoadGateConfig;
/**
 * Count live sibling OMC sessions on this host.
 * Scans .omc/state/sessions/ for directories, treating each as a session.
 * Returns 0 if the state directory doesn't exist (fails open).
 */
export declare function countLiveSessions(): number;
/**
 * Get current host metrics (CPU load, free memory, sibling sessions).
 * Returns 0/defaults if metrics are unavailable (fails open).
 */
export declare function getHostMetrics(): {
    cpuLoad: number;
    freeMemoryBytes: number;
    totalMemoryBytes: number;
    freeMemoryPercent: number;
    siblingSessions: number;
};
/**
 * Check if a host load gate should allow an operation to proceed.
 * Gate is disabled if OMC_HOST_LOAD_GATE_DISABLED is set.
 * Returns { allowed: true } if all conditions pass or gate is disabled.
 * Returns { allowed: false, reason, waitMs } if any threshold is exceeded.
 */
export declare function checkHostLoadGate(config?: HostLoadGateConfig): HostLoadGateResult;
/**
 * Wait for the gate to allow an operation, with timeout.
 * Polls the gate at regular intervals until allowed or timeout.
 * Always returns eventually (fails open, never deadlocks).
 *
 * @param config Gate configuration (uses defaults if not provided)
 * @param timeoutMs Override for max wait time
 * @returns Gate result (allowed: true if successful, false if timeout)
 */
export declare function waitForHostLoadGate(config?: HostLoadGateConfig, timeoutMs?: number): Promise<HostLoadGateResult>;
/**
 * Gate an expensive operation with a timeout message.
 * Returns { allowed: true } if operation can proceed.
 * Returns { allowed: false, message } if gated, suggesting to try again later.
 */
export declare function gateExpensiveOperation(operationName: string, config?: HostLoadGateConfig): {
    allowed: boolean;
    message?: undefined;
    result?: undefined;
} | {
    allowed: boolean;
    message: string;
    result: HostLoadGateResult;
};
//# sourceMappingURL=host-load-gate.d.ts.map
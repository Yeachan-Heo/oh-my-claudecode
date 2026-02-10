import type { BridgeConfig, McpWorkerMember } from './types.js';
export interface RestartPolicy {
    maxRestarts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    backoffMultiplier: number;
}
export interface RestartState {
    workerName: string;
    restartCount: number;
    lastRestartAt: string;
    nextBackoffMs: number;
}
/**
 * Read the current restart state for a worker.
 * Returns null if no restart state exists.
 */
export declare function readRestartState(workingDirectory: string, teamName: string, workerName: string): RestartState | null;
/**
 * Check if a dead worker should be restarted.
 * Uses exponential backoff: base * multiplier^count, capped at max.
 * Returns backoff delay in ms if restart allowed, null if exhausted.
 */
export declare function shouldRestart(workingDirectory: string, teamName: string, workerName: string, policy?: RestartPolicy): number | null;
/**
 * Record a restart attempt (updates sidecar state).
 */
export declare function recordRestart(workingDirectory: string, teamName: string, workerName: string, policy?: RestartPolicy): void;
/**
 * Clear restart state for a worker (e.g., after successful recovery).
 */
export declare function clearRestartState(workingDirectory: string, teamName: string, workerName: string): void;
/**
 * Synthesize a BridgeConfig from an McpWorkerMember record + sensible defaults.
 * Used at restart time. Does NOT persist BridgeConfig to disk.
 */
export declare function synthesizeBridgeConfig(worker: McpWorkerMember, teamName: string): BridgeConfig;
//# sourceMappingURL=worker-restart.d.ts.map
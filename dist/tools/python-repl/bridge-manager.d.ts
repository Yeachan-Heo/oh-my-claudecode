/**
 * Bridge Manager - Python process lifecycle management
 *
 * Manages the gyoshu_bridge.py process:
 * - Spawning with proper environment detection
 * - Ensuring single bridge per session with security validations
 * - Graceful shutdown with signal escalation
 * - PID reuse detection via process identity verification
 */
import { BridgeMeta } from './types.js';
export interface EscalationResult {
    terminated: boolean;
    terminatedBy?: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
    terminationTimeMs?: number;
}
/**
 * Verify that a bridge process is still running and is the same process
 * that was originally spawned (guards against PID reuse).
 *
 * Returns false if:
 * - Process is not alive
 * - Start time was recorded but doesn't match (PID reused)
 * - Start time was recorded but cannot be retrieved (fail-closed)
 */
export declare function verifyProcessIdentity(meta: BridgeMeta): Promise<boolean>;
/**
 * Spawn a new bridge server process for the given session.
 *
 * @param sessionId - Unique session identifier
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns BridgeMeta containing process information
 */
export declare function spawnBridgeServer(sessionId: string, projectDir?: string): Promise<BridgeMeta>;
/**
 * Get or spawn a bridge server for the session.
 *
 * Implements security validations:
 * - Anti-poisoning: Verifies sessionId in metadata matches expected
 * - Anti-hijack: Verifies socketPath is the expected canonical path
 * - Socket type: Verifies the socket path is actually a socket
 * - Process identity: Verifies PID + start time match
 *
 * @param sessionId - Unique session identifier
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns BridgeMeta for the active bridge
 */
export declare function ensureBridge(sessionId: string, projectDir?: string): Promise<BridgeMeta>;
/**
 * Terminate a bridge process with signal escalation.
 *
 * Escalation order:
 * 1. SIGINT - wait gracePeriodMs (default 5000ms)
 * 2. SIGTERM - wait 2500ms
 * 3. SIGKILL - immediate termination
 *
 * Uses process group kill (-pid) to also terminate child processes.
 *
 * @param sessionId - Session whose bridge to kill
 * @param options - Optional configuration
 * @returns EscalationResult with termination details
 */
export declare function killBridgeWithEscalation(sessionId: string, options?: {
    gracePeriodMs?: number;
}): Promise<EscalationResult>;
//# sourceMappingURL=bridge-manager.d.ts.map
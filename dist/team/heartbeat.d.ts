import type { HeartbeatData } from './types.js';
/** Write/update heartbeat. Called every poll cycle by the bridge. */
export declare function writeHeartbeat(workingDirectory: string, data: HeartbeatData): void;
/** Read heartbeat for a specific worker. Returns null if not found. */
export declare function readHeartbeat(workingDirectory: string, teamName: string, workerName: string): HeartbeatData | null;
/** List all heartbeat files for a team. Used by lead to check worker health. */
export declare function listHeartbeats(workingDirectory: string, teamName: string): HeartbeatData[];
/**
 * Check if a worker is alive based on heartbeat freshness.
 * A worker is considered dead if lastPollAt is older than maxAgeMs.
 * Invalid dates are treated as dead.
 */
export declare function isWorkerAlive(workingDirectory: string, teamName: string, workerName: string, maxAgeMs: number): boolean;
/** Delete heartbeat file (called during cleanup) */
export declare function deleteHeartbeat(workingDirectory: string, teamName: string, workerName: string): void;
/** Delete all heartbeat files for a team */
export declare function cleanupTeamHeartbeats(workingDirectory: string, teamName: string): void;
//# sourceMappingURL=heartbeat.d.ts.map
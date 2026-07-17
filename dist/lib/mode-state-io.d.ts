/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */
/** Executes a read or mutation against a state file under its mutation lock. */
export declare function withStateFileMutationLock<T>(filePath: string, callback: () => T, requireExclusive?: boolean): {
    acquired: boolean;
    value: T | undefined;
};
export declare function writeStateFileLocked(filePath: string, state: Record<string, unknown>): boolean;
export declare function clearStateFileLocked(filePath: string): boolean;
export type EmergencyStateAuthorization = (state: Record<string, unknown>) => boolean;
export interface EmergencyRecoveryOptions {
    /** Evaluated under the recovery claim before a recovered generation is mutated. */
    authorizeState?: EmergencyStateAuthorization;
}
export type ConditionalClearResult = 'cleared' | 'skipped' | 'failed';
export declare function clearStateFileLockedIf(filePath: string, predicate: (current: Record<string, unknown>) => boolean, recoveryOptions?: EmergencyRecoveryOptions): ConditionalClearResult;
export type ConditionalWriteResult = 'written' | 'skipped' | 'failed';
export declare function writeStateFileLockedIf(filePath: string, predicate: (current: Record<string, unknown>) => boolean, transform: (current: Record<string, unknown>) => Record<string, unknown>): ConditionalWriteResult;
export declare function writeStateFileLockedCreateIf(filePath: string, predicate: (current: Record<string, unknown> | null) => boolean, transform: (current: Record<string, unknown> | null) => Record<string, unknown>): ConditionalWriteResult;
/** A dead transaction is recovered under a state-scoped, generation-verified exclusive claim. */
export declare function recoverEmergencyStateFile(filePath: string, options?: EmergencyRecoveryOptions): boolean;
export declare function emergencyMutateStateFileIf(filePath: string, predicate: (current: Record<string, unknown>) => boolean, transform: ((current: Record<string, unknown>) => Record<string, unknown>) | null, recoveryOptions?: EmergencyRecoveryOptions): boolean;
export declare function getStateSessionOwner(state: Record<string, unknown> | null | undefined): string | undefined;
export declare function canClearStateForSession(state: Record<string, unknown> | null | undefined, sessionId: string): boolean;
/**
 * Find session-scoped state files that belong to the requested session.
 *
 * Normally the state file lives under `.omc/state/sessions/{sessionId}/`.
 * When a file is stranded under a different session directory (for example
 * after session continuation or manual recovery), this scans all session
 * directories and returns any file whose embedded owner still matches the
 * requested session.
 */
export interface StateFileDiscovery {
    path: string;
    snapshot: string;
    state: Record<string, unknown>;
    ownerSessionId?: string;
    workflowRunId?: string;
    completedSessionId?: string;
    completionEvidencePath?: string;
}
export declare function findSessionOwnedStateCandidates(mode: string, sessionId: string, directory?: string): StateFileDiscovery[];
export declare function findSessionOwnedStateFiles(mode: string, sessionId: string, directory?: string): string[];
/**
 * Find active session-scoped state files that are safe to treat as orphaned.
 *
 * A fresh `/cancel` invocation may run in a new Claude session id while the
 * state files that keep the Stop hook alive still live under the completed
 * session's directory.  We intentionally require durable completion evidence
 * (`.omc/sessions/{sessionId}.json`) before returning a sibling session's file
 * so active parallel sessions are not cleared just because their ids differ
 * from the caller's fresh cancel session.
 */
export declare function findCompletedSessionStateCandidates(mode: string, directory?: string, requesterSessionId?: string): StateFileDiscovery[];
export declare function findCompletedSessionStateFiles(mode: string, directory?: string, requesterSessionId?: string): string[];
/**
 * Write mode state to disk.
 *
 * - Ensures parent directories exist.
 * - Writes with mode 0o600 (owner-only) for security.
 * - Adds `_meta` envelope with write timestamp.
 *
 * @returns true on success, false on failure
 */
export declare function writeModeState(mode: string, state: Record<string, unknown>, directory?: string, sessionId?: string): boolean;
/**
 * Read mode state from disk.
 *
 * When sessionId is provided, ONLY reads the session-scoped file (no legacy fallback)
 * to prevent cross-session state leakage.
 *
 * Strips the `_meta` envelope so callers get the original state shape.
 * Handles files written before _meta was introduced (no-op strip).
 *
 * @returns The parsed state (without _meta) or null if not found / unreadable.
 */
export declare function readModeState<T = Record<string, unknown>>(mode: string, directory?: string, sessionId?: string): T | null;
/**
 * Clear (delete) a mode state file from disk.
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped file.
 * 2. Ghost-legacy cleanup: also removes the legacy file if it belongs to
 *    this session or has no session_id (orphaned).
 *
 * @returns true on success (or file already absent), false on failure.
 */
export declare function clearModeStateFile(mode: string, directory?: string, sessionId?: string, expectedState?: Record<string, unknown>): boolean;
//# sourceMappingURL=mode-state-io.d.ts.map
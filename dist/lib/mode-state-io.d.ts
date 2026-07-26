/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */
export type MutationLockOwner = {
    version: 1;
    pid: number;
    createdAt: string;
    expires_at: string;
    nonce: string;
};
export type MutationLock = {
    fd: number;
    path: string;
    owner: MutationLockOwner;
} | {
    unlocked: true;
};
export declare function validateMutationLockOwner(value: unknown): MutationLockOwner | null;
/** Acquire a mutation lock at an explicit path (test surface). */
export declare function acquireMutationLockAt(filePath: string, requireExclusive?: boolean): MutationLock | null;
/** Release a mutation lock previously acquired via acquireMutationLockAt. */
export declare function releaseMutationLockSync(lock: MutationLock | null): void;
/**
 * Re-validates that the holder's OWN lease is still live (B11). Re-reads the
 * on-disk owner at `lock.path` and confirms (a) it is still our lock
 * (`sameLockOwner`: pid + nonce + createdAt) and (b) `now < expires_at`. If the
 * lease has expired while we were still in the critical section, a second writer
 * may already have reclaimed and re-acquired the lock; publishing now would
 * silently overwrite that writer's work. To make that violation DETECTABLE
 * rather than silent, this throws `lease_expired_during_mutation` and logs the
 * two-writer overlap. Call this immediately BEFORE publishing under a lock whose
 * critical section may approach LEASE_MS; withStateFileMutationLock does so
 * automatically before invoking the callback.
 *
 * Note: this is the holder checking ITS OWN lease, not someone else's. A holder
 * that overruns its lease is the bug; this is the safety net that catches it.
 */
export declare function assertMutationLockHeld(lock: MutationLock | null): void;
/**
 * Extends the holder's lease by re-writing `expires_at = now + LEASE_MS` while
 * still holding the lock (B11). For long critical sections (e.g. a slow graph
 * mutation that may approach or exceed LEASE_MS), callers should renew
 * periodically so the lease does not expire under them and admit a second
 * writer. Renewal re-validates that the on-disk owner is still ours (otherwise a
 * later writer has already reclaimed our expired lease and we must NOT publish);
 * on owner mismatch or I/O failure it returns false and the caller should abort.
 * Returns true on a successful renewal. No-op (returns true) for unlocked locks.
 */
export declare function renewMutationLock(lock: MutationLock | null): boolean;
/**
 * Reports whether `renewMutationLock` can actually extend the lease for `lock`
 * on the current runtime (B11). On a flock-capable runtime it returns true; on
 * a flock-less runtime (macOS/Windows) it returns false, because a portable
 * atomic rename-over-the-live-lock is unavailable without the shared reclaimer
 * guard, so `renewMutationLock` returns false there regardless of whether the
 * lock is still held. Unlocked locks are trivially "supported" (renewal is a
 * no-op that returns true).
 *
 * Callers that gate on renewal failure should use this to distinguish
 * "renewal unsupported on this runtime" (the lock is NOT lost - it is still
 * held via the O_EXCL linkSync and its lease is still valid for LEASE_MS; the
 * holder should NO-OP, relying on `assertMutationLockHeld` before publish as the
 * safety net) from "renewal attempted on a supported runtime and failed" (the
 * lock WAS lost - owner replaced / lease expired / I/O error - and the caller
 * must abort). Treating the unsupported case as `lock_lost` would break every
 * mutation on macOS/Windows.
 */
export declare function mutationLockRenewalSupported(lock: MutationLock | null): boolean;
/** Executes a read or mutation against a state file under its mutation lock. */
export declare function withStateFileMutationLock<T>(filePath: string, callback: (assertHeld: () => void) => T, requireExclusive?: boolean): {
    acquired: boolean;
    value: T | undefined;
};
/**
 * Test seam for the deterministic B11 probe (stale-holder-publishes-after-reclaim).
 * When `pauseAfterClaim` is set, `occCommitMutation` invokes its `fn` AFTER
 * claiming an entry and BEFORE the fence revalidation, letting a test
 * deschedule writer A, commit writer B fully, then resume A so A must detect
 * its fork. Unused in production (the hook object stays empty).
 */
export interface OccTestHooks {
    pauseAfterClaim?: {
        filePath: string;
        fn: (seq: number, ownerToken: string, parentSeq: number) => void;
    };
}
export declare const OCC_TEST_HOOKS: OccTestHooks;
export type OccMutate<TState, TResult> = (currentState: unknown, ownerToken: string) => {
    state: TState;
    result: TResult;
} | null;
export interface OccCommitOptions {
    ownerToken?: string;
    /** Called at the commit/publish boundary by public mutation-lock holders. */
    assertHeld?: () => void;
    /** Journal this generation without serializing it back over canonical bytes. */
    suppressCanonicalRepublish?: boolean;
    /** Internal authenticated external-publication bridge; never infer from cache. */
    authenticatedExternalParent?: unknown;
    /** Optional cache-byte CAS fence for conditional publication operations. */
    expectedCanonicalContentFingerprint?: string;
    /** Called when the optional canonical CAS fence detects a replacement. */
    onCanonicalCompareFailed?: () => void;
}
/**
 * OCC commit protocol (replaces writeAtomic-under-lock for concurrency fencing).
 *
 * `mutate(currentState)` is PURE: it returns { state, result } (or `null` to
 * cancel without committing). The wrapper handles claim, parent-validation,
 * commit, re-publication, and retry. Returns the committed result, or `null`
 * if every retry forked (extremely live contention) or on a journal-directory
 * I/O error (fail closed) or a thrown/cancelled mutation.
 */
export declare function occCommitMutation<TState, TResult>(filePath: string, mutate: OccMutate<TState, TResult>, options?: OccCommitOptions): {
    state: TState;
    result: TResult;
} | null;
/** Reads the current committed state via the OCC journal (test + reader surface). */
export declare function occReadCurrentState(filePath: string): unknown;
/**
 * Sequence a non-OCC publication only when it proves the journal parent from
 * which it was computed. This is the bridge for crash-safe emergency writers:
 * their transaction authenticates the source bytes, then this fence prevents a
 * completed newer OCC generation from being overwritten by the publication.
 *
 * Arbitrary canonical-only writes deliberately have no access to this API and
 * therefore remain compatibility-cache changes, never journal authority.
 */
export declare function occCommitAuthenticatedExternalState(filePath: string, expectedParentState: unknown, publishedState: unknown, assertHeld?: () => void): boolean;
/** Cleans up only this owner token's stale INCOMPLETE entries (release race cure). */
export declare function occCleanupOwner(filePath: string, ownerToken: string): void;
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
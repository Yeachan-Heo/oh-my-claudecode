import { teamInstanceLifecycleLockPath } from './state-paths.js';
import type { TeamInstanceAssertion, TeamInstanceBinding, TeamInstanceCleanupRecord, TeamInstanceCleanupResult, TeamInstanceDisposalAuthorization, TeamInstanceId, TeamInstancePendingConfig, TeamInstanceRequest, TeamInstanceReservation } from './types.js';
/** Errors are stable enough for callers to classify without parsing messages. */
export type TeamInstanceErrorCode = 'team_instance_id_invalid' | 'team_instance_name_invalid' | 'team_instance_cwd_invalid' | 'team_instance_process_identity_unavailable' | 'team_instance_reservation_conflict' | 'team_instance_authority_missing' | 'team_instance_authority_corrupt' | 'team_instance_mismatch' | 'team_instance_newer_instance' | 'team_instance_state_unknown' | 'team_instance_state_corrupt' | 'team_instance_state_missing' | 'team_instance_startup_config_missing' | 'team_instance_startup_not_empty' | 'team_instance_reservation_active' | 'team_instance_owner_unknown' | 'team_instance_final_state_required' | 'team_instance_receipt_publish_failed' | 'team_instance_rename_failed' | 'team_instance_remove_failed' | 'team_instance_reservation_release_failed' | 'team_instance_cleanup_inconsistent';
export declare class TeamInstanceError extends Error {
    readonly code: TeamInstanceErrorCode;
    constructor(code: TeamInstanceErrorCode, message?: string, options?: ErrorOptions);
}
/** Optional fault-injection seams also make the durable boundaries testable. */
export interface TeamInstanceIo {
    publishReservation?: (path: string, record: TeamInstanceReservation) => Promise<void> | void;
    publishCleanupReceipt?: (path: string, record: TeamInstanceCleanupRecord) => Promise<void> | void;
    renameStateRoot?: (source: string, destination: string) => Promise<void> | void;
    removeTree?: (path: string) => Promise<void> | void;
}
export interface TeamInstanceOperationOptions {
    timeoutMs?: number;
    io?: TeamInstanceIo;
}
/** Address accepted by assertion/disposal APIs; it must contain an instance id. */
export type BoundTeamInstance = TeamInstanceBinding | TeamInstanceReservation | (TeamInstanceRequest & {
    instanceId: TeamInstanceId;
});
/** Build and canonicalize an instance id before any state effect. */
export declare function createTeamInstanceBinding(input: TeamInstanceRequest): TeamInstanceBinding;
/** The one external lock shared by startup, lifecycle mutation and cleanup. */
export { teamInstanceLifecycleLockPath };
export declare function withTeamInstanceLifecycleLock<T>(cwd: string, teamName: string, fn: () => Promise<T> | T, timeoutMs?: number): Promise<T>;
/**
 * Reserve a new instance under the caller's lifecycle lock.  This function is
 * intentionally lock-free so startup can reserve, write its pending config,
 * and perform every effect while retaining one lock.
 */
export declare function reserveTeamInstanceUnderLock(input: TeamInstanceRequest, options?: TeamInstanceOperationOptions): Promise<TeamInstanceReservation>;
/** Convenience form for callers that do not already own the lifecycle lock. */
export declare function reserveTeamInstance(input: TeamInstanceRequest, options?: TeamInstanceOperationOptions): Promise<TeamInstanceReservation>;
/** Return the minimal config projection safe to write before startup effects. */
export declare function buildTeamInstancePendingConfig(input: BoundTeamInstance): TeamInstancePendingConfig;
/**
 * Assert the reservation and any config/manifest identity while the lifecycle
 * lock is held.  It never acquires the lock itself, preventing recursive-lock
 * deadlocks when config CAS is performed inside lifecycle operations.
 */
export declare function assertTeamInstanceUnderLock(input: BoundTeamInstance): Promise<TeamInstanceAssertion>;
/** Mark a pending reservation active after the identity-bearing config exists. */
export declare function activateTeamInstanceUnderLock(input: BoundTeamInstance, options?: TeamInstanceOperationOptions): Promise<TeamInstanceReservation>;
/**
 * Release only a failed, still-empty startup.  The root is checked and removed
 * before the reservation, so a release failure leaves a retryable authority.
 */
export declare function releaseFailedStartupReservationUnderLock(input: BoundTeamInstance, options?: TeamInstanceOperationOptions): Promise<void>;
export declare function releaseFailedStartupReservation(input: BoundTeamInstance, options?: TeamInstanceOperationOptions): Promise<void>;
/**
 * Dispose one instance after the caller-owned final-state protocol has run.
 * Callers MUST prove provider termination from launch/process identity evidence,
 * prove pane ownership/absence separately, and complete worktree cleanup in
 * its established order before passing this authorization. This module never
 * probes or kills providers and never infers provider death from a pane.
 */
export declare function disposeTeamInstanceUnderLock(input: BoundTeamInstance, authorization: TeamInstanceDisposalAuthorization, options?: TeamInstanceOperationOptions): Promise<TeamInstanceCleanupResult>;
/** Convenience disposal form for callers that do not already own the lock. */
export declare function disposeTeamInstance(input: BoundTeamInstance, authorization: TeamInstanceDisposalAuthorization, options?: TeamInstanceOperationOptions): Promise<TeamInstanceCleanupResult>;
/**
 * Retry only a cleanup transaction that already published a valid receipt.
 * Unlike `disposeTeamInstance`, this API never creates a prepared receipt and
 * therefore cannot turn a caller's literal authorization into a new deletion.
 */
export declare function retryTeamInstanceDisposalUnderLock(input: BoundTeamInstance, authorization: TeamInstanceDisposalAuthorization, options?: TeamInstanceOperationOptions): Promise<TeamInstanceCleanupResult>;
/** Explicit public retry entry point; it acquires the canonical name lock. */
export declare function retryTeamInstanceDisposal(input: BoundTeamInstance, authorization: TeamInstanceDisposalAuthorization, options?: TeamInstanceOperationOptions): Promise<TeamInstanceCleanupResult>;
//# sourceMappingURL=team-instance.d.ts.map
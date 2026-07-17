import type { RecoverDeadWorkerV2Error, RecoverDeadWorkerV2Result } from './types.js';
export declare function isSafeRecoveryRequestId(requestId: string): boolean;
export interface RecoveryRequestPayload {
    operation: 'recover-worker';
    workspaceHash: string;
    teamName: string;
    workerName: string;
}
export interface RecoveryRequestReservation {
    schema_version: 1;
    kind: 'reservation' | 'alias';
    request_id: string;
    payload_hash: string;
    operation: 'recover-worker';
    workspace_hash: string;
    team_name: string;
    worker_name: string;
    recovery_id: string;
    created_at: string;
    expires_at: string;
    alias_of_request_id?: string;
}
export interface RecoveryOutcomeError {
    code: RecoverDeadWorkerV2Error;
    message?: string;
    commit_uncertain?: boolean;
}
export interface RecoveryOutcomePending {
    schema_version: 1;
    kind: 'phase';
    request_id: string;
    recovery_id: string;
    team_name: string;
    worker_name: string;
    phase: 'reserved' | 'elected' | 'requeued' | 'ready' | 'active' | 'services_pending' | 'adopted';
    continuation: 'none' | 'selected' | 'reserved' | 'adopted';
    adoption: 'not_started' | 'pending' | 'adopted';
    services: 'not_started' | 'pending' | 'synced' | 'repair_required';
    manifest: 'not_started' | 'synced' | 'repair_required';
    state_revision?: number;
    updated_at: string;
}
export interface RecoveryOutcomeFinal {
    schema_version: 1;
    kind: 'final';
    request_id: string;
    recovery_id: string;
    team_name: string;
    worker_name: string;
    outcome: 'succeeded' | 'failed' | 'commit_unknown';
    result?: RecoverDeadWorkerV2Result;
    error?: RecoveryOutcomeError;
    continuation: 'none' | 'selected' | 'reserved' | 'adopted';
    adoption: 'not_started' | 'pending' | 'adopted';
    services: 'synced' | 'repair_required' | 'terminal_degraded';
    manifest: 'synced' | 'repair_required';
    completed_at: string;
    expires_at: string;
}
export type RecoveryDurableOutcome = RecoveryOutcomePending | RecoveryOutcomeFinal;
export type RequestReservationResult = {
    kind: 'created' | 'joined' | 'aliased';
    reservation: RecoveryRequestReservation;
} | {
    kind: 'conflict';
    reservation: RecoveryRequestReservation;
};
export declare function canonicalRecoveryPayloadHash(payload: RecoveryRequestPayload): string;
export declare function reserveRecoveryRequest(cwd: string, requestId: string, payload: RecoveryRequestPayload, recoveryId?: string): RequestReservationResult;
/** Publish a new immutable request ID that points at an existing recovery. */
export declare function aliasActiveRecoveryRequest(cwd: string, requestId: string, payload: RecoveryRequestPayload, active: RecoveryRequestReservation): RequestReservationResult;
export declare function readRecoveryRequestReservation(cwd: string, requestId: string): RecoveryRequestReservation | null;
export declare function writeRecoveryPhase(cwd: string, phase: RecoveryOutcomePending): RecoveryOutcomePending;
export declare function writeRecoveryFinal(cwd: string, outcome: RecoveryOutcomeFinal): RecoveryOutcomeFinal;
export type RecoveryFinalState = {
    kind: 'missing';
} | {
    kind: 'invalid';
} | {
    kind: 'valid';
    final: RecoveryOutcomeFinal & {
        result: RecoverDeadWorkerV2Result;
    };
};
export declare function readRecoveryFinalState(cwd: string, requestId: string): RecoveryFinalState;
export declare function isMatchingRecoveryFinal(outcome: RecoveryDurableOutcome | null | undefined, expected?: Partial<{
    requestId: string;
    recoveryId: string;
    teamName: string;
    workerName: string;
}>): outcome is RecoveryOutcomeFinal & {
    result: RecoverDeadWorkerV2Result;
};
/** Final records take precedence, then the newest immutable phase. */
export declare function readRecoveryOutcome(cwd: string, requestId: string): RecoveryDurableOutcome | null;
export declare function readRecoveryResult(cwd: string, requestId: string): RecoverDeadWorkerV2Result | null;
//# sourceMappingURL=recovery-request-store.d.ts.map
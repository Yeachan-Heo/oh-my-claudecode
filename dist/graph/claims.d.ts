import { type GraphClaim, type GraphDiagnostic, type GraphReconciliationRecord, type GraphState } from './runtime-types.js';
import type { GraphEffectPolicy, GraphSchedulerProjection } from './types.js';
export declare class GraphClaimError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface IssueGraphClaimInput {
    activation_id: string;
    attempt_id: string;
    attempt_no: number;
    claim_owner_session_id: string;
    driver_instance_id: string;
    lease_id: string;
    tracking_id: string;
    issued_at: string;
    execution_timeout_ms: number;
    grace_ms: number;
    max_renewals: number;
    effect_policy: GraphEffectPolicy;
    external_idempotency_key?: string;
}
export interface GraphClaimResult {
    state: GraphState;
    claim: GraphClaim;
}
export interface RenewGraphClaimInput {
    lease_id: string;
    claim_owner_session_id: string;
    driver_instance_id: string;
    tracking_id: string;
    tool_still_running: boolean;
    now: string;
}
export interface RecoverExpiredGraphClaimInput {
    lease_id: string;
    now: string;
    new_attempt_id: string;
    new_lease_id: string;
    new_tracking_id: string;
    claimant_session_id: string;
    driver_instance_id: string;
    reconciliation_id: string;
}
export interface ReplacementAttemptInput {
    activation_id: string;
    attempt_id: string;
    attempt_no: number;
}
export type ReplaceAttemptProjection = (projection: GraphSchedulerProjection, input: ReplacementAttemptInput) => GraphSchedulerProjection;
export interface GraphClaimRecoveryResult {
    state: GraphState;
    disposition: 'taken_over' | 'reconciling';
    claim?: GraphClaim;
    reconciliation?: GraphReconciliationRecord;
}
export declare function issueGraphClaim(stateInput: GraphState, input: IssueGraphClaimInput): GraphClaimResult;
export declare function renewGraphClaim(stateInput: GraphState, input: RenewGraphClaimInput): GraphClaimResult;
export declare function recoverExpiredGraphClaim(stateInput: GraphState, input: RecoverExpiredGraphClaimInput, replaceAttempt: ReplaceAttemptProjection): GraphClaimRecoveryResult;
export interface LateClaimResultInput {
    lease_id: string;
    attempt_id: string;
    recorded_at: string;
    summary: string;
}
export declare function recordLateClaimResult(stateInput: GraphState, input: LateClaimResultInput): {
    state: GraphState;
    diagnostic: GraphDiagnostic;
};
export interface SettleDriverClaimsInput {
    claim_owner_session_id: string;
    driver_instance_id: string;
    recorded_at: string;
    /**
     * 'driver' (default) fences only live claims owned by driver_instance_id.
     * 'session' fences ALL live claims for the session regardless of driver-id;
     * used at session-end when the whole session is terminating and every live
     * claim must be fenced so concurrency slots do not leak.
     */
    scope?: 'driver' | 'session';
}
export declare function settleDriverClaims(stateInput: GraphState, input: SettleDriverClaimsInput): {
    state: GraphState;
    settled_lease_ids: string[];
};
//# sourceMappingURL=claims.d.ts.map
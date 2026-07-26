import type { GraphEffectPolicy, GraphEvidenceReference, GraphSchedulerProjection, SealedGraphDescriptor } from './types.js';
export declare const GRAPH_STATE_FORMAT_VERSION: 1;
export declare const GRAPH_STATE_MAX_BYTES: number;
export declare const GRAPH_MAX_TRANSITIONS = 10000;
export declare const GRAPH_MAX_DIAGNOSTICS = 128;
export declare const GRAPH_MAX_RECONCILIATIONS = 1000;
export declare const GRAPH_MAX_CLAIMS = 2000;
export declare const GRAPH_MAX_TRANSITION_RESULT_BYTES: number;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type GraphRunStatus = 'draft' | 'awaiting_approval' | 'running' | 'waiting_human' | 'waiting_patch_approval' | 'reconciling' | 'paused' | 'failed' | 'cancelled' | 'succeeded';
export interface GraphApprovalRecord {
    revision_id: string;
    revision_hash: string;
    approved_at: string;
    evidence: GraphEvidenceReference;
}
export interface GraphRevisionRecord {
    revision_id: string;
    descriptor_hash: string;
    descriptor: SealedGraphDescriptor;
    created_at: string;
    approval?: GraphApprovalRecord;
    invalidated_node_ids: string[];
}
export interface GraphStateTransition {
    transition_id: string;
    operation: string;
    operation_fingerprint: string;
    request_fingerprint: string;
    sequence: number;
    committed_at: string;
    result: JsonValue;
}
export type GraphClaimStatus = 'live' | 'completed' | 'expired_retryable' | 'abandoned_retryable' | 'reconciling' | 'fenced';
export interface GraphClaim {
    run_id: string;
    revision_id: string;
    revision_hash: string;
    dispatch_generation: number;
    activation_id: string;
    attempt_id: string;
    attempt_no: number;
    claim_owner_session_id: string;
    driver_instance_id: string;
    lease_id: string;
    tracking_id: string;
    issued_at: string;
    expires_at: string;
    last_renewed_at?: string;
    lease_duration_ms: number;
    renewal_count: number;
    max_renewals: number;
    effect_policy: GraphEffectPolicy;
    external_idempotency_key?: string;
    status: GraphClaimStatus;
    fenced_at?: string;
    replacement_lease_id?: string;
}
export type GraphReconciliationStatus = 'unresolved' | 'committed' | 'proved_not_applied' | 'accepted' | 'invalidated';
export interface GraphReconciliationRecord {
    reconciliation_id: string;
    activation_id: string;
    attempt_id: string;
    lease_id: string;
    revision_id: string;
    revision_hash: string;
    dispatch_generation: number;
    status: GraphReconciliationStatus;
    reason: 'expired_ambiguous' | 'session_end_ambiguous' | 'external_effect_ambiguous';
    created_at: string;
    resolved_at?: string;
    resolution_evidence?: GraphEvidenceReference;
}
export interface GraphDiagnostic {
    kind: 'late_result' | 'operation' | 'recovery' | 'control';
    recorded_at: string;
    summary: string;
    activation_id?: string;
    attempt_id?: string;
    lease_id?: string;
}
export interface GraphPendingApproval {
    revision_id: string;
    revision_hash: string;
    requested_at: string;
}
export interface GraphPendingPatch {
    proposal_id: string;
    base_revision_id: string;
    base_revision_hash: string;
    base_dispatch_generation: number;
    proposed_revision_id: string;
    proposed_revision_hash: string;
    proposed_descriptor: SealedGraphDescriptor;
    invalidated_node_ids: string[];
    proposal_evidence: GraphEvidenceReference[];
    proposed_at: string;
}
export interface GraphState {
    format_version: typeof GRAPH_STATE_FORMAT_VERSION;
    session_id: string;
    run_id: string;
    control_nonce: string;
    status: GraphRunStatus;
    active_revision_id: string;
    active_revision_hash: string;
    dispatch_generation: number;
    commit_sequence: number;
    revisions: Record<string, GraphRevisionRecord>;
    transitions: GraphStateTransition[];
    projection: GraphSchedulerProjection;
    claims: Record<string, GraphClaim>;
    reconciliations: Record<string, GraphReconciliationRecord>;
    diagnostics: GraphDiagnostic[];
    pending_approval?: GraphPendingApproval;
    pending_patch?: GraphPendingPatch;
    created_at: string;
    updated_at: string;
}
export interface CreateInitialGraphStateInput {
    session_id: string;
    control_nonce: string;
    descriptor: SealedGraphDescriptor;
    projection: GraphSchedulerProjection;
    status?: GraphRunStatus;
    created_at: string;
    approval?: Omit<GraphApprovalRecord, 'revision_id' | 'revision_hash'> & {
        revision_id?: string;
        revision_hash?: string;
    };
}
export declare function createInitialGraphState(input: CreateInitialGraphStateInput): GraphState;
export declare class GraphStateValidationError extends Error {
    readonly code = "invalid_graph_state";
    constructor(message: string);
}
export declare function parseGraphState(input: unknown): GraphState;
export type GraphControlMode = 'graph' | 'autopilot' | 'autoresearch' | 'ralph' | 'team' | 'ultrawork' | 'ultraqa' | 'ralplan' | 'deep-interview' | 'self-improve';
export interface GraphProcessIdentity {
    pid: number;
    process_start: string;
}
export interface GraphDriverLease {
    driver_instance_id: string;
    lease_id: string;
    expires_at: string;
}
export interface GraphClaimLineage {
    activation_id: string;
    attempt_id: string;
    lease_id: string;
    revision_id: string;
    revision_hash: string;
    dispatch_generation: number;
}
export interface ControlLineageIdentity {
    mode: GraphControlMode;
    session_id: string;
    run_id: string;
}
export interface ControlChildRegistration extends ControlLineageIdentity {
    parent: ControlLineageIdentity;
    graph_claim?: GraphClaimLineage;
    registered_at: string;
}
export interface ControlRoot extends ControlLineageIdentity {
    nonce: string;
    phase: 'reserved' | 'active';
    reservation_process: GraphProcessIdentity;
    driver_lease?: GraphDriverLease;
    graph_revision?: {
        revision_id: string;
        revision_hash: string;
    };
    children: ControlChildRegistration[];
    created_at: string;
    updated_at: string;
}
export interface ControlReleaseRecord {
    mode: GraphControlMode;
    run_id: string;
    nonce: string;
    disposition: 'paused' | 'terminal';
    released_at: string;
}
export interface ControlOwnerState {
    format_version: 1;
    session_id: string;
    generation: number;
    root: ControlRoot | null;
    last_release?: ControlReleaseRecord;
    updated_at: string;
}
//# sourceMappingURL=runtime-types.d.ts.map
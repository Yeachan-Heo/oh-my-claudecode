/**
 * Graph Core data contract — deeply readonly types.
 *
 * Contract-authored from spec `deep-interview-issue-3570-graph-core.md` and the
 * ralplan stage-04 revision (`pending-approval.md`); oracle `99ffe31` used only
 * for behavioral cross-checks, never as import authority or copied structure.
 */

/** Stable node kinds. */
export type GraphNodeKind = "agent" | "command" | "human-approval" | "join";

/** Effect policy for executable nodes (discriminated object union). */
export interface GraphSideEffectFreePolicy {
  readonly policy: "side_effect_free";
}

export interface GraphIdempotentPolicy {
  readonly policy: "idempotent";
  readonly idempotency_key_template: string;
}

export interface GraphReconcilePolicy {
  readonly policy: "reconcile";
}

export type GraphEffectPolicy =
  | GraphSideEffectFreePolicy
  | GraphIdempotentPolicy
  | GraphReconcilePolicy;

/** Fields shared by every graph node. */
export interface GraphNodeBase {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly title: string;
}

/** Fields shared by executable (agent/command) nodes. */
export interface GraphExecutableNodeBase extends GraphNodeBase {
  readonly timeout_ms: number;
  readonly max_attempts: number;
  readonly effect_policy: GraphEffectPolicy;
}

export interface GraphAgentNode extends GraphExecutableNodeBase {
  readonly kind: "agent";
  readonly instructions: string;
}

export interface GraphCommandNode extends GraphExecutableNodeBase {
  readonly kind: "command";
  readonly command: string;
}

export interface GraphHumanApprovalNode extends GraphNodeBase {
  readonly kind: "human-approval";
  readonly prompt: string;
}

export interface GraphJoinNode extends GraphNodeBase {
  readonly kind: "join";
  readonly fan_out_node_id: string;
  readonly input_branch_ids: readonly string[];
}

export type GraphNode =
  | GraphAgentNode
  | GraphCommandNode
  | GraphHumanApprovalNode
  | GraphJoinNode;

/** Fields shared by every graph edge. */
export interface GraphEdgeBase {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface GraphFixedEdge extends GraphEdgeBase {
  readonly kind: "fixed";
}

export interface GraphConditionalEdge extends GraphEdgeBase {
  readonly kind: "conditional";
  readonly route: string;
}

export interface GraphFanOutEdge extends GraphEdgeBase {
  readonly kind: "fan_out";
  readonly branch_id: string;
  readonly owner_join_id: string;
}

export interface GraphBackEdge extends GraphEdgeBase {
  readonly kind: "back_edge";
  readonly route: string;
  readonly max_traversals: number;
}

export type GraphEdge =
  | GraphFixedEdge
  | GraphConditionalEdge
  | GraphFanOutEdge
  | GraphBackEdge;

/** Unsealed descriptor input accepted by the draft producers. */
export interface GraphDescriptorInput {
  readonly descriptor_version: 1;
  readonly run_id: string;
  readonly revision_id: string;
  readonly goal: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly entry_node_ids: readonly string[];
  readonly concurrency_limit: number;
  readonly terminal_verification_node_id: string;
  readonly descriptor_hash?: string;
}

/** Unsealed descriptor (hashless; never accepted by the scheduler). */
export type GraphDescriptor = GraphDescriptorInput;

/**
 * Sealed descriptor: hashless shape plus a required lowercase SHA-256 hex
 * `descriptor_hash`. The only scheduler-accepted descriptor type; owned values
 * come exclusively from `sealGraphDescriptor` / `parseSealedGraphDescriptor`.
 */
export type SealedGraphDescriptor = Omit<
  GraphDescriptorInput,
  "descriptor_hash"
> & {
  readonly descriptor_hash: string;
};

export interface GraphEvidenceReference {
  readonly kind: "file" | "command" | "test" | "human" | "url";
  readonly ref: string;
  readonly summary?: string;
}

export interface GraphNodeResult {
  readonly outcome: "succeeded" | "failed";
  readonly attempt_id: string;
  readonly route?: string;
  readonly output_summary?: string;
  readonly evidence_refs: readonly GraphEvidenceReference[];
  readonly external_idempotency_key?: string;
}

export interface GraphApprovalDecision {
  readonly decision: "approved" | "denied";
  readonly evidence_refs: readonly GraphEvidenceReference[];
  readonly output_summary?: string;
}

export type GraphActivationStatus =
  | "ready"
  | "running"
  | "completed"
  | "failed";

export interface GraphActivation {
  readonly activation_id: string;
  readonly node_id: string;
  readonly status: GraphActivationStatus;
  readonly attempt_no: number;
  readonly attempt_ids: readonly string[];
  readonly active_attempt_id?: string;
  readonly completed_transition_id?: string;
  readonly cohort_id?: string;
  readonly branch_token_id?: string;
  readonly traversal_owner_id: string;
}

export type GraphBranchTokenStatus = "active" | "arrived" | "consumed";

export interface GraphBranchToken {
  readonly branch_token_id: string;
  readonly cohort_id: string;
  readonly branch_id: string;
  readonly owner_join_id: string;
  readonly status: GraphBranchTokenStatus;
  readonly current_activation_id?: string;
  readonly consumed_by_activation_id?: string;
}

export interface GraphCohort {
  readonly cohort_id: string;
  readonly fan_out_node_id: string;
  readonly owner_join_id: string;
  readonly expected_branch_token_ids: readonly string[];
  readonly join_activation_id?: string;
  readonly consumed: boolean;
}

/** Fields shared by every committed transition record. */
interface GraphCommittedTransitionBase {
  readonly transition_id: string;
  readonly activation_id: string;
  readonly node_id: string;
  readonly fingerprint_version: 1;
  readonly request_fingerprint: string;
  readonly descriptor_hash: string;
  readonly selected_edge_ids: readonly string[];
  readonly created_activation_ids: readonly string[];
  readonly evidence_refs: readonly GraphEvidenceReference[];
  readonly external_idempotency_key?: string;
}

/** Succeeded: attempt-bound; edge/activation cardinality varies (fan-out/terminal). */
export interface GraphSucceededTransition extends GraphCommittedTransitionBase {
  readonly outcome: "succeeded";
  readonly attempt_id: string;
  readonly route?: string;
  readonly output_summary?: string;
  readonly cohort_id?: string;
}

/** Failed: never selects or creates anything. */
export interface GraphFailedTransition extends GraphCommittedTransitionBase {
  readonly outcome: "failed";
  readonly attempt_id: string;
  readonly selected_edge_ids: readonly [];
  readonly created_activation_ids: readonly [];
  readonly output_summary?: string;
}

/** Approved: exactly one fixed edge selected and exactly one activation created; evidence is non-empty. */
export interface GraphApprovedTransition extends GraphCommittedTransitionBase {
  readonly outcome: "approved";
  readonly selected_edge_ids: readonly [string];
  readonly created_activation_ids: readonly [string];
  readonly evidence_refs: readonly [
    GraphEvidenceReference,
    ...GraphEvidenceReference[],
  ];
  readonly output_summary?: string;
}

/** Denied: selects/creates nothing; evidence records the decision and is non-empty. */
export interface GraphDeniedTransition extends GraphCommittedTransitionBase {
  readonly outcome: "denied";
  readonly selected_edge_ids: readonly [];
  readonly created_activation_ids: readonly [];
  readonly evidence_refs: readonly [
    GraphEvidenceReference,
    ...GraphEvidenceReference[],
  ];
  readonly output_summary?: string;
}

/** Join resolved: exactly one fixed edge selected and exactly one activation created; no evidence. */
export interface GraphJoinResolvedTransition extends GraphCommittedTransitionBase {
  readonly outcome: "join_resolved";
  readonly cohort_id: string;
  readonly selected_edge_ids: readonly [string];
  readonly created_activation_ids: readonly [string];
  readonly evidence_refs: readonly [];
}

/** Discriminated union on `outcome`; exact per-outcome fields. */
export type GraphCommittedTransition =
  | GraphSucceededTransition
  | GraphFailedTransition
  | GraphApprovedTransition
  | GraphDeniedTransition
  | GraphJoinResolvedTransition;

/** Descriptor-bound scheduler projection. */
export interface GraphSchedulerProjection {
  readonly descriptor_hash: string;
  readonly run_id: string;
  readonly revision_id: string;
  readonly activations: Readonly<Record<string, GraphActivation>>;
  readonly cohorts: Readonly<Record<string, GraphCohort>>;
  readonly branch_tokens: Readonly<Record<string, GraphBranchToken>>;
  readonly traversal_counts: Readonly<Record<string, number>>;
  readonly committed_transitions: Readonly<
    Record<string, GraphCommittedTransition>
  >;
  readonly terminal_verification_activation_ids: readonly string[];
}

export interface BeginActivationAttemptInput {
  readonly activation_id: string;
  readonly attempt_id: string;
}

export interface ReleaseAttemptForRetryInput {
  readonly activation_id: string;
  readonly attempt_id: string;
}

export interface SchedulerTransitionIdentities {
  readonly next_activation_ids?: Readonly<Record<string, string>>;
  readonly cohort_id?: string;
  readonly branch_token_ids?: Readonly<Record<string, string>>;
  readonly join_activation_id?: string;
}

export interface ApplyNodeResultInput {
  readonly activation_id: string;
  readonly transition_id: string;
  readonly result: GraphNodeResult;
  readonly identities?: SchedulerTransitionIdentities;
}

export interface ApplyHumanApprovalInput {
  readonly activation_id: string;
  readonly transition_id: string;
  readonly decision: GraphApprovalDecision;
  readonly identities?: SchedulerTransitionIdentities;
}

export interface ResolveJoinInput {
  readonly activation_id: string;
  readonly transition_id: string;
  readonly identities?: SchedulerTransitionIdentities;
}

export interface SchedulerApplyResult {
  readonly projection: GraphSchedulerProjection;
  readonly transition: GraphCommittedTransition;
  readonly replayed: boolean;
}

/** Closed scheduler error-code union; every scheduler throw uses exactly one code. */
export type GraphSchedulerErrorCode =
  | "activation_not_found"
  | "activation_not_ready"
  | "max_attempts_exceeded"
  | "attempt_fenced"
  | "transition_fenced"
  | "duplicate_identity"
  | "missing_identity"
  | "unexpected_identity"
  | "undeclared_identity_key"
  | "invalid_input"
  | "descriptor_mismatch"
  | "route_required"
  | "undeclared_route"
  | "traversal_bound_exceeded"
  | "branch_token_fenced"
  | "join_owner_missing"
  | "join_owner_mismatch"
  | "join_not_found"
  | "join_not_ready"
  | "join_already_consumed"
  | "join_is_automatic"
  | "invalid_join_edge"
  | "node_not_found"
  | "terminal_evidence_required"
  | "approval_requires_dedicated_transition"
  | "unsupported_node_kind";

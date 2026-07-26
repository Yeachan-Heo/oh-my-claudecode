export type GraphNodeKind = 'agent' | 'command' | 'human-approval' | 'join';
export type GraphEffectPolicy = {
    policy: 'side_effect_free';
} | {
    policy: 'idempotent';
    idempotency_key_template: string;
} | {
    policy: 'reconcile';
};
interface GraphNodeBase {
    id: string;
    kind: GraphNodeKind;
    title: string;
}
interface GraphExecutableNodeBase extends GraphNodeBase {
    timeout_ms: number;
    max_attempts: number;
    effect_policy: GraphEffectPolicy;
}
export interface GraphAgentNode extends GraphExecutableNodeBase {
    kind: 'agent';
    instructions: string;
}
export interface GraphCommandNode extends GraphExecutableNodeBase {
    kind: 'command';
    command: string;
}
export interface GraphHumanApprovalNode extends GraphNodeBase {
    kind: 'human-approval';
    prompt: string;
}
export interface GraphJoinNode extends GraphNodeBase {
    kind: 'join';
    fan_out_node_id: string;
    input_branch_ids: string[];
}
export type GraphNode = GraphAgentNode | GraphCommandNode | GraphHumanApprovalNode | GraphJoinNode;
interface GraphEdgeBase {
    id: string;
    from: string;
    to: string;
}
export interface GraphFixedEdge extends GraphEdgeBase {
    kind: 'fixed';
}
export interface GraphConditionalEdge extends GraphEdgeBase {
    kind: 'conditional';
    route: string;
}
export interface GraphFanOutEdge extends GraphEdgeBase {
    kind: 'fan_out';
    branch_id: string;
    owner_join_id: string;
}
export interface GraphBackEdge extends GraphEdgeBase {
    kind: 'back_edge';
    route: string;
    max_traversals: number;
}
export type GraphEdge = GraphFixedEdge | GraphConditionalEdge | GraphFanOutEdge | GraphBackEdge;
export interface GraphDescriptorInput {
    descriptor_version: 1;
    run_id: string;
    revision_id: string;
    goal: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    entry_node_ids: string[];
    concurrency_limit: number;
    terminal_verification_node_id: string;
    descriptor_hash?: string;
}
export type GraphDescriptor = GraphDescriptorInput;
export type SealedGraphDescriptor = GraphDescriptorInput & {
    descriptor_hash: string;
};
export interface GraphEvidenceReference {
    kind: 'file' | 'command' | 'test' | 'human' | 'url';
    ref: string;
    summary?: string;
}
export interface GraphNodeResult {
    outcome: 'succeeded' | 'failed';
    attempt_id: string;
    route?: string;
    output_summary?: string;
    evidence_refs: GraphEvidenceReference[];
    external_idempotency_key?: string;
}
export type GraphActivationStatus = 'ready' | 'running' | 'completed' | 'failed';
export interface GraphActivation {
    activation_id: string;
    node_id: string;
    status: GraphActivationStatus;
    attempt_no: number;
    attempt_ids: string[];
    active_attempt_id?: string;
    completed_transition_id?: string;
    cohort_id?: string;
    branch_token_id?: string;
    traversal_owner_id: string;
}
export interface GraphBranchToken {
    branch_token_id: string;
    cohort_id: string;
    branch_id: string;
    owner_join_id: string;
    status: 'active' | 'arrived' | 'consumed';
    current_activation_id?: string;
    consumed_by_activation_id?: string;
}
export interface GraphCohort {
    cohort_id: string;
    fan_out_node_id: string;
    owner_join_id: string;
    expected_branch_token_ids: string[];
    join_activation_id?: string;
    consumed: boolean;
}
export interface GraphCommittedTransition {
    transition_id: string;
    activation_id: string;
    node_id: string;
    outcome: 'succeeded' | 'failed' | 'join_resolved';
    request_fingerprint: string;
    selected_edge_ids: string[];
    created_activation_ids: string[];
    cohort_id?: string;
    attempt_id?: string;
    route?: string;
    output_summary?: string;
    evidence_refs: GraphEvidenceReference[];
    external_idempotency_key?: string;
}
export interface GraphSchedulerProjection {
    activations: Record<string, GraphActivation>;
    cohorts: Record<string, GraphCohort>;
    branch_tokens: Record<string, GraphBranchToken>;
    traversal_counts: Record<string, number>;
    committed_transitions: Record<string, GraphCommittedTransition>;
    terminal_verification_activation_ids: string[];
}
export interface BeginActivationAttemptInput {
    activation_id: string;
    attempt_id: string;
    max_attempts?: number;
}
export type ReleaseAttemptForRetryInput = BeginActivationAttemptInput;
export interface SchedulerTransitionIdentities {
    next_activation_ids?: Record<string, string>;
    cohort_id?: string;
    branch_token_ids?: Record<string, string>;
    join_activation_id?: string;
}
export interface ApplyNodeResultInput {
    activation_id: string;
    transition_id: string;
    result: GraphNodeResult;
    identities?: SchedulerTransitionIdentities;
}
export interface ResolveJoinInput {
    activation_id: string;
    transition_id: string;
    identities?: SchedulerTransitionIdentities;
}
export interface SchedulerApplyResult {
    projection: GraphSchedulerProjection;
    transition: GraphCommittedTransition;
    replayed: boolean;
}
export {};
//# sourceMappingURL=types.d.ts.map
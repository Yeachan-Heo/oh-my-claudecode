import { parseGraphDescriptor, verifyDescriptorHash } from './descriptor.js';
import type {
  GraphEffectPolicy,
  GraphEvidenceReference,
  GraphSchedulerProjection,
  SealedGraphDescriptor,
} from './types.js';

export const GRAPH_STATE_FORMAT_VERSION = 1 as const;
export const GRAPH_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const GRAPH_MAX_TRANSITIONS = 10_000;
export const GRAPH_MAX_DIAGNOSTICS = 128;
export const GRAPH_MAX_RECONCILIATIONS = 1_000;
export const GRAPH_MAX_CLAIMS = 2_000;
export const GRAPH_MAX_TRANSITION_RESULT_BYTES = 32 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GraphRunStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'running'
  | 'waiting_human'
  | 'waiting_patch_approval'
  | 'reconciling'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'succeeded';

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

export type GraphClaimStatus =
  | 'live'
  | 'completed'
  | 'expired_retryable'
  | 'abandoned_retryable'
  | 'reconciling'
  | 'fenced';

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

export type GraphReconciliationStatus =
  | 'unresolved'
  | 'committed'
  | 'proved_not_applied'
  | 'accepted'
  | 'invalidated';

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

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createInitialGraphState(input: CreateInitialGraphStateInput): GraphState {
  const descriptor = parseGraphDescriptor(input.descriptor) as SealedGraphDescriptor;
  if (!verifyDescriptorHash(descriptor)) throw new Error('Initial graph descriptor must be sealed');
  if (
    input.approval
    && (
      (input.approval.revision_id && input.approval.revision_id !== descriptor.revision_id)
      || (input.approval.revision_hash && input.approval.revision_hash !== descriptor.descriptor_hash)
      || input.approval.evidence.kind !== 'human'
    )
  ) {
    throw new Error('Initial graph approval must bind the exact revision/hash with human evidence');
  }
  const status = input.status ?? (input.approval ? 'running' : 'awaiting_approval');
  if (!input.approval && status !== 'draft' && status !== 'awaiting_approval') {
    throw new Error(`Graph status ${status} requires exact revision approval`);
  }
  if (input.approval && (status === 'draft' || status === 'awaiting_approval')) {
    throw new Error(`Approved graph cannot remain in ${status}`);
  }
  if (!input.approval && Object.values(input.projection.activations).some(
    (activation) => activation.status === 'ready' || activation.status === 'running',
  )) {
    throw new Error('Unapproved graph cannot expose claimable work');
  }
  const approval: GraphApprovalRecord | undefined = input.approval
    ? {
        revision_id: descriptor.revision_id,
        revision_hash: descriptor.descriptor_hash,
        approved_at: input.approval.approved_at,
        evidence: clone(input.approval.evidence),
      }
    : undefined;
  const revision: GraphRevisionRecord = {
    revision_id: descriptor.revision_id,
    descriptor_hash: descriptor.descriptor_hash,
    descriptor: clone(descriptor),
    created_at: input.created_at,
    ...(approval ? { approval } : {}),
    invalidated_node_ids: [],
  };
  return {
    format_version: GRAPH_STATE_FORMAT_VERSION,
    session_id: input.session_id,
    run_id: descriptor.run_id,
    control_nonce: input.control_nonce,
    status,
    active_revision_id: descriptor.revision_id,
    active_revision_hash: descriptor.descriptor_hash,
    dispatch_generation: 0,
    commit_sequence: 0,
    revisions: { [descriptor.revision_id]: revision },
    transitions: [],
    projection: clone(input.projection),
    claims: {},
    reconciliations: {},
    diagnostics: [],
    ...(!input.approval
      ? {
          pending_approval: {
            revision_id: descriptor.revision_id,
            revision_hash: descriptor.descriptor_hash,
            requested_at: input.created_at,
          },
        }
      : {}),
    created_at: input.created_at,
    updated_at: input.created_at,
  };
}

export class GraphStateValidationError extends Error {
  readonly code = 'invalid_graph_state';

  constructor(message: string) {
    super(`Invalid graph state: ${message}`);
    this.name = 'GraphStateValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GraphStateValidationError(`${name} must be an object`);
  return value;
}

function requireString(value: unknown, name: string, max = 32_768): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new GraphStateValidationError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function requireInteger(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new GraphStateValidationError(`${name} must be a bounded non-negative integer`);
  }
  return value as number;
}

function requireTimestamp(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!Number.isFinite(Date.parse(result))) throw new GraphStateValidationError(`${name} must be an ISO timestamp`);
  return result;
}

function assertExactKeys(record: Record<string, unknown>, required: string[], optional: string[], name: string): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in record));
  if (missing.length > 0) throw new GraphStateValidationError(`${name} missing ${missing.join(', ')}`);
  if (unknown.length > 0) throw new GraphStateValidationError(`${name} has unknown ${unknown.join(', ')}`);
}

function requireStringArray(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new GraphStateValidationError(`${name} must be a bounded array`);
  }
  const result = value.map((item, index) => requireString(item, `${name}[${index}]`, 128));
  if (new Set(result).size !== result.length) throw new GraphStateValidationError(`${name} contains duplicates`);
  return result;
}

function validateEvidence(value: unknown, name: string): GraphEvidenceReference {
  const evidence = requireRecord(value, name);
  assertExactKeys(evidence, ['kind', 'ref'], ['summary'], name);
  if (!['file', 'command', 'test', 'human', 'url'].includes(String(evidence.kind))) {
    throw new GraphStateValidationError(`${name}.kind is invalid`);
  }
  requireString(evidence.ref, `${name}.ref`, 2_048);
  if (evidence.summary !== undefined) requireString(evidence.summary, `${name}.summary`, 2_048);
  return value as GraphEvidenceReference;
}

function validateEffectPolicy(value: unknown, name: string): GraphEffectPolicy {
  const policy = requireRecord(value, name);
  if (policy.policy === 'side_effect_free' || policy.policy === 'reconcile') {
    assertExactKeys(policy, ['policy'], [], name);
    return value as GraphEffectPolicy;
  }
  if (policy.policy === 'idempotent') {
    assertExactKeys(policy, ['policy', 'idempotency_key_template'], [], name);
    requireString(policy.idempotency_key_template, `${name}.idempotency_key_template`, 512);
    return value as GraphEffectPolicy;
  }
  throw new GraphStateValidationError(`${name}.policy is invalid`);
}

function validateApproval(value: unknown, name: string, revisionId: string, revisionHash: string): GraphApprovalRecord {
  const approval = requireRecord(value, name);
  assertExactKeys(approval, ['revision_id', 'revision_hash', 'approved_at', 'evidence'], [], name);
  if (approval.revision_id !== revisionId || approval.revision_hash !== revisionHash) {
    throw new GraphStateValidationError(`${name} does not bind the exact revision/hash`);
  }
  requireTimestamp(approval.approved_at, `${name}.approved_at`);
  const evidence = validateEvidence(approval.evidence, `${name}.evidence`);
  if (evidence.kind !== 'human') throw new GraphStateValidationError(`${name} requires human evidence`);
  return value as GraphApprovalRecord;
}

function validateProjection(value: unknown, descriptor: SealedGraphDescriptor): GraphSchedulerProjection {
  const projection = requireRecord(value, 'projection');
  assertExactKeys(projection, [
    'activations',
    'cohorts',
    'branch_tokens',
    'traversal_counts',
    'committed_transitions',
    'terminal_verification_activation_ids',
  ], [], 'projection');
  const nodeIds = new Set(descriptor.nodes.map((node) => node.id));
  const activations = requireRecord(projection.activations, 'projection.activations');
  for (const [key, raw] of Object.entries(activations)) {
    const activation = requireRecord(raw, `projection.activations.${key}`);
    assertExactKeys(activation, [
      'activation_id', 'node_id', 'status', 'attempt_no', 'attempt_ids', 'traversal_owner_id',
    ], [
      'active_attempt_id', 'completed_transition_id', 'cohort_id', 'branch_token_id',
    ], `projection.activations.${key}`);
    if (activation.activation_id !== key) throw new GraphStateValidationError(`activation key ${key} mismatches identity`);
    const nodeId = requireString(activation.node_id, `projection.activations.${key}.node_id`, 128);
    if (!nodeIds.has(nodeId)) throw new GraphStateValidationError(`activation ${key} references unknown node ${nodeId}`);
    if (!['ready', 'running', 'completed', 'failed'].includes(String(activation.status))) {
      throw new GraphStateValidationError(`activation ${key} has invalid status`);
    }
    const attemptNo = requireInteger(activation.attempt_no, `projection.activations.${key}.attempt_no`, 20);
    const attempts = requireStringArray(activation.attempt_ids, `projection.activations.${key}.attempt_ids`, 20);
    if (attemptNo !== attempts.length) throw new GraphStateValidationError(`activation ${key} attempt count mismatch`);
    requireString(activation.traversal_owner_id, `projection.activations.${key}.traversal_owner_id`, 128);
    if (activation.active_attempt_id !== undefined) {
      const activeAttempt = requireString(activation.active_attempt_id, `projection.activations.${key}.active_attempt_id`, 128);
      if (!attempts.includes(activeAttempt)) throw new GraphStateValidationError(`activation ${key} active attempt is unknown`);
    }
    if (activation.status === 'running' && !activation.active_attempt_id) {
      throw new GraphStateValidationError(`running activation ${key} has no active attempt`);
    }
  }

  const cohorts = requireRecord(projection.cohorts, 'projection.cohorts');
  for (const [key, raw] of Object.entries(cohorts)) {
    const cohort = requireRecord(raw, `projection.cohorts.${key}`);
    assertExactKeys(cohort, [
      'cohort_id', 'fan_out_node_id', 'owner_join_id', 'expected_branch_token_ids', 'consumed',
    ], ['join_activation_id'], `projection.cohorts.${key}`);
    if (cohort.cohort_id !== key) throw new GraphStateValidationError(`cohort key ${key} mismatches identity`);
    for (const property of ['fan_out_node_id', 'owner_join_id'] as const) {
      const nodeId = requireString(cohort[property], `projection.cohorts.${key}.${property}`, 128);
      if (!nodeIds.has(nodeId)) throw new GraphStateValidationError(`cohort ${key} references unknown node ${nodeId}`);
    }
    requireStringArray(cohort.expected_branch_token_ids, `projection.cohorts.${key}.expected_branch_token_ids`, 64);
    if (typeof cohort.consumed !== 'boolean') throw new GraphStateValidationError(`cohort ${key}.consumed must be boolean`);
    if (cohort.join_activation_id !== undefined && !(String(cohort.join_activation_id) in activations)) {
      throw new GraphStateValidationError(`cohort ${key} references unknown join activation`);
    }
  }

  const tokens = requireRecord(projection.branch_tokens, 'projection.branch_tokens');
  for (const [key, raw] of Object.entries(tokens)) {
    const token = requireRecord(raw, `projection.branch_tokens.${key}`);
    assertExactKeys(token, [
      'branch_token_id', 'cohort_id', 'branch_id', 'owner_join_id', 'status',
    ], ['current_activation_id', 'consumed_by_activation_id'], `projection.branch_tokens.${key}`);
    if (token.branch_token_id !== key) throw new GraphStateValidationError(`branch token key ${key} mismatches identity`);
    if (!(String(token.cohort_id) in cohorts)) throw new GraphStateValidationError(`branch token ${key} references unknown cohort`);
    requireString(token.branch_id, `projection.branch_tokens.${key}.branch_id`, 128);
    requireString(token.owner_join_id, `projection.branch_tokens.${key}.owner_join_id`, 128);
    if (!['active', 'arrived', 'consumed'].includes(String(token.status))) {
      throw new GraphStateValidationError(`branch token ${key} has invalid status`);
    }
    for (const property of ['current_activation_id', 'consumed_by_activation_id'] as const) {
      if (token[property] !== undefined && !(String(token[property]) in activations)) {
        throw new GraphStateValidationError(`branch token ${key} references unknown activation`);
      }
    }
  }

  const traversals = requireRecord(projection.traversal_counts, 'projection.traversal_counts');
  // traversal_counts keys are produced by traversalCounterKey() as
  // canonicalJson([traversal_owner_id, edge.id]). The traversal_owner_id is always
  // an activation_id or branch_token_id, both of which are record keys in scope here.
  const traversalOwnerIds = new Set<string>([...Object.keys(activations), ...Object.keys(tokens)]);
  for (const [key, count] of Object.entries(traversals)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(key);
    } catch {
      throw new GraphStateValidationError(`traversal count key ${key} is not valid JSON`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
      throw new GraphStateValidationError(`traversal count key ${key} is not a [owner, edgeId] pair`);
    }
    const [owner, edgeId] = parsed as [string, string];
    if (!traversalOwnerIds.has(owner)) {
      throw new GraphStateValidationError(`traversal count key ${key} references unknown traversal owner ${owner}`);
    }
    if (!descriptor.edges.some((edge) => edge.id === edgeId && edge.kind === 'back_edge')) {
      throw new GraphStateValidationError(`traversal count references unknown back-edge ${edgeId}`);
    }
    requireInteger(count, `projection.traversal_counts.${key}`, 100);
  }

  const committed = requireRecord(projection.committed_transitions, 'projection.committed_transitions');
  if (Object.keys(committed).length > GRAPH_MAX_TRANSITIONS) {
    throw new GraphStateValidationError('scheduler committed transitions exceed the configured bound');
  }
  for (const [key, raw] of Object.entries(committed)) {
    const transition = requireRecord(raw, `projection.committed_transitions.${key}`);
    assertExactKeys(transition, [
      'transition_id', 'activation_id', 'node_id', 'outcome', 'request_fingerprint',
      'selected_edge_ids', 'created_activation_ids', 'evidence_refs',
    ], [
      'cohort_id', 'attempt_id', 'route', 'output_summary', 'external_idempotency_key',
    ], `projection.committed_transitions.${key}`);
    if (transition.transition_id !== key) throw new GraphStateValidationError(`scheduler transition key ${key} mismatches identity`);
    if (!(String(transition.activation_id) in activations)) {
      throw new GraphStateValidationError(`scheduler transition ${key} references unknown activation`);
    }
    const nodeId = requireString(transition.node_id, `projection.committed_transitions.${key}.node_id`, 128);
    if (!nodeIds.has(nodeId)) throw new GraphStateValidationError(`scheduler transition ${key} references unknown node`);
    if (!['succeeded', 'failed', 'join_resolved'].includes(String(transition.outcome))) {
      throw new GraphStateValidationError(`scheduler transition ${key} has invalid outcome`);
    }
    requireString(transition.request_fingerprint, `projection.committed_transitions.${key}.request_fingerprint`, 64);
    requireStringArray(transition.selected_edge_ids, `projection.committed_transitions.${key}.selected_edge_ids`, 64);
    requireStringArray(transition.created_activation_ids, `projection.committed_transitions.${key}.created_activation_ids`, 64);
    if (!Array.isArray(transition.evidence_refs) || transition.evidence_refs.length > 64) {
      throw new GraphStateValidationError(`scheduler transition ${key} evidence is invalid`);
    }
    transition.evidence_refs.forEach((item, index) => validateEvidence(item, `scheduler transition ${key} evidence[${index}]`));
  }

  const terminalIds = requireStringArray(
    projection.terminal_verification_activation_ids,
    'projection.terminal_verification_activation_ids',
    GRAPH_MAX_TRANSITIONS,
  );
  for (const activationId of terminalIds) {
    const activation = activations[activationId] as Record<string, unknown> | undefined;
    if (!activation || activation.node_id !== descriptor.terminal_verification_node_id) {
      throw new GraphStateValidationError(`terminal verification activation ${activationId} is invalid`);
    }
  }
  return value as GraphSchedulerProjection;
}

function validateRevision(value: unknown, key: string, runId: string): GraphRevisionRecord {
  const revision = requireRecord(value, `revisions.${key}`);
  assertExactKeys(revision, [
    'revision_id', 'descriptor_hash', 'descriptor', 'created_at', 'invalidated_node_ids',
  ], ['approval'], `revisions.${key}`);
  const revisionId = requireString(revision.revision_id, `revisions.${key}.revision_id`, 128);
  const hash = requireString(revision.descriptor_hash, `revisions.${key}.descriptor_hash`, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new GraphStateValidationError(`revision ${key} hash is invalid`);
  if (revisionId !== key) throw new GraphStateValidationError(`revision key ${key} does not match revision_id`);
  const descriptor = parseGraphDescriptor(revision.descriptor) as SealedGraphDescriptor;
  if (!verifyDescriptorHash(descriptor) || descriptor.descriptor_hash !== hash) {
    throw new GraphStateValidationError(`revision ${key} descriptor hash mismatch`);
  }
  if (descriptor.revision_id !== key || descriptor.run_id !== runId) {
    throw new GraphStateValidationError(`revision ${key} descriptor identity mismatch`);
  }
  requireTimestamp(revision.created_at, `revisions.${key}.created_at`);
  if (!Array.isArray(revision.invalidated_node_ids)) {
    throw new GraphStateValidationError(`revisions.${key}.invalidated_node_ids must be an array`);
  }
  requireStringArray(revision.invalidated_node_ids, `revisions.${key}.invalidated_node_ids`, 1_000);
  if (revision.approval !== undefined) validateApproval(revision.approval, `revisions.${key}.approval`, key, hash);
  return value as GraphRevisionRecord;
}

export function parseGraphState(input: unknown): GraphState {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch (error) {
    throw new GraphStateValidationError(`state is not JSON serializable: ${String(error)}`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > GRAPH_STATE_MAX_BYTES) {
    throw new GraphStateValidationError(`state exceeds ${GRAPH_STATE_MAX_BYTES} bytes`);
  }
  const state = requireRecord(input, 'state');
  assertExactKeys(state, [
    'format_version', 'session_id', 'run_id', 'control_nonce', 'status', 'active_revision_id',
    'active_revision_hash', 'dispatch_generation', 'commit_sequence', 'revisions',
    'transitions', 'projection', 'claims', 'reconciliations', 'diagnostics',
    'created_at', 'updated_at',
  ], ['pending_approval', 'pending_patch'], 'state');
  if (state.format_version !== GRAPH_STATE_FORMAT_VERSION) {
    throw new GraphStateValidationError('unsupported format_version');
  }
  const sessionId = requireString(state.session_id, 'session_id', 256);
  const runId = requireString(state.run_id, 'run_id', 128);
  requireString(state.control_nonce, 'control_nonce', 128);
  const activeRevisionId = requireString(state.active_revision_id, 'active_revision_id', 128);
  const activeHash = requireString(state.active_revision_hash, 'active_revision_hash', 64);
  if (!/^[a-f0-9]{64}$/.test(activeHash)) throw new GraphStateValidationError('active_revision_hash is invalid');
  requireInteger(state.dispatch_generation, 'dispatch_generation');
  const sequence = requireInteger(state.commit_sequence, 'commit_sequence', GRAPH_MAX_TRANSITIONS);
  requireTimestamp(state.created_at, 'created_at');
  requireTimestamp(state.updated_at, 'updated_at');
  const statuses: GraphRunStatus[] = [
    'draft', 'awaiting_approval', 'running', 'waiting_human', 'waiting_patch_approval',
    'reconciling', 'paused', 'failed', 'cancelled', 'succeeded',
  ];
  if (!statuses.includes(state.status as GraphRunStatus)) throw new GraphStateValidationError('invalid status');

  const revisions = requireRecord(state.revisions, 'revisions');
  for (const [key, revision] of Object.entries(revisions)) validateRevision(revision, key, runId);
  const active = revisions[activeRevisionId] as GraphRevisionRecord | undefined;
  if (!active || active.descriptor_hash !== activeHash) {
    throw new GraphStateValidationError('active revision/hash is not embedded');
  }
  const approvedStatuses = new Set<GraphRunStatus>([
    'running', 'waiting_human', 'waiting_patch_approval', 'reconciling', 'paused',
    'failed', 'cancelled', 'succeeded',
  ]);
  if (approvedStatuses.has(state.status as GraphRunStatus) && !active.approval) {
    throw new GraphStateValidationError(`status ${String(state.status)} requires exact active revision approval`);
  }

  if (!Array.isArray(state.transitions) || state.transitions.length > GRAPH_MAX_TRANSITIONS) {
    throw new GraphStateValidationError('transitions exceed the configured bound');
  }
  const transitionIds = new Set<string>();
  let priorSequence = 0;
  for (const raw of state.transitions) {
    const transition = requireRecord(raw, 'transition');
    assertExactKeys(transition, [
      'transition_id', 'operation', 'operation_fingerprint', 'request_fingerprint',
      'sequence', 'committed_at', 'result',
    ], [], 'transition');
    const id = requireString(transition.transition_id, 'transition.transition_id', 128);
    if (transitionIds.has(id)) throw new GraphStateValidationError(`duplicate transition ${id}`);
    transitionIds.add(id);
    const currentSequence = requireInteger(transition.sequence, 'transition.sequence', GRAPH_MAX_TRANSITIONS);
    if (currentSequence <= priorSequence) throw new GraphStateValidationError('transition sequence is not monotonic');
    priorSequence = currentSequence;
    requireString(transition.operation, 'transition.operation', 128);
    requireString(transition.operation_fingerprint, 'transition.operation_fingerprint', 1_024);
    const fingerprint = requireString(transition.request_fingerprint, 'transition.request_fingerprint', 64);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new GraphStateValidationError(`transition ${id} request_fingerprint is invalid`);
    }
    requireTimestamp(transition.committed_at, 'transition.committed_at');
    if (Buffer.byteLength(JSON.stringify(transition.result), 'utf8') > GRAPH_MAX_TRANSITION_RESULT_BYTES) {
      throw new GraphStateValidationError(`transition ${id} result exceeds the configured bound`);
    }
  }
  if (state.transitions.length > 0 && priorSequence !== sequence) {
    throw new GraphStateValidationError('commit_sequence does not match transition history');
  }
  if (state.transitions.length === 0 && sequence !== 0) {
    throw new GraphStateValidationError('nonzero commit_sequence has no transition history');
  }

  validateProjection(state.projection, active.descriptor);
  const claims = requireRecord(state.claims, 'claims');
  const reconciliations = requireRecord(state.reconciliations, 'reconciliations');
  if (Object.keys(claims).length > GRAPH_MAX_CLAIMS) throw new GraphStateValidationError('claims exceed the configured bound');
  if (Object.keys(reconciliations).length > GRAPH_MAX_RECONCILIATIONS) {
    throw new GraphStateValidationError('reconciliations exceed the configured bound');
  }
  for (const [leaseId, raw] of Object.entries(claims)) {
    const claim = requireRecord(raw, `claims.${leaseId}`);
    assertExactKeys(claim, [
      'run_id', 'revision_id', 'revision_hash', 'dispatch_generation', 'activation_id',
      'attempt_id', 'attempt_no', 'claim_owner_session_id', 'driver_instance_id',
      'lease_id', 'tracking_id', 'issued_at', 'expires_at', 'lease_duration_ms',
      'renewal_count', 'max_renewals', 'effect_policy', 'status',
    ], [
      'external_idempotency_key', 'last_renewed_at', 'fenced_at', 'replacement_lease_id',
    ], `claims.${leaseId}`);
    if (claim.lease_id !== leaseId) throw new GraphStateValidationError(`claim key ${leaseId} mismatches identity`);
    if (claim.run_id !== runId) throw new GraphStateValidationError(`claim ${leaseId} run fence mismatches`);
    const revisionId = requireString(claim.revision_id, `claims.${leaseId}.revision_id`, 128);
    const revisionHash = requireString(claim.revision_hash, `claims.${leaseId}.revision_hash`, 64);
    const claimRevision = revisions[revisionId] as GraphRevisionRecord | undefined;
    if (!claimRevision || claimRevision.descriptor_hash !== revisionHash) {
      throw new GraphStateValidationError(`claim ${leaseId} revision fence is invalid`);
    }
    requireInteger(claim.dispatch_generation, `claims.${leaseId}.dispatch_generation`);
    const activationId = requireString(claim.activation_id, `claims.${leaseId}.activation_id`, 128);
    const activation = (state.projection as GraphSchedulerProjection).activations[activationId];
    if (!activation) throw new GraphStateValidationError(`claim ${leaseId} references unknown activation`);
    const attemptId = requireString(claim.attempt_id, `claims.${leaseId}.attempt_id`, 128);
    const attemptNo = requireInteger(claim.attempt_no, `claims.${leaseId}.attempt_no`, 20);
    if (!activation.attempt_ids.includes(attemptId) || activation.attempt_no < attemptNo) {
      throw new GraphStateValidationError(`claim ${leaseId} attempt fence is invalid`);
    }
    for (const property of ['claim_owner_session_id', 'driver_instance_id', 'tracking_id'] as const) {
      requireString(claim[property], `claims.${leaseId}.${property}`, 256);
    }
    const issued = requireTimestamp(claim.issued_at, `claims.${leaseId}.issued_at`);
    const expires = requireTimestamp(claim.expires_at, `claims.${leaseId}.expires_at`);
    const duration = requireInteger(claim.lease_duration_ms, `claims.${leaseId}.lease_duration_ms`, 86_400_000);
    const leaseStart = claim.last_renewed_at === undefined
      ? issued
      : requireTimestamp(claim.last_renewed_at, `claims.${leaseId}.last_renewed_at`);
    if (duration <= 0 || Date.parse(expires) - Date.parse(leaseStart) !== duration) {
      throw new GraphStateValidationError(`claim ${leaseId} lease duration is inconsistent`);
    }
    const renewals = requireInteger(claim.renewal_count, `claims.${leaseId}.renewal_count`, 20);
    const maxRenewals = requireInteger(claim.max_renewals, `claims.${leaseId}.max_renewals`, 20);
    if (renewals > maxRenewals) throw new GraphStateValidationError(`claim ${leaseId} renewal cap is exceeded`);
    const policy = validateEffectPolicy(claim.effect_policy, `claims.${leaseId}.effect_policy`);
    if (policy.policy === 'idempotent') {
      requireString(claim.external_idempotency_key, `claims.${leaseId}.external_idempotency_key`, 512);
    } else if (claim.external_idempotency_key !== undefined) {
      throw new GraphStateValidationError(`claim ${leaseId} has an unexpected idempotency key`);
    }
    if (!['live', 'completed', 'expired_retryable', 'abandoned_retryable', 'reconciling', 'fenced'].includes(String(claim.status))) {
      throw new GraphStateValidationError(`claim ${leaseId} has invalid status`);
    }
    if (claim.status !== 'live' && claim.fenced_at === undefined) {
      throw new GraphStateValidationError(`non-live claim ${leaseId} requires fenced_at`);
    }
    if (claim.fenced_at !== undefined) requireTimestamp(claim.fenced_at, `claims.${leaseId}.fenced_at`);
    if (claim.replacement_lease_id !== undefined) {
      requireString(claim.replacement_lease_id, `claims.${leaseId}.replacement_lease_id`, 128);
    }
  }

  for (const [id, raw] of Object.entries(reconciliations)) {
    const record = requireRecord(raw, `reconciliations.${id}`);
    assertExactKeys(record, [
      'reconciliation_id', 'activation_id', 'attempt_id', 'lease_id', 'revision_id',
      'revision_hash', 'dispatch_generation', 'status', 'reason', 'created_at',
    ], ['resolved_at', 'resolution_evidence'], `reconciliations.${id}`);
    if (record.reconciliation_id !== id) throw new GraphStateValidationError(`reconciliation key ${id} mismatches identity`);
    const leaseId = requireString(record.lease_id, `reconciliations.${id}.lease_id`, 128);
    const claim = claims[leaseId] as Record<string, unknown> | undefined;
    if (!claim || record.activation_id !== claim.activation_id || record.attempt_id !== claim.attempt_id) {
      throw new GraphStateValidationError(`reconciliation ${id} claim lineage is invalid`);
    }
    if (record.revision_id !== claim.revision_id || record.revision_hash !== claim.revision_hash
      || record.dispatch_generation !== claim.dispatch_generation) {
      throw new GraphStateValidationError(`reconciliation ${id} revision fence is invalid`);
    }
    if (!['unresolved', 'committed', 'proved_not_applied', 'accepted', 'invalidated'].includes(String(record.status))) {
      throw new GraphStateValidationError(`reconciliation ${id} status is invalid`);
    }
    if (!['expired_ambiguous', 'session_end_ambiguous', 'external_effect_ambiguous'].includes(String(record.reason))) {
      throw new GraphStateValidationError(`reconciliation ${id} reason is invalid`);
    }
    requireTimestamp(record.created_at, `reconciliations.${id}.created_at`);
    if (record.status === 'unresolved' && (record.resolved_at !== undefined || record.resolution_evidence !== undefined)) {
      throw new GraphStateValidationError(`unresolved reconciliation ${id} cannot have resolution fields`);
    }
    if (record.status !== 'unresolved') {
      requireTimestamp(record.resolved_at, `reconciliations.${id}.resolved_at`);
      validateEvidence(record.resolution_evidence, `reconciliations.${id}.resolution_evidence`);
    }
  }

  if (!Array.isArray(state.diagnostics) || state.diagnostics.length > GRAPH_MAX_DIAGNOSTICS) {
    throw new GraphStateValidationError('diagnostics exceed the configured bound');
  }
  state.diagnostics.forEach((raw, index) => {
    const diagnostic = requireRecord(raw, `diagnostics[${index}]`);
    assertExactKeys(diagnostic, ['kind', 'recorded_at', 'summary'], [
      'activation_id', 'attempt_id', 'lease_id',
    ], `diagnostics[${index}]`);
    if (!['late_result', 'operation', 'recovery', 'control'].includes(String(diagnostic.kind))) {
      throw new GraphStateValidationError(`diagnostics[${index}].kind is invalid`);
    }
    requireTimestamp(diagnostic.recorded_at, `diagnostics[${index}].recorded_at`);
    requireString(diagnostic.summary, `diagnostics[${index}].summary`, 8_192);
    for (const property of ['activation_id', 'attempt_id', 'lease_id'] as const) {
      if (diagnostic[property] !== undefined) requireString(diagnostic[property], `diagnostics[${index}].${property}`, 128);
    }
  });

  if (state.pending_approval !== undefined) {
    const pending = requireRecord(state.pending_approval, 'pending_approval');
    assertExactKeys(pending, ['revision_id', 'revision_hash', 'requested_at'], [], 'pending_approval');
    if (pending.revision_id !== activeRevisionId || pending.revision_hash !== activeHash) {
      throw new GraphStateValidationError('pending approval does not bind the active revision/hash');
    }
    requireTimestamp(pending.requested_at, 'pending_approval.requested_at');
  }
  if (state.status === 'awaiting_approval' && !state.pending_approval) {
    throw new GraphStateValidationError('awaiting_approval requires pending_approval');
  }
  if (state.status !== 'awaiting_approval' && state.pending_approval) {
    throw new GraphStateValidationError('pending_approval must be absent outside awaiting_approval');
  }
  if (state.pending_approval && active.approval) {
    throw new GraphStateValidationError('approved revision cannot remain pending approval');
  }
  if (!active.approval && Object.values((state.projection as GraphSchedulerProjection).activations).some(
    (activation) => activation.status === 'ready' || activation.status === 'running',
  )) {
    throw new GraphStateValidationError('unapproved graph cannot expose claimable work');
  }

  if (state.pending_patch !== undefined) {
    const patch = requireRecord(state.pending_patch, 'pending_patch');
    assertExactKeys(patch, [
      'proposal_id', 'base_revision_id', 'base_revision_hash', 'base_dispatch_generation',
      'proposed_revision_id', 'proposed_revision_hash', 'proposed_descriptor',
      'invalidated_node_ids', 'proposal_evidence', 'proposed_at',
    ], [], 'pending_patch');
    requireString(patch.proposal_id, 'pending_patch.proposal_id', 128);
    if (patch.base_revision_id !== activeRevisionId || patch.base_revision_hash !== activeHash) {
      throw new GraphStateValidationError('pending patch base does not bind active revision/hash');
    }
    const baseGeneration = requireInteger(patch.base_dispatch_generation, 'pending_patch.base_dispatch_generation');
    if (baseGeneration + 1 !== state.dispatch_generation) {
      throw new GraphStateValidationError('pending patch dispatch generation is invalid');
    }
    const proposed = parseGraphDescriptor(patch.proposed_descriptor) as SealedGraphDescriptor;
    if (!verifyDescriptorHash(proposed)
      || proposed.revision_id !== patch.proposed_revision_id
      || proposed.descriptor_hash !== patch.proposed_revision_hash
      || proposed.run_id !== runId
      || proposed.revision_id === activeRevisionId) {
      throw new GraphStateValidationError('pending patch proposed descriptor identity/hash is invalid');
    }
    requireStringArray(patch.invalidated_node_ids, 'pending_patch.invalidated_node_ids', 1_000);
    if (!Array.isArray(patch.proposal_evidence) || patch.proposal_evidence.length > 64) {
      throw new GraphStateValidationError('pending patch proposal evidence is invalid');
    }
    patch.proposal_evidence.forEach((item, index) => validateEvidence(item, `pending_patch.proposal_evidence[${index}]`));
    requireTimestamp(patch.proposed_at, 'pending_patch.proposed_at');
  }
  if (state.pending_patch && state.status !== 'waiting_patch_approval') {
    throw new GraphStateValidationError('pending_patch requires waiting_patch_approval status');
  }
  if (!state.pending_patch && state.status === 'waiting_patch_approval') {
    throw new GraphStateValidationError('waiting_patch_approval requires pending_patch');
  }
  if (Object.values(claims).some(
    (raw) => (raw as Record<string, unknown>).claim_owner_session_id !== sessionId,
  )) {
    throw new GraphStateValidationError('claim owner session does not match graph authority session');
  }
  return clone(input as GraphState);
}

export type GraphControlMode =
  | 'graph'
  | 'autopilot'
  | 'autoresearch'
  | 'ralph'
  | 'team'
  | 'ultrawork'
  | 'ultraqa'
  | 'ralplan'
  | 'deep-interview'
  | 'self-improve';

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
  graph_revision?: { revision_id: string; revision_hash: string };
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

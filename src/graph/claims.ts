import { canonicalJson } from './descriptor.js';
import {
  GRAPH_MAX_DIAGNOSTICS,
  GRAPH_MAX_RECONCILIATIONS,
  parseGraphState,
  type GraphClaim,
  type GraphDiagnostic,
  type GraphReconciliationRecord,
  type GraphState,
} from './runtime-types.js';
import type { GraphEffectPolicy, GraphSchedulerProjection } from './types.js';

const MAX_EXECUTION_TIMEOUT_MS = 86_400_000;
const MAX_GRACE_MS = 3_600_000;
const MAX_RENEWALS = 20;

export class GraphClaimError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GraphClaimError';
    this.code = code;
  }
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

export type ReplaceAttemptProjection = (
  projection: GraphSchedulerProjection,
  input: ReplacementAttemptInput,
) => GraphSchedulerProjection;

export interface GraphClaimRecoveryResult {
  state: GraphState;
  disposition: 'taken_over' | 'reconciling';
  claim?: GraphClaim;
  reconciliation?: GraphReconciliationRecord;
}

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new GraphClaimError('invalid_timestamp', `${name} must be an ISO timestamp`);
  return parsed;
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new GraphClaimError('invalid_identity', `${name} must be a stable identifier`);
  }
}

function activeDescriptor(state: GraphState) {
  return state.revisions[state.active_revision_id].descriptor;
}

function findClaim(state: GraphState, leaseId: string): GraphClaim {
  const claim = state.claims[leaseId];
  if (!claim) throw new GraphClaimError('claim_not_found', `Claim ${leaseId} does not exist`);
  return claim;
}

function ensureLiveClaim(state: GraphState, leaseId: string): GraphClaim {
  const claim = findClaim(state, leaseId);
  if (claim.status !== 'live') throw new GraphClaimError('claim_not_live', `Claim ${leaseId} is no longer live`);
  return claim;
}

function cloneWithClaims(state: GraphState, claims: Record<string, GraphClaim>): GraphState {
  return { ...structuredClone(state), claims };
}

function validateLeasePolicy(input: IssueGraphClaimInput): void {
  if (!Number.isSafeInteger(input.execution_timeout_ms)
    || input.execution_timeout_ms < 100
    || input.execution_timeout_ms > MAX_EXECUTION_TIMEOUT_MS) {
    throw new GraphClaimError('invalid_timeout', 'Execution timeout is outside the configured bound');
  }
  if (!Number.isSafeInteger(input.grace_ms) || input.grace_ms <= 0 || input.grace_ms > MAX_GRACE_MS) {
    throw new GraphClaimError('invalid_grace', 'Lease grace must be positive and bounded');
  }
  if (!Number.isSafeInteger(input.max_renewals)
    || input.max_renewals < 0
    || input.max_renewals > MAX_RENEWALS) {
    throw new GraphClaimError('invalid_renewal_cap', 'Claim renewal cap is outside the configured bound');
  }
  if (input.effect_policy.policy === 'idempotent' && !input.external_idempotency_key) {
    throw new GraphClaimError('missing_idempotency_key', 'Idempotent claims require a durable idempotency key');
  }
  if (input.effect_policy.policy !== 'idempotent' && input.external_idempotency_key) {
    throw new GraphClaimError('unexpected_idempotency_key', 'Only idempotent claims may carry an idempotency key');
  }
}

export function issueGraphClaim(stateInput: GraphState, input: IssueGraphClaimInput): GraphClaimResult {
  const state = parseGraphState(stateInput);
  if (state.status !== 'running') {
    throw new GraphClaimError('dispatch_paused', `Cannot issue a claim while graph status is ${state.status}`);
  }
  for (const id of [
    input.activation_id,
    input.attempt_id,
    input.lease_id,
    input.driver_instance_id,
    input.tracking_id,
  ]) assertIdentifier(id, 'claim identity');
  validateLeasePolicy(input);
  if (state.claims[input.lease_id]) throw new GraphClaimError('duplicate_lease', `Lease ${input.lease_id} already exists`);
  if (Object.values(state.claims).some(
    (claim) => claim.activation_id === input.activation_id && claim.status === 'live',
  )) {
    throw new GraphClaimError('activation_claimed', `Activation ${input.activation_id} already has a live claim`);
  }
  const activation = state.projection.activations[input.activation_id];
  if (!activation
    || activation.status !== 'running'
    || activation.active_attempt_id !== input.attempt_id
    || activation.attempt_no !== input.attempt_no) {
    throw new GraphClaimError('attempt_fence_mismatch', 'Claim activation/attempt fence does not match projection');
  }
  const node = activeDescriptor(state).nodes.find((candidate) => candidate.id === activation.node_id);
  if (!node) {
    throw new GraphClaimError('node_not_found', `Node ${activation.node_id} does not exist`);
  }
  // B6: human-approval nodes are executable via the in-session question surface.
  // They carry no effect_policy or timeout_ms, so skip the executable-kind and
  // policy/timeout gates for them; the claim is a durable wait fence.
  if (node.kind === 'human-approval') {
    if (input.claim_owner_session_id !== state.session_id) {
      throw new GraphClaimError('claim_session_mismatch', 'Claim owner must match the Graph authority session');
    }
    const issuedAt = timestamp(input.issued_at, 'issued_at');
    const leaseDuration = input.execution_timeout_ms + input.grace_ms;
    const claim: GraphClaim = {
      run_id: state.run_id,
      revision_id: state.active_revision_id,
      revision_hash: state.active_revision_hash,
      dispatch_generation: state.dispatch_generation,
      activation_id: input.activation_id,
      attempt_id: input.attempt_id,
      attempt_no: input.attempt_no,
      claim_owner_session_id: input.claim_owner_session_id,
      driver_instance_id: input.driver_instance_id,
      lease_id: input.lease_id,
      tracking_id: input.tracking_id,
      issued_at: input.issued_at,
      expires_at: new Date(issuedAt + leaseDuration).toISOString(),
      lease_duration_ms: leaseDuration,
      renewal_count: 0,
      max_renewals: input.max_renewals,
      effect_policy: structuredClone(input.effect_policy),
      status: 'live',
    };
    const next = cloneWithClaims(state, { ...state.claims, [claim.lease_id]: claim });
    return { state: parseGraphState(next), claim: structuredClone(claim) };
  }
  if (node.kind !== 'agent' && node.kind !== 'command') {
    throw new GraphClaimError('node_not_executable', 'Only executable agent/command activations can be claimed');
  }
  if (canonicalJson(node.effect_policy) !== canonicalJson(input.effect_policy)) {
    throw new GraphClaimError('effect_policy_mismatch', 'Claim effect policy does not match the approved descriptor');
  }
  if (input.claim_owner_session_id !== state.session_id) {
    throw new GraphClaimError('claim_session_mismatch', 'Claim owner must match the Graph authority session');
  }
  if (input.execution_timeout_ms !== node.timeout_ms) {
    throw new GraphClaimError('timeout_mismatch', 'Claim timeout must equal the exact approved node timeout');
  }
  const issuedAt = timestamp(input.issued_at, 'issued_at');
  const leaseDuration = input.execution_timeout_ms + input.grace_ms;
  const claim: GraphClaim = {
    run_id: state.run_id,
    revision_id: state.active_revision_id,
    revision_hash: state.active_revision_hash,
    dispatch_generation: state.dispatch_generation,
    activation_id: input.activation_id,
    attempt_id: input.attempt_id,
    attempt_no: input.attempt_no,
    claim_owner_session_id: input.claim_owner_session_id,
    driver_instance_id: input.driver_instance_id,
    lease_id: input.lease_id,
    tracking_id: input.tracking_id,
    issued_at: input.issued_at,
    expires_at: new Date(issuedAt + leaseDuration).toISOString(),
    lease_duration_ms: leaseDuration,
    renewal_count: 0,
    max_renewals: input.max_renewals,
    effect_policy: structuredClone(input.effect_policy),
    ...(input.external_idempotency_key
      ? { external_idempotency_key: input.external_idempotency_key }
      : {}),
    status: 'live',
  };
  const next = cloneWithClaims(state, { ...state.claims, [claim.lease_id]: claim });
  return { state: parseGraphState(next), claim: structuredClone(claim) };
}

export function renewGraphClaim(stateInput: GraphState, input: RenewGraphClaimInput): GraphClaimResult {
  const state = parseGraphState(stateInput);
  const claim = ensureLiveClaim(state, input.lease_id);
  if (claim.claim_owner_session_id !== input.claim_owner_session_id
    || claim.driver_instance_id !== input.driver_instance_id) {
    throw new GraphClaimError('lease_owner_mismatch', 'Claim owner/driver does not match the live lease');
  }
  if (claim.tracking_id !== input.tracking_id || !input.tool_still_running) {
    throw new GraphClaimError('tracking_mismatch', 'Renewal requires the matching live tool tracking identity');
  }
  const now = timestamp(input.now, 'now');
  if (now >= timestamp(claim.expires_at, 'claim.expires_at')) {
    throw new GraphClaimError('lease_expired', 'Expired claims cannot be renewed');
  }
  if (claim.renewal_count >= claim.max_renewals) {
    throw new GraphClaimError('renewal_cap', 'Claim renewal cap has been reached');
  }
  const renewed: GraphClaim = {
    ...claim,
    last_renewed_at: input.now,
    expires_at: new Date(now + claim.lease_duration_ms).toISOString(),
    renewal_count: claim.renewal_count + 1,
  };
  const next = cloneWithClaims(state, { ...state.claims, [claim.lease_id]: renewed });
  return { state: parseGraphState(next), claim: structuredClone(renewed) };
}

function reconciliationFor(
  claim: GraphClaim,
  input: RecoverExpiredGraphClaimInput,
  reason: GraphReconciliationRecord['reason'],
): GraphReconciliationRecord {
  return {
    reconciliation_id: input.reconciliation_id,
    activation_id: claim.activation_id,
    attempt_id: claim.attempt_id,
    lease_id: claim.lease_id,
    revision_id: claim.revision_id,
    revision_hash: claim.revision_hash,
    dispatch_generation: claim.dispatch_generation,
    status: 'unresolved',
    reason,
    created_at: input.now,
  };
}

export function recoverExpiredGraphClaim(
  stateInput: GraphState,
  input: RecoverExpiredGraphClaimInput,
  replaceAttempt: ReplaceAttemptProjection,
): GraphClaimRecoveryResult {
  const state = parseGraphState(stateInput);
  const claim = ensureLiveClaim(state, input.lease_id);
  const now = timestamp(input.now, 'now');
  if (now < timestamp(claim.expires_at, 'claim.expires_at')) {
    throw new GraphClaimError('lease_live', 'Live claim cannot be taken over before expiry');
  }
  if (claim.effect_policy.policy === 'reconcile') {
    if (state.reconciliations[input.reconciliation_id]) {
      throw new GraphClaimError('duplicate_reconciliation', 'Reconciliation identity already exists');
    }
    if (Object.keys(state.reconciliations).length >= GRAPH_MAX_RECONCILIATIONS) {
      throw new GraphClaimError('reconciliation_limit', 'Reconciliation limit has been reached');
    }
    const reconciliation = reconciliationFor(claim, input, 'expired_ambiguous');
    const fenced: GraphClaim = { ...claim, status: 'reconciling', fenced_at: input.now };
    const next: GraphState = {
      ...structuredClone(state),
      status: 'reconciling',
      claims: { ...state.claims, [claim.lease_id]: fenced },
      reconciliations: { ...state.reconciliations, [reconciliation.reconciliation_id]: reconciliation },
    };
    return { state: parseGraphState(next), disposition: 'reconciling', reconciliation };
  }
  if (claim.effect_policy.policy === 'idempotent' && !claim.external_idempotency_key) {
    throw new GraphClaimError('missing_idempotency_key', 'Idempotent takeover requires the durable external key');
  }
  if (input.claimant_session_id !== state.session_id) {
    throw new GraphClaimError('claim_session_mismatch', 'Takeover claimant must match the Graph authority session');
  }
  const activation = state.projection.activations[claim.activation_id];
  const node = activeDescriptor(state).nodes.find((candidate) => candidate.id === activation?.node_id);
  if (!activation || !node || (node.kind !== 'agent' && node.kind !== 'command')) {
    throw new GraphClaimError('attempt_fence_mismatch', 'Expired claim no longer maps to an approved executable activation');
  }
  if (claim.attempt_no >= node.max_attempts) {
    throw new GraphClaimError('attempt_limit', `Approved node ${node.id} has reached its maximum attempts`);
  }
  for (const id of [input.new_attempt_id, input.new_lease_id, input.new_tracking_id]) {
    assertIdentifier(id, 'replacement identity');
  }
  if (state.claims[input.new_lease_id]) throw new GraphClaimError('duplicate_lease', 'Replacement lease already exists');
  if (input.new_attempt_id === claim.attempt_id || input.new_lease_id === claim.lease_id) {
    throw new GraphClaimError('replacement_identity_reused', 'Takeover requires a new attempt and lease identity');
  }
  const replacement: GraphClaim = {
    ...claim,
    attempt_id: input.new_attempt_id,
    attempt_no: claim.attempt_no + 1,
    claim_owner_session_id: input.claimant_session_id,
    driver_instance_id: input.driver_instance_id,
    lease_id: input.new_lease_id,
    tracking_id: input.new_tracking_id,
    issued_at: input.now,
    expires_at: new Date(now + claim.lease_duration_ms).toISOString(),
    renewal_count: 0,
    status: 'live',
  };
  delete replacement.last_renewed_at;
  delete replacement.fenced_at;
  delete replacement.replacement_lease_id;
  const fenced: GraphClaim = {
    ...claim,
    status: 'expired_retryable',
    fenced_at: input.now,
    replacement_lease_id: replacement.lease_id,
  };
  const projection = replaceAttempt(state.projection, {
    activation_id: claim.activation_id,
    attempt_id: replacement.attempt_id,
    attempt_no: replacement.attempt_no,
  });
  const next: GraphState = {
    ...structuredClone(state),
    projection,
    claims: {
      ...state.claims,
      [fenced.lease_id]: fenced,
      [replacement.lease_id]: replacement,
    },
  };
  return { state: parseGraphState(next), disposition: 'taken_over', claim: replacement };
}

export interface LateClaimResultInput {
  lease_id: string;
  attempt_id: string;
  recorded_at: string;
  summary: string;
}

export function recordLateClaimResult(
  stateInput: GraphState,
  input: LateClaimResultInput,
): { state: GraphState; diagnostic: GraphDiagnostic } {
  const state = parseGraphState(stateInput);
  const claim = findClaim(state, input.lease_id);
  if (claim.attempt_id !== input.attempt_id) {
    throw new GraphClaimError('attempt_fence_mismatch', 'Late result attempt does not match the fenced lease');
  }
  if (claim.status === 'live') {
    throw new GraphClaimError('claim_live', 'A live claim result is not a late diagnostic');
  }
  timestamp(input.recorded_at, 'recorded_at');
  if (input.summary.length === 0 || input.summary.length > 8_192) {
    throw new GraphClaimError('diagnostic_too_large', 'Late-result summary must be non-empty and bounded');
  }
  const diagnostic: GraphDiagnostic = {
    kind: 'late_result',
    recorded_at: input.recorded_at,
    summary: input.summary,
    activation_id: claim.activation_id,
    attempt_id: claim.attempt_id,
    lease_id: claim.lease_id,
  };
  const diagnostics = [...state.diagnostics, diagnostic].slice(-GRAPH_MAX_DIAGNOSTICS);
  return { state: parseGraphState({ ...state, diagnostics }), diagnostic };
}

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

export function settleDriverClaims(
  stateInput: GraphState,
  input: SettleDriverClaimsInput,
): { state: GraphState; settled_lease_ids: string[] } {
  const state = parseGraphState(stateInput);
  timestamp(input.recorded_at, 'recorded_at');
  const scope = input.scope ?? 'driver';
  const claims = structuredClone(state.claims);
  const reconciliations = structuredClone(state.reconciliations);
  // #3: settle must atomically return each affected activation to a re-claimable
  // state, otherwise a settled (abandoned_retryable) claim's activation stays
  // 'running' with a dead attempt forever - recoverExpiredGraphClaim needs a LIVE
  // claim so the work would be permanently lost after SessionEnd. Resetting the
  // activation to 'ready' (dropping the active attempt, preserving attempt history)
  // lets the scheduler re-claim it and redo the work. Reconcile-policy claims go
  // to 'reconciling' (human resolution required) and are NOT auto-reset.
  const activations = structuredClone(state.projection.activations);
  const settled: string[] = [];
  let hasAmbiguous = false;
  for (const claim of Object.values(claims)) {
    if (claim.status !== 'live'
      || claim.claim_owner_session_id !== input.claim_owner_session_id) continue;
    // In 'driver' scope only fence claims owned by the passed driver. In
    // 'session' scope fence every live claim in the session.
    if (scope === 'driver' && claim.driver_instance_id !== input.driver_instance_id) continue;
    settled.push(claim.lease_id);
    claim.fenced_at = input.recorded_at;
    if (claim.effect_policy.policy !== 'reconcile') {
      claim.status = 'abandoned_retryable';
      // Reset the bound activation to 'ready' so it can be re-claimed. Only reset
      // when the activation is still running on this claim's attempt; a completed
      // or already-reset activation must not be touched.
      const activation = activations[claim.activation_id];
      if (activation
        && activation.status === 'running'
        && activation.active_attempt_id === claim.attempt_id) {
        const released = { ...activation, status: 'ready' as const };
        delete released.active_attempt_id;
        activations[claim.activation_id] = released;
      }
      continue;
    }
    hasAmbiguous = true;
    claim.status = 'reconciling';
    const reconciliationId = `session-end:${claim.lease_id}`;
    if (!reconciliations[reconciliationId]) {
      reconciliations[reconciliationId] = {
        reconciliation_id: reconciliationId,
        activation_id: claim.activation_id,
        attempt_id: claim.attempt_id,
        lease_id: claim.lease_id,
        revision_id: claim.revision_id,
        revision_hash: claim.revision_hash,
        dispatch_generation: claim.dispatch_generation,
        status: 'unresolved',
        reason: 'session_end_ambiguous',
        created_at: input.recorded_at,
      };
    }
  }
  if (Object.keys(reconciliations).length > GRAPH_MAX_RECONCILIATIONS) {
    throw new GraphClaimError('reconciliation_limit', 'SessionEnd would exceed the reconciliation bound');
  }
  const next: GraphState = {
    ...structuredClone(state),
    ...(hasAmbiguous ? { status: 'reconciling' as const } : {}),
    claims,
    reconciliations,
    projection: { ...state.projection, activations },
  };
  return { state: parseGraphState(next), settled_lease_ids: settled };
}

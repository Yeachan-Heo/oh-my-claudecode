import { randomUUID } from 'node:crypto';

import { canonicalJson, parseGraphDescriptor, sealGraphDescriptor } from './descriptor.js';
import {
  issueGraphClaim,
  recoverExpiredGraphClaim,
  recordLateClaimResult,
  renewGraphClaim,
  settleDriverClaims,
} from './claims.js';
import { approveGraphPatch, approvePendingGraphRevision, proposeGraphPatch } from './revisions.js';
import {
  applyNodeResult,
  beginActivationAttempt,
  initializeGraphProjection,
  isGraphSucceeded,
  listReadyExecutableActivations,
  listReadyJoinActivations,
  releaseAttemptForRetry,
  resolveJoin,
} from './scheduler.js';
import { ControlOwnerStore } from './control-owner.js';
import { createInitialGraphState, type GraphClaim, type GraphState, type JsonValue } from './runtime-types.js';
import { GraphStateStore } from './store.js';
import type {
  GraphEvidenceReference,
  GraphSchedulerProjection,
  SealedGraphDescriptor,
} from './types.js';

type GraphCommandOperation =
  | 'create' | 'inspect' | 'approve' | 'ready' | 'claim' | 'complete' | 'fail'
  | 'propose-patch' | 'approve-patch' | 'status' | 'pause' | 'abandon' | 'resume'
  | 'settle-session'
  | 'resolve-join'
  | 'renew-claim' | 'recover-expired-claim' | 'record-late-claim-result'
  | 'release-attempt-for-retry'
  | 'resolve-reconciliation';

interface GraphCommandRequest {
  operation: GraphCommandOperation;
  cwd: string;
  input: Readonly<Record<string, unknown>>;
}

interface GraphCommandService {
  execute(request: GraphCommandRequest): Promise<unknown>;
}

const DRIVER_LEASE_DURATION_MS = 60 * 60 * 1000;
// Human-approval waits are durable (no busy-poll). The claim lease is a bounded
// placeholder so the waiting claim survives state validation; renewals are not
// used because the wait is event-driven via the in-session question surface.
const HUMAN_APPROVAL_LEASE_MS = 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireObject<T = Record<string, unknown>>(value: unknown, field: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value as T;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function requireEvidence(value: unknown, field: string): GraphEvidenceReference {
  const evidence = requireObject(value, field);
  const kind = requireString(evidence.kind, `${field}.kind`);
  if (!['file', 'command', 'test', 'human', 'url'].includes(kind)) {
    throw new Error(`${field}.kind is invalid`);
  }
  requireString(evidence.ref, `${field}.ref`);
  return evidence as unknown as GraphEvidenceReference;
}

function buildFence(state: GraphState) {
  return {
    session_id: state.session_id,
    run_id: state.run_id,
    revision_id: state.active_revision_id,
    revision_hash: state.active_revision_hash,
    dispatch_generation: state.dispatch_generation,
    commit_sequence: state.commit_sequence,
  };
}

// #4: active-scope operations (claim/complete/fail/renew/recover/etc.) must
// fence against the CURRENT dispatch_generation, not a hardcoded 0. After the
// first patch approval the active generation is non-zero, so a hardcoded-0
// fence would spuriously reject (or, on stale claims, mis-fence) legitimate
// results and recovery. Patch operations keep their pending_patch_base scope.
//
// CAUTION: dispatch_generation here is sourced from a live readActiveState()
// snapshot taken BEFORE store.mutate, so it is a consistency snapshot, NOT a
// race-detecting fence - a generation advance between the read and the mutate
// is not caught by this field. The real optimistic-concurrency fence is the
// caller-asserted commit_sequence (via --expected-sequence) plus revision_id,
// which store.mutate checks atomically under its lock. A follow-up could make
// dispatch_generation caller-asserted (--expected-dispatch-generation) to close
// the read-then-mutate gap; it is not exploitable today because commit_sequence
// and revision_id already bound concurrent advancement.
function buildActiveFence(
  state: GraphState,
  expected: {
    session_id: string;
    run_id: string;
    revision_id: string;
    revision_hash: string;
    commit_sequence: number;
  },
) {
  return {
    session_id: expected.session_id,
    run_id: expected.run_id,
    revision_id: expected.revision_id,
    revision_hash: expected.revision_hash,
    dispatch_generation: state.dispatch_generation,
    commit_sequence: expected.commit_sequence,
  };
}

function readActiveState(sessionId: string, runId: string): GraphState {
  const store = new GraphStateStore({ sessionId });
  const state = store.read();
  if (!state || state.run_id !== runId) {
    throw new Error(`graph run ${runId} not found for session ${sessionId}`);
  }
  return state;
}

function operationFingerprint(operation: string, input: Readonly<Record<string, unknown>>): string {
  return canonicalJson({ operation, input });
}

function entryActivationIdsFor(descriptor: SealedGraphDescriptor): Record<string, string> {
  const result: Record<string, string> = {};
  for (const nodeId of descriptor.entry_node_ids) {
    result[nodeId] = `${descriptor.run_id}:act:${nodeId}:entry`;
  }
  return result;
}

function driverLease(driverInstanceId: string, issuedAt: string) {
  return {
    driver_instance_id: driverInstanceId,
    lease_id: randomUUID(),
    expires_at: new Date(Date.parse(issuedAt) + DRIVER_LEASE_DURATION_MS).toISOString(),
  };
}

function summarizeState(state: GraphState) {
  return {
    run_id: state.run_id,
    session_id: state.session_id,
    status: state.status,
    active_revision_id: state.active_revision_id,
    active_revision_hash: state.active_revision_hash,
    dispatch_generation: state.dispatch_generation,
    commit_sequence: state.commit_sequence,
    control_nonce: state.control_nonce,
    transition_count: state.transitions.length,
    claim_count: Object.keys(state.claims).length,
    live_claim_count: Object.values(state.claims).filter((claim) => claim.status === 'live').length,
    unresolved_reconciliation_count: Object.values(state.reconciliations).filter((record) => record.status === 'unresolved').length,
    diagnostic_count: state.diagnostics.length,
    succeeded: isGraphSucceeded(state.revisions[state.active_revision_id].descriptor, state.projection),
    pending_approval: state.pending_approval ?? null,
    pending_patch: state.pending_patch ? {
      proposal_id: state.pending_patch.proposal_id,
      base_revision_id: state.pending_patch.base_revision_id,
      proposed_revision_id: state.pending_patch.proposed_revision_id,
      invalidated_node_ids: state.pending_patch.invalidated_node_ids,
    } : null,
  };
}

function readinessView(state: GraphState) {
  const descriptor = state.revisions[state.active_revision_id].descriptor;
  const executable = listReadyExecutableActivations(descriptor, state.projection).map((activation) => ({
    activation_id: activation.activation_id,
    node_id: activation.node_id,
    attempt_no: activation.attempt_no,
  }));
  const joins = listReadyJoinActivations(descriptor, state.projection).map((activation) => ({
    activation_id: activation.activation_id,
    node_id: activation.node_id,
    cohort_id: activation.cohort_id,
  }));
  const liveClaims = Object.values(state.claims)
    .filter((claim) => claim.status === 'live')
    .map((claim) => ({
      lease_id: claim.lease_id,
      activation_id: claim.activation_id,
      attempt_id: claim.attempt_id,
      expires_at: claim.expires_at,
    }));
  return {
    executable,
    joins,
    live_claims: liveClaims,
    available_slots: Math.max(0, descriptor.concurrency_limit - liveClaims.length),
  };
}

function assertExactGraphControlRoot(
  controlStore: ControlOwnerStore,
  state: GraphState,
  expectedPhase: 'reserved' | 'active',
): void {
  const root = controlStore.read()?.root;
  if (!root
    || root.mode !== 'graph'
    || root.run_id !== state.run_id
    || root.nonce !== state.control_nonce
    || root.phase !== expectedPhase
    || !root.graph_revision
    || root.graph_revision.revision_id !== state.active_revision_id
    || root.graph_revision.revision_hash !== state.active_revision_hash) {
    throw new Error(`control_root_mismatch: graph ${state.run_id} does not have its exact ${expectedPhase} control reservation`);
  }
}

function requiredControlPhase(status: GraphState['status']): 'reserved' | 'active' | null {
  if (status === 'awaiting_approval') return 'reserved';
  if (['running', 'waiting_human', 'waiting_patch_approval', 'reconciling'].includes(status)) return 'active';
  return null;
}

async function executeCreate(input: Readonly<Record<string, unknown>>): Promise<unknown> {
  const goal = requireString(input.goal, 'goal');
  const descriptorInput = requireObject(input.descriptor, 'descriptor');
  const sessionId = requireString(input.session_id, 'session_id');
  const driverId = requireString(input.driver_id, 'driver_id');
  const transitionId = requireString(input.transition_id, 'transition_id');

  const parsed = parseGraphDescriptor(descriptorInput);
  const sealed = sealGraphDescriptor(parsed);
  if (sealed.goal !== goal) {
    throw new Error('descriptor goal does not match --goal');
  }

  const store = new GraphStateStore({ sessionId });
  const existing = store.read();
  if (existing) {
    if (existing.run_id !== sealed.run_id) {
      throw new Error(`graph state already exists for session ${sessionId} with a different run_id`);
    }
    // Idempotent retry: only return the existing graph when the exact descriptor
    // hash matches. Retrying create with a modified descriptor must NOT silently
    // return the old graph.
    if (existing.active_revision_hash !== sealed.descriptor_hash) {
      throw new Error(
        `hash_mismatch: graph state already exists for run ${sealed.run_id} with descriptor hash ${existing.active_revision_hash}, cannot replace with ${sealed.descriptor_hash}`,
      );
    }
    const expectedPhase = requiredControlPhase(existing.status);
    if (expectedPhase) {
      assertExactGraphControlRoot(new ControlOwnerStore({ sessionId }), existing, expectedPhase);
    }
    return summarizeState(existing);
  }

  const initialProjection: GraphSchedulerProjection = {
    activations: {},
    cohorts: {},
    branch_tokens: {},
    traversal_counts: {},
    committed_transitions: {},
    terminal_verification_activation_ids: [],
  };

  const createdAt = now();

  // Control authority is the creation gate. Reserve it BEFORE writing durable
  // graph state so a conflicting root cannot leave an orphan graph behind.
  // A crash after reservation but before publish can be retried only for the
  // exact same graph revision; it reuses the original nonce rather than
  // replacing or releasing another owner's reservation.
  const controlStore = new ControlOwnerStore({ sessionId });
  const existingRoot = controlStore.read()?.root;
  let controlNonce: string;
  let createdReservation = false;
  if (!existingRoot) {
    controlNonce = randomUUID();
    controlStore.reserveRoot({
      mode: 'graph',
      run_id: sealed.run_id,
      nonce: controlNonce,
      reserved_at: createdAt,
      graph_revision: { revision_id: sealed.revision_id, revision_hash: sealed.descriptor_hash },
    });
    createdReservation = true;
  } else if (existingRoot.mode === 'graph'
    && existingRoot.run_id === sealed.run_id
    && existingRoot.phase === 'reserved'
    && existingRoot.graph_revision?.revision_id === sealed.revision_id
    && existingRoot.graph_revision.revision_hash === sealed.descriptor_hash) {
    controlNonce = existingRoot.nonce;
  } else {
    throw new Error(`root_conflict: session is already controlled by ${existingRoot.mode}/${existingRoot.run_id}`);
  }

  const initialState = createInitialGraphState({
    session_id: sessionId,
    control_nonce: controlNonce,
    descriptor: sealed,
    projection: initialProjection,
    status: 'awaiting_approval',
    created_at: createdAt,
  });

  let created: GraphState;
  try {
    created = store.create(initialState);
  } catch (error) {
    // Another exact retry can publish after our initial read but before this
    // OCC create. Treat only the fully matching durable graph/control pair as
    // the idempotent winner; every other create failure still compensates.
    if ((error as { code?: unknown }).code === 'already_exists') {
      const published = store.read();
      if (published
        && published.run_id === sealed.run_id
        && published.active_revision_hash === sealed.descriptor_hash) {
        const expectedPhase = requiredControlPhase(published.status);
        if (expectedPhase) {
          assertExactGraphControlRoot(controlStore, published, expectedPhase);
        }
        return summarizeState(published);
      }
    }
    // Compensate only a reservation made by this invocation and only with its
    // exact nonce. Reused crash-recovery reservations are never released by a
    // failed retry, so a caller cannot erase unrelated control authority.
    if (createdReservation) {
      try {
        const rollback = controlStore.releaseRoot({
          mode: 'graph',
          run_id: sealed.run_id,
          nonce: controlNonce,
          disposition: { graph_status: 'cancelled', claims_fenced: true, children_drained: true },
          released_at: now(),
        });
        if (!rollback.released) {
          throw new Error('exact reservation was no longer releasable');
        }
      } catch (rollbackError) {
        throw new Error(`create_rollback_failed: ${String(rollbackError)}; initial graph publish failed: ${String(error)}`);
      }
    }
    throw error;
  }

  return {
    run_id: created.run_id,
    revision_id: created.active_revision_id,
    descriptor_hash: created.active_revision_hash,
    status: created.status,
    control_nonce: created.control_nonce,
    created_at: created.created_at,
    transition_id: transitionId,
    driver_id: driverId,
  };
}

function executeInspect(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const store = new GraphStateStore({ sessionId });
  const state = store.read();
  if (!state || state.run_id !== runId) {
    throw new Error(`graph run ${runId} not found for session ${sessionId}`);
  }
  const descriptor = state.revisions[state.active_revision_id].descriptor;
  return {
    summary: summarizeState(state),
    descriptor: {
      run_id: descriptor.run_id,
      revision_id: descriptor.revision_id,
      goal: descriptor.goal,
      descriptor_hash: descriptor.descriptor_hash,
      entry_node_ids: descriptor.entry_node_ids,
      terminal_verification_node_id: descriptor.terminal_verification_node_id,
      concurrency_limit: descriptor.concurrency_limit,
      node_count: descriptor.nodes.length,
      edge_count: descriptor.edges.length,
    },
    readiness: readinessView(state),
  };
}

function executeStatus(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const store = new GraphStateStore({ sessionId });
  const state = store.read();
  if (!state || state.run_id !== runId) {
    throw new Error(`graph run ${runId} not found for session ${sessionId}`);
  }
  return { summary: summarizeState(state), readiness: readinessView(state) };
}

function executeReady(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const store = new GraphStateStore({ sessionId });
  const state = store.read();
  if (!state || state.run_id !== runId) {
    throw new Error(`graph run ${runId} not found for session ${sessionId}`);
  }
  if (state.active_revision_id !== revisionId || state.active_revision_hash !== descriptorHash) {
    throw new Error('revision/hash fence does not match active revision');
  }
  if (state.commit_sequence !== expectedSequence) {
    throw new Error(`expected sequence ${expectedSequence}, found ${state.commit_sequence}`);
  }
  return readinessView(state);
}

function executeApprove(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const approvalInput = requireObject(input.approval, 'approval');
  const approvedAt = requireString(approvalInput.approved_at ?? approvalInput.approvedAt, 'approval.approved_at');
  const evidence = requireEvidence(approvalInput.evidence ?? approvalInput.approval_evidence, 'approval.evidence');
  const driverId = requireString(approvalInput.driver_id ?? approvalInput.driverId, 'approval.driver_id');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'approve',
    operation_fingerprint: operationFingerprint('approve', { revisionId, descriptorHash, driverId, approvedAt, evidence: evidence.ref }),
    // #4: source dispatch_generation from state. Initial approval is always on
    // generation 0, but sourcing from state keeps the active-scope fence truthful
    // and consistent with the other active-scope operations.
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: 0,
    }),
  }, (current) => {
    if (current.status !== 'awaiting_approval') {
      throw new Error(`cannot approve graph in status ${current.status}`);
    }
    const next = approvePendingGraphRevision(current, {
      revision_id: revisionId,
      revision_hash: descriptorHash,
      approved_at: approvedAt,
      approval_evidence: evidence,
    }, (descriptor) => initializeGraphProjection(descriptor, entryActivationIdsFor(descriptor)));
    return { next, result: { approved: true, revision_id: revisionId } };
  });

  const controlStore = new ControlOwnerStore({ sessionId });
  // NOTE (finding #5): mutate-then-control ordering is intentionally retained here. Unlike
  // executeResume, the control op is promoteRoot (the root was reserved during executeCreate),
  // so if mutate throws, promote never runs and there is NO divergence. If mutate succeeds and
  // promote throws, the graph is 'running' with a still-reserved root (phase='reserved'), which
  // is recoverable via recoverGraphReservation. Reordering to control-first would trade this
  // recoverable divergence for an active-root-over-awaiting_approval state whose cleanup would
  // release a root that executeCreate reserved (a different, non-minimal compensation), so the
  // reorder is not clearly safer here.
  if (!result.replayed) {
    controlStore.promoteRoot({
      mode: 'graph',
      run_id: runId,
      nonce: result.state.control_nonce,
      promoted_at: approvedAt,
      driver_lease: driverLease(driverId, approvedAt),
    });
  }

  return { result: result.result, replayed: result.replayed, summary: summarizeState(result.state) };
}

function executeClaim(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const driverId = requireString(input.driver_id, 'driver_id');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const limit = requireInteger(input.limit, 'limit');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'claim',
    operation_fingerprint: operationFingerprint('claim', { revisionId, descriptorHash, expectedSequence, driverId, limit }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    if (current.status !== 'running') {
      throw new Error(`cannot claim while graph status is ${current.status}`);
    }
    const descriptor = current.revisions[current.active_revision_id].descriptor;
    const liveCount = Object.values(current.claims).filter((claim) => claim.status === 'live').length;
    const available = Math.min(limit, Math.max(0, descriptor.concurrency_limit - liveCount));
    if (available === 0) {
      return { next: current, result: { claims: [], available_slots: 0 } };
    }
    const ready = listReadyExecutableActivations(descriptor, current.projection).slice(0, available);
    const issuedAt = now();
    const issued: JsonValue[] = [];
    let working = current;
    for (const activation of ready) {
      const attemptId = randomUUID();
      const leaseId = randomUUID();
      const trackingId = randomUUID();
      // Resolve the node BEFORE beginning the attempt so the begin can gate
      // on node.max_attempts for agent/command nodes (ordinary retries must not
      // bypass the per-node bound). Human-approval/join nodes carry no bound.
      const node = descriptor.nodes.find((candidate) => candidate.id === activation.node_id);
      if (!node) {
        throw new Error(`activation ${activation.activation_id} has no matching node`);
      }
      const projection = beginActivationAttempt(working.projection, {
        activation_id: activation.activation_id,
        attempt_id: attemptId,
        ...(node.kind === 'agent' || node.kind === 'command' ? { max_attempts: node.max_attempts } : {}),
      });
      if (node.kind === 'human-approval') {
        // B6: human-approval nodes are executable via the in-session question surface.
        // Issue a durable claim that fences the activation while we wait for the human
        // answer, then transition the run to 'waiting_human' so the driver yields. The
        // subsequent `complete` operation records the human's answer as the node result
        // and fences this claim like any other. We bypass issueGraphClaim because
        // human-approval nodes carry no effect_policy/timeout_ms; we build the claim
        // directly using a bounded, authority-scoped lease.
        const attemptId = randomUUID();
        const leaseId = randomUUID();
        const trackingId = randomUUID();
        const projection = beginActivationAttempt(working.projection, {
          activation_id: activation.activation_id,
          attempt_id: attemptId,
        });
        const issuedAt = now();
        const humanClaim: GraphClaim = {
          run_id: working.run_id,
          revision_id: working.active_revision_id,
          revision_hash: working.active_revision_hash,
          dispatch_generation: working.dispatch_generation,
          activation_id: activation.activation_id,
          attempt_id: attemptId,
          attempt_no: activation.attempt_no + 1,
          claim_owner_session_id: sessionId,
          driver_instance_id: driverId,
          lease_id: leaseId,
          tracking_id: trackingId,
          issued_at: issuedAt,
          expires_at: new Date(Date.parse(issuedAt) + HUMAN_APPROVAL_LEASE_MS).toISOString(),
          lease_duration_ms: HUMAN_APPROVAL_LEASE_MS,
          renewal_count: 0,
          max_renewals: 0,
          effect_policy: { policy: 'side_effect_free' },
          status: 'live' as const,
        };
        const intermediate: GraphState = {
          ...working,
          projection,
          claims: { ...working.claims, [leaseId]: humanClaim },
          status: 'waiting_human' as const,
        };
        working = intermediate;
        issued.push({
          lease_id: leaseId,
          activation_id: activation.activation_id,
          attempt_id: attemptId,
          attempt_no: activation.attempt_no + 1,
          tracking_id: trackingId,
          // #5: return the persisted claim's lease expiry, not the issue timestamp.
          // A driver treats expires_at as the lease deadline; returning issued_at made
          // a valid human-approval claim look already expired.
          expires_at: humanClaim.expires_at,
          node_id: activation.node_id,
          kind: 'human-approval',
          waiting_human: true,
        });
        continue;
      }
      if (node.kind !== 'agent' && node.kind !== 'command') {
        throw new Error(`activation ${activation.activation_id} is not on an executable node`);
      }
      const intermediate: GraphState = { ...working, projection };
      const claimResult = issueGraphClaim(intermediate, {
        activation_id: activation.activation_id,
        attempt_id: attemptId,
        attempt_no: activation.attempt_no + 1,
        claim_owner_session_id: sessionId,
        driver_instance_id: driverId,
        lease_id: leaseId,
        tracking_id: trackingId,
        issued_at: issuedAt,
        execution_timeout_ms: node.timeout_ms,
        grace_ms: 5 * 60 * 1000,
        max_renewals: 3,
        effect_policy: node.effect_policy,
        ...(node.effect_policy.policy === 'idempotent'
          ? { external_idempotency_key: `${node.effect_policy.idempotency_key_template}-${attemptId}` }
          : {}),
      });
      working = claimResult.state;
      issued.push({
        lease_id: claimResult.claim.lease_id,
        activation_id: claimResult.claim.activation_id,
        attempt_id: claimResult.claim.attempt_id,
        attempt_no: claimResult.claim.attempt_no,
        tracking_id: claimResult.claim.tracking_id,
        expires_at: claimResult.claim.expires_at,
        node_id: activation.node_id,
      });
    }
    return { next: working, result: { claims: issued, available_slots: descriptor.concurrency_limit - liveCount - issued.length } };
  });

  return { result: result.result, replayed: result.replayed };
}

function applyResultOperation(
  operation: 'complete' | 'fail',
  input: Readonly<Record<string, unknown>>,
): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const claimInput = requireObject(input.claim, 'claim');
  const resultInput = requireObject(input.result, 'result');

  const leaseId = requireString(claimInput.lease_id, 'claim.lease_id');
  const activationId = requireString(claimInput.activation_id, 'claim.activation_id');
  const attemptId = requireString(claimInput.attempt_id, 'claim.attempt_id');
  const outcome = requireString(resultInput.outcome, 'result.outcome');
  const route = typeof resultInput.route === 'string' ? resultInput.route : undefined;
  const outputSummary = typeof resultInput.output_summary === 'string' ? resultInput.output_summary : undefined;
  const evidenceRefsRaw = Array.isArray(resultInput.evidence_refs) ? resultInput.evidence_refs : [];
  const evidenceRefs = evidenceRefsRaw.map((value, index) => requireEvidence(value, `result.evidence_refs[${index}]`));
  const externalIdempotencyKey = typeof resultInput.external_idempotency_key === 'string'
    ? resultInput.external_idempotency_key
    : undefined;
  // Optional scheduler identities for edges the runtime does not auto-generate.
  // Currently only join_activation_id is caller-supplied (used when completing a
  // branch whose arrival fills the cohort and activates the join).
  const identitiesInput = input.identities && typeof input.identities === 'object' && !Array.isArray(input.identities)
    ? input.identities as Record<string, unknown>
    : {};
  const joinActivationId = typeof identitiesInput.join_activation_id === 'string'
    ? identitiesInput.join_activation_id
    : undefined;

  if (operation === 'complete' && outcome !== 'succeeded') {
    throw new Error('complete requires outcome=succeeded; use fail for failed results');
  }
  if (operation === 'fail' && outcome !== 'failed') {
    throw new Error('fail requires outcome=failed; use complete for succeeded results');
  }

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation,
    operation_fingerprint: operationFingerprint(operation, { leaseId, activationId, attemptId, outcome, route, outputSummary, evidenceRefs }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    // #2: reject late results against a terminal graph BEFORE committing. A worker
    // can finish after abandon/cancel (or after the run reached succeeded/failed);
    // accepting its result would mutate the terminal run / create follow-on
    // activations. The claim-fence check below only validates the claim is live,
    // not that the graph is still accepting results, so this gate must come first.
    if (current.status !== 'running' && current.status !== 'waiting_human') {
      throw new Error(`cannot ${operation} a result while graph status is ${current.status}`);
    }
    const claim = current.claims[leaseId];
    if (!claim) throw new Error(`claim ${leaseId} not found`);
    if (claim.status !== 'live') throw new Error(`claim ${leaseId} is not live (status=${claim.status})`);
    if (claim.activation_id !== activationId || claim.attempt_id !== attemptId) {
      throw new Error('claim fence does not match provided activation/attempt');
    }
    const descriptor = current.revisions[current.active_revision_id].descriptor;
    const activationNodeId = current.projection.activations[activationId]?.node_id;
    const edgesForNode = descriptor.edges.filter((edge) => edge.from === activationNodeId);
    const nextActivationIds: Record<string, string> = {};
    const branchTokenIds: Record<string, string> = {};
    let cohortId: string | undefined;
    const hasFanOut = edgesForNode.some((edge) => edge.kind === 'fan_out');
    if (hasFanOut) {
      cohortId = randomUUID();
    }
    for (const edge of edgesForNode) {
      nextActivationIds[edge.id] = `${descriptor.run_id}:act:${edge.to}:${randomUUID()}`;
      if (edge.kind === 'fan_out') {
        branchTokenIds[edge.id] = `${descriptor.run_id}:token:${edge.branch_id}:${randomUUID()}`;
      }
    }
    const schedulerResult = applyNodeResult(descriptor, current.projection, {
      transition_id: transitionId,
      activation_id: activationId,
      identities: {
        next_activation_ids: nextActivationIds,
        ...(cohortId ? { cohort_id: cohortId } : {}),
        ...(hasFanOut ? { branch_token_ids: branchTokenIds } : {}),
        ...(joinActivationId ? { join_activation_id: joinActivationId } : {}),
      },
      result: {
        attempt_id: attemptId,
        outcome: outcome as 'succeeded' | 'failed',
        evidence_refs: evidenceRefs,
        ...(route ? { route } : {}),
        ...(outputSummary ? { output_summary: outputSummary } : {}),
        ...(externalIdempotencyKey ? { external_idempotency_key: externalIdempotencyKey } : {}),
      },
    });
    const next: GraphState = {
      ...current,
      projection: schedulerResult.projection,
      // B6: completing a claim while the run is waiting for a human answer ends
      // the durable wait (the human answered), so return to 'running' and let the
      // driver claim the next ready activation. Without this the run would wedge
      // in 'waiting_human' after the human-approval node completes.
      // A3: if the completed result failed AND the activation has exhausted its
      // retry budget (terminal 'failed'), promote the graph to 'failed'. This
      // takes precedence over the waiting_human->running transition so a failed
      // exhausted node does not leave an un-claimable, un-retryable activation
      // wedging the run forever.
      ...(schedulerResult.transition.outcome === 'failed'
        && schedulerResult.projection.activations[activationId]?.status === 'failed'
        ? { status: 'failed' as const }
        : current.status === 'waiting_human' ? { status: 'running' as const } : {}),
      claims: {
        ...current.claims,
        [leaseId]: {
          ...claim,
          status: 'completed' as const,
          fenced_at: now(),
        },
      },
    };
    return {
      next,
      result: {
        transition_id: transitionId,
        activation_id: activationId,
        node_id: schedulerResult.transition.node_id,
        outcome: schedulerResult.transition.outcome,
        selected_edge_ids: schedulerResult.transition.selected_edge_ids,
        created_activation_ids: schedulerResult.transition.created_activation_ids,
        succeeded: isGraphSucceeded(descriptor, schedulerResult.projection),
      },
    };
  });

  return { result: result.result, replayed: result.replayed };
}

function executePause(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const driverId = requireString(input.driver_id, 'driver_id');
  const transitionId = requireString(input.transition_id, 'transition_id');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'pause',
    operation_fingerprint: operationFingerprint('pause', { runId, revisionId, descriptorHash, driverId }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    if (current.status !== 'running' && current.status !== 'waiting_human') {
      throw new Error(`cannot pause graph in status ${current.status}`);
    }
    const liveClaims = Object.values(current.claims).filter((claim) => claim.status === 'live');
    if (liveClaims.length > 0) {
      throw new Error(`cannot pause graph with ${liveClaims.length} live claims; fence them first`);
    }
    const next: GraphState = { ...current, status: 'paused' as const };
    return { next, result: { paused: true, run_id: runId } };
  });

  const controlStore = new ControlOwnerStore({ sessionId });
  const releasedAt = now();
  // NOTE (finding #5): mutate-then-control ordering is intentionally retained here. The control
  // op is releaseRoot. Reordering to release-first would make the mutate-after-release-success
  // failure leave a 'running' graph with NO control root (already released), which is not
  // cleanly recoverable: executeResume's reservePausedGraph requires status='paused'. The status
  // quo divergence (mutate succeeds, releaseRoot throws e.g. children_live -> paused graph with
  // an active root) keeps the root present and is less severe than a rootless running graph, so
  // the reorder is not clearly safer here.
  controlStore.releaseRoot({
    mode: 'graph',
    run_id: runId,
    nonce: result.state.control_nonce,
    disposition: {
      graph_status: 'paused',
      claims_fenced: true,
      children_drained: true,
    },
    released_at: releasedAt,
  });

  return { result: result.result, replayed: result.replayed, summary: summarizeState(result.state) };
}

function executeAbandon(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const confirmationInput = requireObject(input.confirmation, 'confirmation');
  const confirmedRunId = requireString(confirmationInput.run_id ?? confirmationInput.runId, 'confirmation.run_id');
  if (confirmedRunId !== runId) {
    throw new Error('confirmation run_id does not match');
  }

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'abandon',
    operation_fingerprint: operationFingerprint('abandon', { runId, revisionId, descriptorHash }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    // #2: atomically fence ALL live claims so a worker that finishes AFTER
    // abandon cannot commit a late result against the now-cancelled graph. The
    // claims_fenced:true disposition reported to control is now truthful: every
    // live claim is marked 'fenced' in the same transition that cancels the run.
    const claims = { ...current.claims };
    for (const [id, claim] of Object.entries(claims)) {
      if (claim.status === 'live') {
        claims[id] = { ...claim, status: 'fenced' as const, fenced_at: now() };
      }
    }
    const next: GraphState = { ...current, status: 'cancelled' as const, claims };
    return { next, result: { abandoned: true, run_id: runId } };
  });

  const controlStore = new ControlOwnerStore({ sessionId });
  controlStore.releaseRoot({
    mode: 'graph',
    run_id: runId,
    nonce: result.state.control_nonce,
    disposition: {
      graph_status: 'cancelled',
      claims_fenced: true,
      children_drained: true,
    },
    released_at: now(),
  });

  return { result: result.result, replayed: result.replayed, summary: summarizeState(result.state) };
}

function executeResume(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const driverId = requireString(input.driver_id, 'driver_id');
  const transitionId = requireString(input.transition_id, 'transition_id');

  const store = new GraphStateStore({ sessionId });
  const state = store.read();
  if (!state || state.run_id !== runId) {
    throw new Error(`graph run ${runId} not found for session ${sessionId}`);
  }
  if (state.status !== 'paused') {
    throw new Error(`cannot resume graph in status ${state.status}`);
  }
  if (state.active_revision_id !== revisionId || state.active_revision_hash !== descriptorHash) {
    throw new Error('resume fence does not match active revision/hash');
  }

  const controlStore = new ControlOwnerStore({ sessionId });
  const resumedAt = now();
  // Control-first ordering (finding #5 mitigation): reserve+promote the control root BEFORE
  // persisting status='running'. If the control step throws (e.g. a prior pause left a stale
  // root -> root_conflict), the graph state is unchanged (still 'paused') -> clean failure,
  // user can retry. This is strictly safer than the prior mutate-then-control order, which
  // left the graph 'running' with a stale/missing control root and masked the divergence on
  // replay (the #3 fix skips control ops when result.replayed). The remaining divergence
  // window is the rare case where control succeeds but store.mutate then throws (e.g. a
  // concurrent sequence advance); in that case we attempt to release the freshly promoted
  // root as cleanup. releaseRoot is idempotent and, on a freshly reserved root with no
  // children and a paused graph (pause enforces no live claims), the release is truthful and
  // will actually release, restoring control to the pre-resume state.
  const isReplay = state.transitions.some((transition) => transition.transition_id === transitionId);
  if (!isReplay) {
    controlStore.reservePausedGraph({
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      nonce: state.control_nonce,
      graph_state: {
        session_id: sessionId,
        run_id: runId,
        revision_id: revisionId,
        status: 'paused',
      },
      reserved_at: resumedAt,
    });
    controlStore.promoteRoot({
      mode: 'graph',
      run_id: runId,
      nonce: state.control_nonce,
      promoted_at: resumedAt,
      driver_lease: driverLease(driverId, resumedAt),
    });
  }

  let result;
  try {
    result = store.mutate<JsonValue>({
      transition_id: transitionId,
      operation: 'resume',
      operation_fingerprint: operationFingerprint('resume', { runId, revisionId, descriptorHash, driverId }),
      expected: buildFence(state),
    }, (current) => {
      const next: GraphState = { ...current, status: 'running' as const };
      return { next, result: { resumed: true, run_id: runId } };
    });
  } catch (mutateError) {
    if (!isReplay) {
      // Control root was just reserved+promoted but the graph mutate failed. Attempt to
      // release the root so control does not diverge (active root over a still-paused
      // graph). Swallow release errors: the graph is unchanged and retryable regardless,
      // and a failed cleanup does not make things worse than the original throw.
      try {
        controlStore.releaseRoot({
          mode: 'graph',
          run_id: runId,
          nonce: state.control_nonce,
          disposition: {
            graph_status: 'paused',
            claims_fenced: true,
            children_drained: true,
          },
          released_at: now(),
        });
      } catch {
        // best-effort cleanup; surface the original mutate error below
      }
    }
    throw mutateError;
  }

  return { result: result.result, replayed: result.replayed, summary: summarizeState(result.state) };
}

function executeProposePatch(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const baseRevisionId = requireString(input.base_revision_id, 'base_revision_id');
  const baseDescriptorHash = requireString(input.base_descriptor_hash, 'base_descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const patchInput = requireObject(input.patch, 'patch');
  const proposedDescriptorInput = requireObject(patchInput.proposed_descriptor ?? patchInput.proposedDescriptor, 'patch.proposed_descriptor');
  const invalidatedNodeIds = Array.isArray(patchInput.invalidated_node_ids)
    ? patchInput.invalidated_node_ids.map((value, index) => requireString(value, `patch.invalidated_node_ids[${index}]`))
    : [];
  const proposalEvidence = Array.isArray(patchInput.proposal_evidence)
    ? patchInput.proposal_evidence.map((value, index) => requireEvidence(value, `patch.proposal_evidence[${index}]`))
    : [];

  const proposedSealed = sealGraphDescriptor(parseGraphDescriptor(proposedDescriptorInput));

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'propose-patch',
    operation_fingerprint: operationFingerprint('propose-patch', { runId, baseRevisionId, baseDescriptorHash, proposedRevisionId: proposedSealed.revision_id }),
    // #4: propose-patch fences on the CURRENT (base) dispatch_generation via the
    // active scope. After a prior patch approval the active generation is
    // non-zero, so a hardcoded-0 fence would spuriously conflict. The patch's
    // pending_patch_base scope (used at approve-patch) binds base_generation+1.
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: baseRevisionId,
      revision_hash: baseDescriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    const next = proposeGraphPatch(current, {
      proposal_id: transitionId,
      base_revision_id: baseRevisionId,
      base_revision_hash: baseDescriptorHash,
      proposed_descriptor: proposedSealed,
      invalidated_node_ids: invalidatedNodeIds,
      proposal_evidence: proposalEvidence,
      proposed_at: now(),
    });
    return { next, result: { proposed: true, proposed_revision_id: proposedSealed.revision_id } };
  });

  return { result: result.result, replayed: result.replayed, summary: summarizeState(result.state) };
}

function executeApprovePatch(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const baseRevisionId = requireString(input.base_revision_id, 'base_revision_id');
  const baseDescriptorHash = requireString(input.base_descriptor_hash, 'base_descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const approvalInput = requireObject(input.approval, 'approval');
  const evidence = requireEvidence(approvalInput.evidence ?? approvalInput.approval_evidence, 'approval.evidence');
  const invalidatedNodeIds = Array.isArray(approvalInput.invalidated_node_ids)
    ? approvalInput.invalidated_node_ids.map((value, index) => requireString(value, `approval.invalidated_node_ids[${index}]`))
    : [];
  const proposedRevisionHash = requireString(approvalInput.proposed_revision_hash ?? approvalInput.proposedDescriptorHash, 'approval.proposed_revision_hash');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  // #4: approve-patch uses the pending_patch_base fence scope, which binds the
  // patch's base_dispatch_generation (the generation the patch was proposed
  // against, before the +1 advance). Source it from the pending patch rather
  // than hardcoding 0, so a second patch cycle (base_generation >= 1) fences
  // correctly. While waiting, state.dispatch_generation == base + 1.
  const pendingPatch = currentState.pending_patch;
  if (!pendingPatch) {
    throw new Error('no pending patch to approve');
  }
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'approve-patch',
    operation_fingerprint: operationFingerprint('approve-patch', { runId, baseRevisionId, baseDescriptorHash, proposedRevisionHash }),
    expected: {
      session_id: sessionId,
      run_id: runId,
      revision_id: baseRevisionId,
      revision_hash: baseDescriptorHash,
      dispatch_generation: pendingPatch.base_dispatch_generation,
      commit_sequence: expectedSequence,
    },
    fence_scope: 'pending_patch_base',
  }, (current) => {
    if (!current.pending_patch) throw new Error('no pending patch to approve');
    const recompute: (projection: GraphSchedulerProjection, descriptor: SealedGraphDescriptor, invalidated: ReadonlySet<string>) => GraphSchedulerProjection = (projection, descriptor, invalidated) => {
      const next: GraphSchedulerProjection = {
        activations: {},
        cohorts: {},
        branch_tokens: {},
        traversal_counts: { ...projection.traversal_counts },
        committed_transitions: Object.fromEntries(
          Object.entries(projection.committed_transitions).filter(
            ([, transition]) => !invalidated.has(transition.node_id),
          ),
        ),
        terminal_verification_activation_ids: [...projection.terminal_verification_activation_ids],
      };
      for (const [activationId, activation] of Object.entries(projection.activations)) {
        if (invalidated.has(activation.node_id)) continue;
        next.activations[activationId] = { ...activation, attempt_ids: [...activation.attempt_ids] };
      }
      for (const [cohortId, cohort] of Object.entries(projection.cohorts)) {
        const joinAlive = cohort.join_activation_id && next.activations[cohort.join_activation_id];
        if (joinAlive || cohort.consumed) {
          next.cohorts[cohortId] = { ...cohort, expected_branch_token_ids: [...cohort.expected_branch_token_ids] };
        }
      }
      for (const [tokenId, token] of Object.entries(projection.branch_tokens)) {
        if (token.current_activation_id && next.activations[token.current_activation_id]) {
          next.branch_tokens[tokenId] = { ...token };
        }
      }
      for (const nodeId of descriptor.entry_node_ids) {
        const hasActivation = Object.values(next.activations).some((activation) => activation.node_id === nodeId);
        if (!hasActivation) {
          const activationId = `${descriptor.run_id}:act:${nodeId}:entry`;
          next.activations[activationId] = {
            activation_id: activationId,
            node_id: nodeId,
            status: 'ready',
            attempt_no: 0,
            attempt_ids: [],
            traversal_owner_id: activationId,
          };
        }
      }
      return next;
    };
    const next = approveGraphPatch(current, {
      proposal_id: current.pending_patch.proposal_id,
      base_revision_id: baseRevisionId,
      base_revision_hash: baseDescriptorHash,
      proposed_revision_hash: proposedRevisionHash,
      invalidated_node_ids: invalidatedNodeIds,
      approval_evidence: evidence,
      approved_at: now(),
    }, recompute);
    return { next, result: { approved: true, active_revision_id: next.active_revision_id } };
  });

  return { result: result.result, replayed: result.replayed, summary: summarizeState(result.state) };
}

function executeSettleSession(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const driverId = requireString(input.driver_id, 'driver_id');
  const transitionId = requireString(input.transition_id, 'transition_id');

  const store = new GraphStateStore({ sessionId });
  const state = store.read();
  if (!state) {
    return { result: { settled_lease_ids: [] }, replayed: false };
  }
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'settle-session',
    operation_fingerprint: operationFingerprint('settle-session', { sessionId, driverId }),
    expected: buildFence(state),
  }, (current) => {
    const settled = settleDriverClaims(current, {
      claim_owner_session_id: sessionId,
      driver_instance_id: driverId,
      recorded_at: now(),
      // B4: session-end fences ALL live claims in the session regardless of
      // driver-id (the session is terminating). The driver_id is retained for
      // the diagnostic/audit record but does not filter the fence set.
      scope: 'session',
    });
    return { next: settled.state, result: { settled_lease_ids: settled.settled_lease_ids } };
  });

  return { result: result.result, replayed: result.replayed };
}

function executeResolveJoin(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const activationId = requireString(input.activation_id, 'activation_id');
  const identitiesInput = requireObject(input.identities, 'identities');
  const nextActivationIdsInput = requireObject(identitiesInput.next_activation_ids, 'identities.next_activation_ids');
  const nextActivationIds: Record<string, string> = {};
  for (const [edgeId, value] of Object.entries(nextActivationIdsInput)) {
    nextActivationIds[edgeId] = requireString(value, `identities.next_activation_ids.${edgeId}`);
  }

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'resolve-join',
    operation_fingerprint: operationFingerprint('resolve-join', { runId, revisionId, descriptorHash, activationId, nextActivationIds }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    if (current.status !== 'running' && current.status !== 'waiting_human') {
      throw new Error(`cannot resolve join while graph status is ${current.status}`);
    }
    const descriptor = current.revisions[current.active_revision_id].descriptor;
    const schedulerResult = resolveJoin(descriptor, current.projection, {
      activation_id: activationId,
      transition_id: transitionId,
      identities: { next_activation_ids: nextActivationIds },
    });
    const next: GraphState = { ...current, projection: schedulerResult.projection };
    return {
      next,
      result: {
        transition_id: transitionId,
        activation_id: activationId,
        node_id: schedulerResult.transition.node_id,
        outcome: schedulerResult.transition.outcome,
        selected_edge_ids: schedulerResult.transition.selected_edge_ids,
        created_activation_ids: schedulerResult.transition.created_activation_ids,
        succeeded: isGraphSucceeded(descriptor, schedulerResult.projection),
      },
    };
  });

  return { result: result.result, replayed: result.replayed };
}

function executeRenewClaim(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const leaseId = requireString(input.lease_id, 'lease_id');
  const driverId = requireString(input.driver_id, 'driver_id');
  const trackingId = requireString(input.tracking_id, 'tracking_id');
  const toolStillRunning = input.tool_still_running === true;
  const renewAt = requireString(input.now, 'now');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'renew-claim',
    operation_fingerprint: operationFingerprint('renew-claim', { runId, revisionId, descriptorHash, leaseId, driverId, trackingId }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    if (current.status !== 'running') {
      throw new Error(`cannot renew claim while graph status is ${current.status}`);
    }
    const renewed = renewGraphClaim(current, {
      lease_id: leaseId,
      claim_owner_session_id: sessionId,
      driver_instance_id: driverId,
      tracking_id: trackingId,
      tool_still_running: toolStillRunning,
      now: renewAt,
    });
    return {
      next: renewed.state,
      result: {
        lease_id: renewed.claim.lease_id,
        renewal_count: renewed.claim.renewal_count,
        expires_at: renewed.claim.expires_at,
        last_renewed_at: renewed.claim.last_renewed_at ?? null,
      },
    };
  });

  return { result: result.result, replayed: result.replayed };
}

function executeRecoverExpiredClaim(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const leaseId = requireString(input.lease_id, 'lease_id');
  const recoverAt = requireString(input.now, 'now');
  const newAttemptId = requireString(input.new_attempt_id, 'new_attempt_id');
  const newLeaseId = requireString(input.new_lease_id, 'new_lease_id');
  const newTrackingId = requireString(input.new_tracking_id, 'new_tracking_id');
  const driverId = requireString(input.driver_id, 'driver_id');
  const reconciliationId = requireString(input.reconciliation_id, 'reconciliation_id');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'recover-expired-claim',
    operation_fingerprint: operationFingerprint('recover-expired-claim', { runId, revisionId, descriptorHash, leaseId, newLeaseId, reconciliationId }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    if (current.status !== 'running' && current.status !== 'reconciling') {
      throw new Error(`cannot recover expired claim while graph status is ${current.status}`);
    }
    const recovered = recoverExpiredGraphClaim(current, {
      lease_id: leaseId,
      now: recoverAt,
      new_attempt_id: newAttemptId,
      new_lease_id: newLeaseId,
      new_tracking_id: newTrackingId,
      claimant_session_id: sessionId,
      driver_instance_id: driverId,
      reconciliation_id: reconciliationId,
    }, (projection, replaceInput) => {
      // The expired claim's activation is still 'running' with the old attempt.
      // Begin a fresh replacement attempt on the same activation (mirrors the
      // retry projection used by the claims recovery tests): append the new
      // attempt id and advance attempt_no/active_attempt_id.
      const activation = projection.activations[replaceInput.activation_id];
      if (!activation) {
        throw new Error(`replacement attempt references unknown activation ${replaceInput.activation_id}`);
      }
      return {
        ...projection,
        activations: {
          ...projection.activations,
          [replaceInput.activation_id]: {
            ...activation,
            status: 'running' as const,
            attempt_no: replaceInput.attempt_no,
            attempt_ids: [...activation.attempt_ids, replaceInput.attempt_id],
            active_attempt_id: replaceInput.attempt_id,
          },
        },
      };
    });
    return {
      next: recovered.state,
      result: {
        disposition: recovered.disposition,
        ...(recovered.claim ? { replacement_lease_id: recovered.claim.lease_id } : {}),
        ...(recovered.reconciliation ? { reconciliation_id: recovered.reconciliation.reconciliation_id } : {}),
      },
    };
  });

  return { result: result.result, replayed: result.replayed };
}

function executeRecordLateClaimResult(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const leaseId = requireString(input.lease_id, 'lease_id');
  const attemptId = requireString(input.attempt_id, 'attempt_id');
  const recordedAt = requireString(input.recorded_at, 'recorded_at');
  const summary = requireString(input.summary, 'summary');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'record-late-claim-result',
    operation_fingerprint: operationFingerprint('record-late-claim-result', { runId, revisionId, descriptorHash, leaseId, attemptId }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    const late = recordLateClaimResult(current, {
      lease_id: leaseId,
      attempt_id: attemptId,
      recorded_at: recordedAt,
      summary,
    });
    return {
      next: late.state,
      result: {
        kind: late.diagnostic.kind,
        lease_id: late.diagnostic.lease_id ?? null,
        attempt_id: late.diagnostic.attempt_id ?? null,
        recorded_at: late.diagnostic.recorded_at,
      },
    };
  });

  return { result: result.result, replayed: result.replayed };
}

function executeReleaseAttemptForRetry(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const activationId = requireString(input.activation_id, 'activation_id');
  const attemptId = requireString(input.attempt_id, 'attempt_id');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'release-attempt-for-retry',
    operation_fingerprint: operationFingerprint('release-attempt-for-retry', { runId, revisionId, descriptorHash, activationId, attemptId }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    if (current.status !== 'running' && current.status !== 'waiting_human') {
      throw new Error(`cannot release attempt while graph status is ${current.status}`);
    }
    const projection = releaseAttemptForRetry(current.projection, {
      activation_id: activationId,
      attempt_id: attemptId,
    });
    // Releasing a running attempt returns the activation to 'ready' and drops the
    // active attempt. Fence any live claim bound to that exact attempt so the
    // concurrency slot does not leak while the activation waits for a new claim.
    const claims = { ...current.claims };
    for (const [id, claim] of Object.entries(claims)) {
      if (claim.status === 'live' && claim.activation_id === activationId && claim.attempt_id === attemptId) {
        claims[id] = { ...claim, status: 'fenced' as const, fenced_at: now() };
      }
    }
    const next: GraphState = { ...current, projection, claims };
    return {
      next,
      result: { activation_id: activationId, attempt_id: attemptId, released: true },
    };
  });

  return { result: result.result, replayed: result.replayed };
}

function executeResolveReconciliation(input: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireString(input.session_id, 'session_id');
  const runId = requireString(input.run_id, 'run_id');
  const revisionId = requireString(input.revision_id, 'revision_id');
  const descriptorHash = requireString(input.descriptor_hash, 'descriptor_hash');
  const expectedSequence = requireInteger(input.expected_sequence, 'expected_sequence');
  const transitionId = requireString(input.transition_id, 'transition_id');
  const evidence = requireEvidence(input.evidence, 'evidence');
  const resolvedAt = requireString(input.resolved_at, 'resolved_at');

  const store = new GraphStateStore({ sessionId });
  const currentState = readActiveState(sessionId, runId);
  const result = store.mutate<JsonValue>({
    transition_id: transitionId,
    operation: 'resolve-reconciliation',
    operation_fingerprint: operationFingerprint('resolve-reconciliation', { runId, revisionId, descriptorHash, resolvedAt, evidenceRef: evidence.ref }),
    expected: buildActiveFence(currentState, {
      session_id: sessionId,
      run_id: runId,
      revision_id: revisionId,
      revision_hash: descriptorHash,
      commit_sequence: expectedSequence,
    }),
  }, (current) => {
    if (current.status !== 'reconciling') {
      throw new Error(`cannot resolve reconciliation while graph status is ${current.status}`);
    }
    const unresolved = Object.values(current.reconciliations).filter(
      (record) => record.status === 'unresolved',
    );
    if (unresolved.length === 0) {
      throw new Error('no unresolved reconciliation records to resolve');
    }
    // B5: mark every unresolved reconciliation as accepted (the operator/human
    // resolved the ambiguity with evidence) and transition the run back to
    // 'running' so claim/resume/complete can proceed. An expired reconcile-policy
    // claim no longer permanently breaks the run.
    const reconciliations = { ...current.reconciliations };
    for (const record of unresolved) {
      reconciliations[record.reconciliation_id] = {
        ...record,
        status: 'accepted' as const,
        resolved_at: resolvedAt,
        resolution_evidence: evidence,
      };
    }
    const next: GraphState = { ...current, status: 'running' as const, reconciliations };
    return {
      next,
      result: {
        resolved_reconciliation_ids: unresolved.map((record) => record.reconciliation_id),
        status: 'running',
      },
    };
  });

  return { result: result.result, replayed: result.replayed };
}

export const graphCommandService: GraphCommandService = {
  async execute(request: GraphCommandRequest): Promise<unknown> {
    switch (request.operation) {
      case 'create': return executeCreate(request.input);
      case 'inspect': return executeInspect(request.input);
      case 'status': return executeStatus(request.input);
      case 'ready': return executeReady(request.input);
      case 'approve': return executeApprove(request.input);
      case 'claim': return executeClaim(request.input);
      case 'complete': return applyResultOperation('complete', request.input);
      case 'fail': return applyResultOperation('fail', request.input);
      case 'pause': return executePause(request.input);
      case 'abandon': return executeAbandon(request.input);
      case 'resume': return executeResume(request.input);
      case 'propose-patch': return executeProposePatch(request.input);
      case 'approve-patch': return executeApprovePatch(request.input);
      case 'settle-session': return executeSettleSession(request.input);
      case 'resolve-join': return executeResolveJoin(request.input);
      case 'renew-claim': return executeRenewClaim(request.input);
      case 'recover-expired-claim': return executeRecoverExpiredClaim(request.input);
      case 'record-late-claim-result': return executeRecordLateClaimResult(request.input);
      case 'release-attempt-for-retry': return executeReleaseAttemptForRetry(request.input);
      case 'resolve-reconciliation': return executeResolveReconciliation(request.input);
      default: throw new Error(`unknown graph operation: ${request.operation}`);
    }
  },
};

import { canonicalJson, parseGraphDescriptor, verifyDescriptorHash } from './descriptor.js';
import { parseGraphState, } from './runtime-types.js';
export class GraphRevisionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'GraphRevisionError';
        this.code = code;
    }
}
function timestamp(value, name) {
    if (!Number.isFinite(Date.parse(value))) {
        throw new GraphRevisionError('invalid_timestamp', `${name} must be an ISO timestamp`);
    }
}
function sealedDescriptor(value) {
    const descriptor = parseGraphDescriptor(value);
    if (!verifyDescriptorHash(descriptor)) {
        throw new GraphRevisionError('descriptor_unsealed', 'Revision descriptor hash does not match');
    }
    return descriptor;
}
function sortedUnique(values, name) {
    if (values.length > 1_000 || values.some((value) => value.length === 0 || value.length > 128)) {
        throw new GraphRevisionError('invalid_invalidation', `${name} must be a bounded node ID list`);
    }
    const result = [...new Set(values)].sort();
    if (result.length !== values.length) {
        throw new GraphRevisionError('invalid_invalidation', `${name} cannot contain duplicate node IDs`);
    }
    return result;
}
function assertHumanEvidence(evidence, name) {
    if (evidence.kind !== 'human' || evidence.ref.length === 0 || evidence.ref.length > 2_048) {
        throw new GraphRevisionError('approval_evidence_invalid', `${name} requires bounded human evidence`);
    }
}
export function replacePendingDraft(stateInput, input) {
    const state = parseGraphState(stateInput);
    timestamp(input.replaced_at, 'replaced_at');
    if (state.status !== 'awaiting_approval'
        || !state.pending_approval
        || state.revisions[state.active_revision_id].approval
        || state.commit_sequence !== 0
        || state.transitions.length !== 0
        || Object.keys(state.claims).length !== 0
        || Object.keys(state.reconciliations).length !== 0
        || Object.keys(state.projection.activations).length !== 0
        || Object.keys(state.projection.committed_transitions).length !== 0) {
        throw new GraphRevisionError('draft_not_replaceable', 'Only an unapproved graph with no claims, history, or runnable projection can replace its pending draft');
    }
    const descriptor = sealedDescriptor(input.descriptor);
    if (descriptor.run_id !== state.run_id) {
        throw new GraphRevisionError('run_mismatch', 'Replacement draft must retain the graph run identity');
    }
    if (descriptor.revision_id === state.active_revision_id || state.revisions[descriptor.revision_id]) {
        throw new GraphRevisionError('revision_reused', 'Replacement draft requires a new immutable revision ID');
    }
    const revision = {
        revision_id: descriptor.revision_id,
        descriptor_hash: descriptor.descriptor_hash,
        descriptor: structuredClone(descriptor),
        created_at: input.replaced_at,
        invalidated_node_ids: [],
    };
    return parseGraphState({
        ...structuredClone(state),
        active_revision_id: descriptor.revision_id,
        active_revision_hash: descriptor.descriptor_hash,
        revisions: { ...state.revisions, [descriptor.revision_id]: revision },
        pending_approval: {
            revision_id: descriptor.revision_id,
            revision_hash: descriptor.descriptor_hash,
            requested_at: input.replaced_at,
        },
        updated_at: input.replaced_at,
    });
}
export function approvePendingGraphRevision(stateInput, input, initializeProjection) {
    const state = parseGraphState(stateInput);
    timestamp(input.approved_at, 'approved_at');
    assertHumanEvidence(input.approval_evidence, 'Initial graph approval');
    if (state.status !== 'awaiting_approval' || !state.pending_approval) {
        throw new GraphRevisionError('approval_not_pending', 'Graph is not awaiting initial approval');
    }
    if (state.pending_approval.revision_id !== input.revision_id
        || state.pending_approval.revision_hash !== input.revision_hash
        || state.active_revision_id !== input.revision_id
        || state.active_revision_hash !== input.revision_hash) {
        throw new GraphRevisionError('approval_fence_mismatch', 'Initial approval does not bind the exact pending revision/hash');
    }
    if (Object.keys(state.claims).length > 0 || state.transitions.length > 0) {
        throw new GraphRevisionError('approval_not_quiescent', 'Initial approval cannot cross claims or committed history');
    }
    const current = state.revisions[input.revision_id];
    if (!current || current.approval) {
        throw new GraphRevisionError('approval_reused', 'Pending revision is missing or already approved');
    }
    const approval = {
        revision_id: input.revision_id,
        revision_hash: input.revision_hash,
        approved_at: input.approved_at,
        evidence: structuredClone(input.approval_evidence),
    };
    const projection = initializeProjection(structuredClone(current.descriptor));
    return parseGraphState({
        ...structuredClone(state),
        status: 'running',
        revisions: {
            ...state.revisions,
            [current.revision_id]: { ...current, approval },
        },
        projection,
        pending_approval: undefined,
        updated_at: input.approved_at,
    });
}
export function proposeGraphPatch(stateInput, input) {
    const state = parseGraphState(stateInput);
    timestamp(input.proposed_at, 'proposed_at');
    if (state.status !== 'running' && state.status !== 'waiting_human') {
        throw new GraphRevisionError('patch_not_allowed', `Cannot propose a patch while graph status is ${state.status}`);
    }
    if (state.pending_patch)
        throw new GraphRevisionError('patch_pending', 'A graph patch is already pending');
    if (state.active_revision_id !== input.base_revision_id
        || state.active_revision_hash !== input.base_revision_hash) {
        throw new GraphRevisionError('stale_base', 'Patch proposal has a stale base revision/hash');
    }
    const proposed = sealedDescriptor(input.proposed_descriptor);
    if (proposed.run_id !== state.run_id) {
        throw new GraphRevisionError('run_mismatch', 'Patch descriptor must retain the graph run identity');
    }
    if (proposed.revision_id === state.active_revision_id || state.revisions[proposed.revision_id]) {
        throw new GraphRevisionError('revision_reused', 'Patch requires a new immutable revision ID');
    }
    if (input.proposal_evidence.length > 64) {
        throw new GraphRevisionError('evidence_limit', 'Patch proposal evidence exceeds the configured bound');
    }
    const invalidated = sortedUnique(input.invalidated_node_ids, 'invalidated_node_ids');
    if (invalidated.some((nodeId) => !state.revisions[state.active_revision_id].descriptor.nodes.some((node) => node.id === nodeId))) {
        throw new GraphRevisionError('unknown_invalidation', 'Patch invalidation references an unknown current node ID');
    }
    return parseGraphState({
        ...structuredClone(state),
        status: 'waiting_patch_approval',
        dispatch_generation: state.dispatch_generation + 1,
        pending_patch: {
            proposal_id: input.proposal_id,
            base_revision_id: input.base_revision_id,
            base_revision_hash: input.base_revision_hash,
            base_dispatch_generation: state.dispatch_generation,
            proposed_revision_id: proposed.revision_id,
            proposed_revision_hash: proposed.descriptor_hash,
            proposed_descriptor: structuredClone(proposed),
            invalidated_node_ids: invalidated,
            proposal_evidence: structuredClone(input.proposal_evidence),
            proposed_at: input.proposed_at,
        },
        updated_at: input.proposed_at,
    });
}
export function approveGraphPatch(stateInput, input, recomputeProjection) {
    const state = parseGraphState(stateInput);
    timestamp(input.approved_at, 'approved_at');
    assertHumanEvidence(input.approval_evidence, 'Patch approval');
    const patch = state.pending_patch;
    if (state.status !== 'waiting_patch_approval' || !patch) {
        throw new GraphRevisionError('patch_not_pending', 'No approved patch transition is pending');
    }
    if (patch.proposal_id !== input.proposal_id
        || patch.base_revision_id !== input.base_revision_id
        || patch.base_revision_hash !== input.base_revision_hash
        || patch.proposed_revision_hash !== input.proposed_revision_hash
        || state.active_revision_id !== patch.base_revision_id
        || state.active_revision_hash !== patch.base_revision_hash) {
        throw new GraphRevisionError('patch_fence_mismatch', 'Patch approval does not bind the exact pending base/proposal');
    }
    const requestedInvalidations = sortedUnique(input.invalidated_node_ids, 'invalidated_node_ids');
    if (canonicalJson(requestedInvalidations) !== canonicalJson([...patch.invalidated_node_ids].sort())) {
        throw new GraphRevisionError('invalidation_mismatch', 'Patch approval must enumerate the exact proposed invalidation set');
    }
    // WEDGE 1: once a patch is proposed the run sits in 'waiting_patch_approval',
    // and the runtime result/release/pause gates reject any status other than
    // running/waiting_human. A live claim therefore cannot complete, renew
    // forever (cap), or release during that window, so a hard 'live_claims' reject
    // here would wedge the run: the patch cannot be approved and the live claim
    // cannot drain. Instead of rejecting, fence every non-ambiguous live claim
    // atomically with the patch approval (same semantics as SessionEnd settle):
    // the claim becomes 'fenced' so a late worker result is rejected (and recorded
    // as a late diagnostic) rather than mutating the new revision, and the bound
    // activation is reset to 'ready' so the scheduler can re-claim it under the
    // approved revision. Reconcile-policy (ambiguous external-effect) claims still
    // hard-reject: their outcome requires human resolution and must not be
    // silently dropped by a patch approval.
    const liveClaims = Object.values(state.claims).filter((claim) => claim.status === 'live');
    const fencedClaims = {};
    const baseActivations = structuredClone(state.projection.activations);
    for (const claim of liveClaims) {
        if (claim.effect_policy.policy === 'reconcile') {
            throw new GraphRevisionError('live_claims', 'Patch approval is blocked until every ambiguous (reconcile-policy) live claim is resolved');
        }
        const fenced = { ...claim, status: 'fenced', fenced_at: input.approved_at };
        fencedClaims[claim.lease_id] = fenced;
        // Reset the bound activation to 'ready' so it can be re-claimed under the
        // new revision. Only reset when the activation is still running on this
        // claim's attempt; a completed or already-reset activation is left alone.
        const activation = baseActivations[claim.activation_id];
        if (activation
            && activation.status === 'running'
            && activation.active_attempt_id === claim.attempt_id) {
            const released = { ...activation, status: 'ready' };
            delete released.active_attempt_id;
            baseActivations[claim.activation_id] = released;
        }
    }
    if (Object.values(state.reconciliations).some((record) => record.status === 'unresolved')) {
        throw new GraphRevisionError('unresolved_reconciliation', 'Patch approval is blocked by unresolved reconciliation');
    }
    const baseDescriptor = state.revisions[patch.base_revision_id].descriptor;
    const nextDescriptor = sealedDescriptor(patch.proposed_descriptor);
    const nextNodes = new Map(nextDescriptor.nodes.map((node) => [node.id, node]));
    const invalidated = new Set(requestedInvalidations);
    const completedNodeIds = new Set(Object.values(baseActivations)
        .filter((activation) => activation.status === 'completed')
        .map((activation) => activation.node_id));
    for (const nodeId of completedNodeIds) {
        const before = baseDescriptor.nodes.find((node) => node.id === nodeId);
        const after = nextNodes.get(nodeId);
        if ((!before || !after || canonicalJson(before) !== canonicalJson(after)) && !invalidated.has(nodeId)) {
            throw new GraphRevisionError('completed_node_repurposed', `Completed node ID ${nodeId} changed without explicit approved invalidation`);
        }
    }
    const approval = {
        revision_id: nextDescriptor.revision_id,
        revision_hash: nextDescriptor.descriptor_hash,
        approved_at: input.approved_at,
        evidence: structuredClone(input.approval_evidence),
    };
    const revision = {
        revision_id: nextDescriptor.revision_id,
        descriptor_hash: nextDescriptor.descriptor_hash,
        descriptor: structuredClone(nextDescriptor),
        created_at: patch.proposed_at,
        approval,
        invalidated_node_ids: requestedInvalidations,
    };
    const projection = recomputeProjection({ ...structuredClone(state.projection), activations: baseActivations }, structuredClone(nextDescriptor), invalidated);
    const claims = structuredClone(state.claims);
    for (const [leaseId, fenced] of Object.entries(fencedClaims)) {
        claims[leaseId] = fenced;
    }
    return parseGraphState({
        ...structuredClone(state),
        status: 'running',
        active_revision_id: nextDescriptor.revision_id,
        active_revision_hash: nextDescriptor.descriptor_hash,
        revisions: { ...state.revisions, [nextDescriptor.revision_id]: revision },
        projection,
        claims,
        pending_patch: undefined,
        updated_at: input.approved_at,
    });
}
//# sourceMappingURL=revisions.js.map
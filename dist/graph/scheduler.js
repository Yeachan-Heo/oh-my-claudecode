import { createHash } from 'node:crypto';
import { canonicalJson } from './descriptor.js';
import { parseGraphNodeResult } from './schema.js';
export class GraphSchedulerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'GraphSchedulerError';
        this.code = code;
    }
}
function cloneProjection(projection) {
    return {
        activations: Object.fromEntries(Object.entries(projection.activations).map(([id, activation]) => [
            id,
            { ...activation, attempt_ids: [...activation.attempt_ids] },
        ])),
        cohorts: Object.fromEntries(Object.entries(projection.cohorts).map(([id, cohort]) => [
            id,
            { ...cohort, expected_branch_token_ids: [...cohort.expected_branch_token_ids] },
        ])),
        branch_tokens: Object.fromEntries(Object.entries(projection.branch_tokens).map(([id, token]) => [id, { ...token }])),
        traversal_counts: { ...projection.traversal_counts },
        committed_transitions: Object.fromEntries(Object.entries(projection.committed_transitions).map(([id, transition]) => [
            id,
            {
                ...transition,
                selected_edge_ids: [...transition.selected_edge_ids],
                created_activation_ids: [...transition.created_activation_ids],
                evidence_refs: transition.evidence_refs.map((evidence) => ({ ...evidence })),
            },
        ])),
        terminal_verification_activation_ids: [...projection.terminal_verification_activation_ids],
    };
}
function nodeMap(descriptor) {
    return new Map(descriptor.nodes.map((node) => [node.id, node]));
}
function outgoingEdges(descriptor, nodeId) {
    return descriptor.edges.filter((edge) => edge.from === nodeId);
}
function getActivation(projection, activationId) {
    const activation = projection.activations[activationId];
    if (!activation) {
        throw new GraphSchedulerError('activation_not_found', `Activation ${activationId} does not exist`);
    }
    return activation;
}
function ensureUniqueIdentity(projection, kind, id, pending = new Set()) {
    let exists = pending.has(id);
    if (kind === 'activation')
        exists ||= id in projection.activations;
    if (kind === 'attempt') {
        exists ||= Object.values(projection.activations).some((activation) => activation.attempt_ids.includes(id));
    }
    if (kind === 'cohort')
        exists ||= id in projection.cohorts;
    if (kind === 'branch token')
        exists ||= id in projection.branch_tokens;
    if (exists) {
        throw new GraphSchedulerError('duplicate_identity', `${kind} identity ${id} is already in use`);
    }
    pending.add(id);
}
function newActivation(activationId, nodeId, options = {}) {
    return {
        activation_id: activationId,
        node_id: nodeId,
        status: 'ready',
        attempt_no: 0,
        attempt_ids: [],
        traversal_owner_id: options.traversalOwnerId ?? activationId,
        ...(options.cohortId ? { cohort_id: options.cohortId } : {}),
        ...(options.branchTokenId ? { branch_token_id: options.branchTokenId } : {}),
    };
}
export function initializeGraphProjection(descriptor, entryActivationIds) {
    const projection = {
        activations: {},
        cohorts: {},
        branch_tokens: {},
        traversal_counts: {},
        committed_transitions: {},
        terminal_verification_activation_ids: [],
    };
    const pending = new Set();
    for (const nodeId of descriptor.entry_node_ids) {
        const activationId = entryActivationIds[nodeId];
        if (!activationId) {
            throw new GraphSchedulerError('missing_identity', `Entry node ${nodeId} requires an activation identity`);
        }
        ensureUniqueIdentity(projection, 'activation', activationId, pending);
        projection.activations[activationId] = newActivation(activationId, nodeId);
    }
    const unknownEntries = Object.keys(entryActivationIds).filter((nodeId) => !descriptor.entry_node_ids.includes(nodeId));
    if (unknownEntries.length > 0) {
        throw new GraphSchedulerError('unexpected_identity', `Activation identities were provided for non-entry nodes: ${unknownEntries.join(', ')}`);
    }
    return projection;
}
export function beginActivationAttempt(projection, input) {
    const activation = getActivation(projection, input.activation_id);
    if (activation.status !== 'ready') {
        throw new GraphSchedulerError('activation_not_ready', `Activation ${activation.activation_id} is ${activation.status}, not ready`);
    }
    const attemptNo = activation.attempt_no + 1;
    if (input.max_attempts !== undefined && attemptNo > input.max_attempts) {
        throw new GraphSchedulerError('max_attempts_exceeded', `Activation ${activation.activation_id} exceeds max_attempts ${input.max_attempts}`);
    }
    ensureUniqueIdentity(projection, 'attempt', input.attempt_id);
    const next = cloneProjection(projection);
    next.activations[input.activation_id] = {
        ...next.activations[input.activation_id],
        status: 'running',
        attempt_no: attemptNo,
        attempt_ids: [...activation.attempt_ids, input.attempt_id],
        active_attempt_id: input.attempt_id,
    };
    return next;
}
export function releaseAttemptForRetry(projection, input) {
    const activation = getActivation(projection, input.activation_id);
    if (activation.status !== 'running' || activation.active_attempt_id !== input.attempt_id) {
        throw new GraphSchedulerError('attempt_fenced', `Attempt ${input.attempt_id} does not own running activation ${input.activation_id}`);
    }
    const next = cloneProjection(projection);
    const released = { ...next.activations[input.activation_id], status: 'ready' };
    delete released.active_attempt_id;
    next.activations[input.activation_id] = released;
    return next;
}
function replayedTransition(projection, transitionId, activationId, requestFingerprint) {
    const transition = projection.committed_transitions[transitionId];
    if (!transition)
        return undefined;
    if (transition.activation_id !== activationId) {
        throw new GraphSchedulerError('transition_fenced', `Transition ${transitionId} is already committed for activation ${transition.activation_id}`);
    }
    if (transition.request_fingerprint !== requestFingerprint) {
        throw new GraphSchedulerError('transition_fenced', `Transition ${transitionId} request fingerprint does not match the committed request`);
    }
    return { projection, transition, replayed: true };
}
function requestFingerprint(kind, value) {
    return createHash('sha256').update(canonicalJson({ kind, value })).digest('hex');
}
function requireRunningAttempt(projection, activationId, attemptId) {
    const activation = getActivation(projection, activationId);
    if (activation.status !== 'running' || activation.active_attempt_id !== attemptId) {
        throw new GraphSchedulerError('attempt_fenced', `Attempt ${attemptId} does not own running activation ${activationId}`);
    }
    return activation;
}
function selectEdges(descriptor, activation, route, projection) {
    const edges = outgoingEdges(descriptor, activation.node_id);
    if (edges.length === 0) {
        if (route)
            throw new GraphSchedulerError('undeclared_route', `Node ${activation.node_id} has no declared routes`);
        return [];
    }
    if (edges.every((edge) => edge.kind === 'fan_out')) {
        if (route)
            throw new GraphSchedulerError('undeclared_route', `Fan-out node ${activation.node_id} does not accept route ${route}`);
        return edges;
    }
    if (edges.length === 1 && edges[0].kind === 'fixed') {
        if (route)
            throw new GraphSchedulerError('undeclared_route', `Fixed node ${activation.node_id} does not accept route ${route}`);
        return edges;
    }
    if (!route) {
        throw new GraphSchedulerError('route_required', `Node ${activation.node_id} requires one declared route`);
    }
    const selected = edges.filter((edge) => (edge.kind === 'conditional' || edge.kind === 'back_edge') && edge.route === route);
    if (selected.length !== 1) {
        throw new GraphSchedulerError('undeclared_route', `Node ${activation.node_id} received undeclared route ${route}`);
    }
    const edge = selected[0];
    if (edge.kind === 'back_edge') {
        const count = projection.traversal_counts[traversalCounterKey(activation, edge)] ?? 0;
        if (count >= edge.max_traversals) {
            throw new GraphSchedulerError('traversal_bound_exceeded', `Back-edge ${edge.id} traversal bound ${edge.max_traversals} is exhausted`);
        }
    }
    return selected;
}
export function traversalCounterKey(activation, edge) {
    return canonicalJson([activation.traversal_owner_id, edge.id]);
}
function requiredIdentity(identities, edgeId, kind) {
    const id = identities?.[edgeId];
    if (!id) {
        throw new GraphSchedulerError('missing_identity', `Edge ${edgeId} requires a ${kind} identity`);
    }
    return id;
}
function arriveAtJoin(descriptor, projection, activation, targetJoinId, identities, createdActivationIds) {
    if (!activation.cohort_id || !activation.branch_token_id) {
        throw new GraphSchedulerError('join_owner_missing', `Activation ${activation.activation_id} cannot enter join ${targetJoinId} without a branch token`);
    }
    const token = projection.branch_tokens[activation.branch_token_id];
    const cohort = projection.cohorts[activation.cohort_id];
    if (!token || !cohort || token.owner_join_id !== targetJoinId || cohort.owner_join_id !== targetJoinId) {
        throw new GraphSchedulerError('join_owner_mismatch', `Branch token does not own join ${targetJoinId}`);
    }
    if (token.status !== 'active' || token.current_activation_id !== activation.activation_id) {
        throw new GraphSchedulerError('branch_token_fenced', `Branch token ${token.branch_token_id} is not active here`);
    }
    const arrived = { ...token, status: 'arrived' };
    delete arrived.current_activation_id;
    projection.branch_tokens[token.branch_token_id] = arrived;
    const allArrived = cohort.expected_branch_token_ids.every((tokenId) => projection.branch_tokens[tokenId]?.status === 'arrived');
    if (!allArrived)
        return;
    if (cohort.join_activation_id) {
        throw new GraphSchedulerError('duplicate_join_activation', `Cohort ${cohort.cohort_id} already activated its join`);
    }
    const joinActivationId = identities.join_activation_id;
    if (!joinActivationId) {
        throw new GraphSchedulerError('missing_identity', `Ready join ${targetJoinId} requires an activation identity`);
    }
    ensureUniqueIdentity(projection, 'activation', joinActivationId);
    projection.activations[joinActivationId] = newActivation(joinActivationId, targetJoinId, {
        cohortId: cohort.cohort_id,
    });
    projection.cohorts[cohort.cohort_id] = { ...cohort, join_activation_id: joinActivationId };
    createdActivationIds.push(joinActivationId);
    const join = nodeMap(descriptor).get(targetJoinId);
    if (join?.kind !== 'join') {
        throw new GraphSchedulerError('join_not_found', `Join node ${targetJoinId} does not exist`);
    }
}
function createFanOut(projection, activation, edges, identities, createdActivationIds) {
    const cohortId = identities.cohort_id;
    if (!cohortId)
        throw new GraphSchedulerError('missing_identity', 'Fan-out requires a cohort identity');
    ensureUniqueIdentity(projection, 'cohort', cohortId);
    const pendingActivations = new Set();
    const pendingTokens = new Set();
    const tokenIds = [];
    for (const edge of edges) {
        const activationId = requiredIdentity(identities.next_activation_ids, edge.id, 'next activation');
        const tokenId = requiredIdentity(identities.branch_token_ids, edge.id, 'branch token');
        ensureUniqueIdentity(projection, 'activation', activationId, pendingActivations);
        ensureUniqueIdentity(projection, 'branch token', tokenId, pendingTokens);
        projection.activations[activationId] = newActivation(activationId, edge.to, {
            cohortId,
            branchTokenId: tokenId,
            traversalOwnerId: tokenId,
        });
        projection.branch_tokens[tokenId] = {
            branch_token_id: tokenId,
            cohort_id: cohortId,
            branch_id: edge.branch_id,
            owner_join_id: edge.owner_join_id,
            status: 'active',
            current_activation_id: activationId,
        };
        tokenIds.push(tokenId);
        createdActivationIds.push(activationId);
    }
    projection.cohorts[cohortId] = {
        cohort_id: cohortId,
        fan_out_node_id: activation.node_id,
        owner_join_id: edges[0].owner_join_id,
        expected_branch_token_ids: tokenIds,
        consumed: false,
    };
    return cohortId;
}
function createNextActivation(descriptor, projection, activation, edge, identities, createdActivationIds) {
    const target = nodeMap(descriptor).get(edge.to);
    if (target?.kind === 'join') {
        arriveAtJoin(descriptor, projection, activation, edge.to, identities, createdActivationIds);
        return;
    }
    const activationId = requiredIdentity(identities.next_activation_ids, edge.id, 'next activation');
    ensureUniqueIdentity(projection, 'activation', activationId);
    projection.activations[activationId] = newActivation(activationId, edge.to, {
        cohortId: activation.cohort_id,
        branchTokenId: activation.branch_token_id,
        traversalOwnerId: activation.traversal_owner_id,
    });
    createdActivationIds.push(activationId);
    if (activation.branch_token_id) {
        const token = projection.branch_tokens[activation.branch_token_id];
        if (!token || token.status !== 'active' || token.current_activation_id !== activation.activation_id) {
            throw new GraphSchedulerError('branch_token_fenced', `Branch token ${activation.branch_token_id} is not owned by ${activation.activation_id}`);
        }
        projection.branch_tokens[activation.branch_token_id] = {
            ...token,
            current_activation_id: activationId,
        };
    }
    if (edge.kind === 'back_edge') {
        const key = traversalCounterKey(activation, edge);
        projection.traversal_counts[key] = (projection.traversal_counts[key] ?? 0) + 1;
    }
}
function commitTransition(projection, transition) {
    projection.committed_transitions[transition.transition_id] = transition;
    return { projection, transition, replayed: false };
}
export function applyNodeResult(descriptor, projection, rawInput) {
    const result = parseGraphNodeResult(rawInput.result);
    const identities = rawInput.identities ?? {};
    const fingerprint = requestFingerprint('node_result', {
        activation_id: rawInput.activation_id,
        result,
        identities,
    });
    const replay = replayedTransition(projection, rawInput.transition_id, rawInput.activation_id, fingerprint);
    if (replay)
        return replay;
    const activation = requireRunningAttempt(projection, rawInput.activation_id, result.attempt_id);
    const node = nodeMap(descriptor).get(activation.node_id);
    if (!node)
        throw new GraphSchedulerError('node_not_found', `Node ${activation.node_id} does not exist`);
    if (node.kind === 'join') {
        throw new GraphSchedulerError('join_is_automatic', `Join ${node.id} must be resolved by the scheduler`);
    }
    if (result.outcome === 'failed' && result.route) {
        throw new GraphSchedulerError('undeclared_route', 'Failed node results cannot select an outgoing route');
    }
    if (node.id === descriptor.terminal_verification_node_id
        && result.outcome === 'succeeded'
        && result.evidence_refs.length === 0) {
        throw new GraphSchedulerError('terminal_evidence_required', 'Terminal verification requires fresh evidence before success');
    }
    const next = cloneProjection(projection);
    const nextActivation = next.activations[activation.activation_id];
    // A3: a failed activation is retryable while attempt budget remains; once
    // exhausted it goes terminal 'failed' so the run can be promoted to a failed
    // graph status instead of wedging as an un-claimable, un-retryable activation.
    const maxAttempts = node.kind === 'agent' || node.kind === 'command' ? node.max_attempts : undefined;
    const exhausted = maxAttempts === undefined || activation.attempt_no >= maxAttempts;
    const nextStatus = result.outcome === 'succeeded'
        ? 'completed'
        : (exhausted ? 'failed' : 'ready');
    nextActivation.status = nextStatus;
    // Only record the terminal transition on terminal outcomes; a retryable
    // failure returns to 'ready' for a fresh begin and must not carry a stale
    // completed_transition_id from the failed attempt.
    if (nextStatus !== 'ready') {
        nextActivation.completed_transition_id = rawInput.transition_id;
    }
    const selected = result.outcome === 'succeeded'
        ? selectEdges(descriptor, activation, result.route, projection)
        : [];
    const createdActivationIds = [];
    let cohortId;
    if (selected.length > 0 && selected.every((edge) => edge.kind === 'fan_out')) {
        cohortId = createFanOut(next, activation, selected, identities, createdActivationIds);
    }
    else if (selected.length === 1) {
        createNextActivation(descriptor, next, activation, selected[0], identities, createdActivationIds);
    }
    if (node.id === descriptor.terminal_verification_node_id && result.outcome === 'succeeded') {
        next.terminal_verification_activation_ids.push(activation.activation_id);
    }
    const transition = {
        transition_id: rawInput.transition_id,
        activation_id: activation.activation_id,
        node_id: activation.node_id,
        outcome: result.outcome,
        request_fingerprint: fingerprint,
        selected_edge_ids: selected.map((edge) => edge.id),
        created_activation_ids: createdActivationIds,
        attempt_id: result.attempt_id,
        evidence_refs: result.evidence_refs.map((evidence) => ({ ...evidence })),
        ...(result.route ? { route: result.route } : {}),
        ...(result.output_summary ? { output_summary: result.output_summary } : {}),
        ...(result.external_idempotency_key
            ? { external_idempotency_key: result.external_idempotency_key }
            : {}),
        ...(cohortId ? { cohort_id: cohortId } : {}),
    };
    return commitTransition(next, transition);
}
export function resolveJoin(descriptor, projection, input) {
    const identities = input.identities ?? {};
    const fingerprint = requestFingerprint('join', {
        activation_id: input.activation_id,
        identities,
    });
    const replay = replayedTransition(projection, input.transition_id, input.activation_id, fingerprint);
    if (replay)
        return replay;
    const activation = getActivation(projection, input.activation_id);
    const node = nodeMap(descriptor).get(activation.node_id);
    if (node?.kind !== 'join') {
        throw new GraphSchedulerError('join_not_found', `Activation ${input.activation_id} is not a join`);
    }
    if (activation.status !== 'ready' || !activation.cohort_id) {
        throw new GraphSchedulerError('join_not_ready', `Join activation ${input.activation_id} is not ready`);
    }
    const cohort = projection.cohorts[activation.cohort_id];
    if (!cohort || cohort.owner_join_id !== node.id || cohort.join_activation_id !== activation.activation_id) {
        throw new GraphSchedulerError('join_owner_mismatch', `Join activation ${input.activation_id} does not own its cohort`);
    }
    if (cohort.consumed) {
        throw new GraphSchedulerError('join_already_consumed', `Cohort ${cohort.cohort_id} is already consumed`);
    }
    const tokens = cohort.expected_branch_token_ids.map((id) => projection.branch_tokens[id]);
    if (tokens.some((token) => !token || token.status !== 'arrived')) {
        throw new GraphSchedulerError('join_not_ready', `Join ${node.id} is still waiting for selected branch tokens`);
    }
    const edge = outgoingEdges(descriptor, node.id)[0];
    if (!edge || edge.kind !== 'fixed') {
        throw new GraphSchedulerError('invalid_join_edge', `Join ${node.id} does not have one fixed outgoing edge`);
    }
    const nextActivationId = requiredIdentity(identities.next_activation_ids, edge.id, 'next activation');
    ensureUniqueIdentity(projection, 'activation', nextActivationId);
    const next = cloneProjection(projection);
    next.activations[activation.activation_id] = {
        ...next.activations[activation.activation_id],
        status: 'completed',
        completed_transition_id: input.transition_id,
    };
    next.activations[nextActivationId] = newActivation(nextActivationId, edge.to);
    next.cohorts[cohort.cohort_id] = { ...next.cohorts[cohort.cohort_id], consumed: true };
    for (const token of tokens) {
        next.branch_tokens[token.branch_token_id] = {
            ...next.branch_tokens[token.branch_token_id],
            status: 'consumed',
            consumed_by_activation_id: activation.activation_id,
        };
    }
    const transition = {
        transition_id: input.transition_id,
        activation_id: activation.activation_id,
        node_id: activation.node_id,
        outcome: 'join_resolved',
        request_fingerprint: fingerprint,
        selected_edge_ids: [edge.id],
        created_activation_ids: [nextActivationId],
        evidence_refs: [],
        cohort_id: cohort.cohort_id,
    };
    return commitTransition(next, transition);
}
export function listReadyExecutableActivations(descriptor, projection) {
    const nodes = nodeMap(descriptor);
    return Object.values(projection.activations)
        .filter((activation) => activation.status === 'ready' && nodes.get(activation.node_id)?.kind !== 'join')
        .sort((left, right) => left.activation_id.localeCompare(right.activation_id));
}
export function listReadyJoinActivations(descriptor, projection) {
    const nodes = nodeMap(descriptor);
    return Object.values(projection.activations)
        .filter((activation) => activation.status === 'ready' && nodes.get(activation.node_id)?.kind === 'join')
        .sort((left, right) => left.activation_id.localeCompare(right.activation_id));
}
export function isGraphSucceeded(descriptor, projection) {
    if (projection.terminal_verification_activation_ids.length === 0)
        return false;
    const terminalIds = new Set(projection.terminal_verification_activation_ids);
    if ([...terminalIds].some((id) => {
        const activation = projection.activations[id];
        const transition = activation?.completed_transition_id
            ? projection.committed_transitions[activation.completed_transition_id]
            : undefined;
        return activation?.node_id !== descriptor.terminal_verification_node_id
            || activation.status !== 'completed'
            || transition?.outcome !== 'succeeded'
            || transition.evidence_refs.length === 0;
    })) {
        return false;
    }
    return Object.values(projection.activations).every((activation) => activation.status === 'completed')
        && Object.values(projection.cohorts).every((cohort) => cohort.consumed);
}
//# sourceMappingURL=scheduler.js.map
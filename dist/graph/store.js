import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { occCommitMutation, occReadCurrentState } from '../lib/mode-state-io.js';
import { resolveSessionStatePaths } from '../lib/worktree-paths.js';
import { canonicalJson } from './descriptor.js';
import { GRAPH_MAX_TRANSITIONS, GRAPH_STATE_MAX_BYTES, GRAPH_MAX_TRANSITION_RESULT_BYTES, parseGraphState, } from './runtime-types.js';
export class GraphStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'GraphStoreError';
        this.code = code;
    }
}
const DEFAULT_DEPENDENCIES = {
    fileExists: existsSync,
    readText: (path) => readFileSync(path, 'utf8'),
    readCurrent: occReadCurrentState,
    occCommit: occCommitMutation,
    now: () => new Date().toISOString(),
};
function boundedJsonClone(value, label) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    }
    catch (error) {
        throw new GraphStoreError('invalid_result', `${label} is not JSON serializable: ${String(error)}`);
    }
    if (serialized === undefined) {
        throw new GraphStoreError('invalid_result', `${label} must be a JSON value`);
    }
    if (Buffer.byteLength(serialized, 'utf8') > GRAPH_MAX_TRANSITION_RESULT_BYTES) {
        throw new GraphStoreError('result_too_large', `${label} exceeds ${GRAPH_MAX_TRANSITION_RESULT_BYTES} bytes`);
    }
    return JSON.parse(serialized);
}
function requestFingerprint(request) {
    return createHash('sha256')
        .update(canonicalJson({
        transition_id: request.transition_id,
        operation: request.operation,
        operation_fingerprint: request.operation_fingerprint,
        expected: request.expected,
        fence_scope: request.fence_scope ?? 'active',
    }))
        .digest('hex');
}
function assertIdentifier(value, name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new GraphStoreError('invalid_request', `${name} must be a stable identifier`);
    }
}
function assertRequest(request) {
    assertIdentifier(request.transition_id, 'transition_id');
    if (request.operation.length === 0 || request.operation.length > 128) {
        throw new GraphStoreError('invalid_request', 'operation must be a bounded string');
    }
    if (request.operation_fingerprint.length === 0 || request.operation_fingerprint.length > 1_024) {
        throw new GraphStoreError('invalid_request', 'operation_fingerprint must be a bounded string');
    }
    if (!Number.isSafeInteger(request.expected.commit_sequence) || request.expected.commit_sequence < 0) {
        throw new GraphStoreError('invalid_request', 'expected commit_sequence must be non-negative');
    }
}
function assertFence(state, request) {
    const expected = request.expected;
    if (state.session_id !== expected.session_id) {
        throw new GraphStoreError('session_mismatch', 'Graph session fence does not match');
    }
    if (state.run_id !== expected.run_id) {
        throw new GraphStoreError('run_mismatch', 'Graph run fence does not match');
    }
    if (state.commit_sequence !== expected.commit_sequence) {
        throw new GraphStoreError('sequence_conflict', `Expected commit sequence ${expected.commit_sequence}, found ${state.commit_sequence}`);
    }
    if ((request.fence_scope ?? 'active') === 'pending_patch_base') {
        const patch = state.pending_patch;
        if (state.status !== 'waiting_patch_approval'
            || !patch
            || patch.base_revision_id !== expected.revision_id
            || patch.base_revision_hash !== expected.revision_hash
            || patch.base_dispatch_generation !== expected.dispatch_generation
            || state.active_revision_id !== expected.revision_id
            || state.active_revision_hash !== expected.revision_hash) {
            throw new GraphStoreError('stale_patch_base', 'Pending patch no longer binds the expected claim generation');
        }
        return;
    }
    if (state.active_revision_id !== expected.revision_id || state.active_revision_hash !== expected.revision_hash) {
        throw new GraphStoreError('revision_conflict', 'Active graph revision/hash fence does not match');
    }
    if (state.dispatch_generation !== expected.dispatch_generation) {
        throw new GraphStoreError('dispatch_generation_conflict', 'Graph dispatch generation fence does not match');
    }
}
function assertStoreManagedFieldsUnchanged(before, next) {
    if (next.format_version !== before.format_version || next.session_id !== before.session_id || next.run_id !== before.run_id) {
        throw new GraphStoreError('identity_mutation', 'Mutation callbacks cannot replace graph authority identity');
    }
    if (next.commit_sequence !== before.commit_sequence) {
        throw new GraphStoreError('sequence_mutation', 'Mutation callbacks cannot edit commit_sequence directly');
    }
    if (canonicalJson(next.transitions) !== canonicalJson(before.transitions)) {
        throw new GraphStoreError('history_mutation', 'Mutation callbacks cannot edit committed transition history directly');
    }
}
export class GraphStateStore {
    sessionId;
    worktreeRoot;
    path;
    readPath;
    dependencies;
    constructor(options) {
        const paths = resolveSessionStatePaths('graph', options.sessionId, options.worktreeRoot);
        if (!paths.sessionScoped || paths.effectiveWrite !== paths.sessionScoped) {
            throw new GraphStoreError('unsafe_state_path', 'Graph requires an explicit session-scoped write path');
        }
        this.sessionId = options.sessionId;
        this.worktreeRoot = options.worktreeRoot;
        this.path = paths.effectiveWrite;
        this.readPath = paths.sessionScoped;
        this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    }
    read() {
        // Under (B) the OCC journal is the source of truth; the canonical file is a
        // derived cache. read() returns the journal's max-complete committed state.
        const currentRaw = this.dependencies.readCurrent(this.readPath);
        if (currentRaw === null || currentRaw === undefined)
            return null;
        let parsed = currentRaw;
        if (typeof currentRaw === 'string') {
            try {
                parsed = JSON.parse(currentRaw);
            }
            catch (error) {
                throw new GraphStoreError('malformed_state', `Cannot parse graph-state.json: ${String(error)}`);
            }
        }
        const state = parseGraphState(parsed);
        if (state.session_id !== this.sessionId) {
            throw new GraphStoreError('session_mismatch', 'Graph state belongs to a different session');
        }
        return state;
    }
    create(state) {
        const validated = parseGraphState(state);
        if (validated.session_id !== this.sessionId) {
            throw new GraphStoreError('session_mismatch', 'Initial Graph state session does not match the store');
        }
        if (validated.commit_sequence !== 0 || validated.transitions.length !== 0) {
            throw new GraphStoreError('invalid_initial_state', 'Initial Graph state must start at sequence zero');
        }
        this.assertStateSize(validated);
        const committed = this.dependencies.occCommit(this.path, (currentRaw) => {
            if (currentRaw !== null && currentRaw !== undefined) {
                // A committed state already exists in the OCC journal (or seeded from
                // the canonical file). create() must not overwrite it.
                throw new GraphStoreError('already_exists', 'Graph state already exists for this session');
            }
            return { state: validated, result: validated };
        });
        if (!committed) {
            throw new GraphStoreError('lock_busy', 'Could not commit the initial Graph state via OCC');
        }
        return committed.result;
    }
    mutate(request, callback) {
        assertRequest(request);
        const fingerprint = requestFingerprint(request);
        const committed = this.dependencies.occCommit(this.path, (currentRaw) => {
            if (currentRaw === null || currentRaw === undefined) {
                throw new GraphStoreError('not_found', 'Graph state does not exist for this session');
            }
            let current;
            try {
                current = parseGraphState(JSON.parse(JSON.stringify(currentRaw)));
            }
            catch (error) {
                throw new GraphStoreError('malformed_state', `Cannot parse graph-state.json: ${String(error)}`);
            }
            if (current.session_id !== this.sessionId) {
                throw new GraphStoreError('session_mismatch', 'Graph state belongs to a different session');
            }
            const prior = current.transitions.find((transition) => transition.transition_id === request.transition_id);
            if (prior) {
                if (prior.request_fingerprint !== fingerprint) {
                    throw new GraphStoreError('transition_reused', 'Transition ID was already committed for a different request');
                }
                return { state: current, result: { state: current, result: prior.result, replayed: true } };
            }
            assertFence(current, request);
            if (current.transitions.length >= GRAPH_MAX_TRANSITIONS) {
                throw new GraphStoreError('transition_limit', 'Graph transition limit has been reached');
            }
            // The OCC wrapper validates + commits the returned state atomically; the
            // old `renew` lease hook is obsolete (no lease under OCC) so it is a no-op.
            const renew = () => { };
            const mutation = callback(structuredClone(current), renew);
            assertStoreManagedFieldsUnchanged(current, mutation.next);
            const result = boundedJsonClone(mutation.result, 'transition result');
            const sequence = current.commit_sequence + 1;
            const committedAt = this.dependencies.now?.() ?? new Date().toISOString();
            const transition = {
                transition_id: request.transition_id,
                operation: request.operation,
                operation_fingerprint: request.operation_fingerprint,
                request_fingerprint: fingerprint,
                sequence,
                committed_at: committedAt,
                result,
            };
            const next = parseGraphState({
                ...mutation.next,
                commit_sequence: sequence,
                transitions: [...current.transitions, transition],
                updated_at: committedAt,
            });
            this.assertStateSize(next);
            return { state: next, result: { state: next, result, replayed: false } };
        });
        if (!committed) {
            throw new GraphStoreError('lock_busy', 'Could not commit the Graph state mutation via OCC');
        }
        return committed.result;
    }
    assertStateSize(state) {
        const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
        if (bytes > GRAPH_STATE_MAX_BYTES) {
            throw new GraphStoreError('state_too_large', `Graph state exceeds ${GRAPH_STATE_MAX_BYTES} bytes`);
        }
    }
}
//# sourceMappingURL=store.js.map
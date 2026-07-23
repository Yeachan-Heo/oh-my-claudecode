import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { withStateFileMutationLock } from '../lib/mode-state-io.js';
import { resolveSessionStatePaths } from '../lib/worktree-paths.js';
import { canonicalJson } from './descriptor.js';
import {
  GRAPH_MAX_TRANSITIONS,
  GRAPH_STATE_MAX_BYTES,
  GRAPH_MAX_TRANSITION_RESULT_BYTES,
  parseGraphState,
  type GraphState,
  type GraphStateTransition,
  type JsonValue,
} from './runtime-types.js';

export type GraphFenceScope = 'active' | 'pending_patch_base';

export interface GraphStateFence {
  session_id: string;
  run_id: string;
  revision_id: string;
  revision_hash: string;
  dispatch_generation: number;
  commit_sequence: number;
}

export interface GraphMutationRequest {
  transition_id: string;
  operation: string;
  operation_fingerprint: string;
  expected: GraphStateFence;
  fence_scope?: GraphFenceScope;
}

export interface GraphMutationValue<T extends JsonValue> {
  next: GraphState;
  result: T;
}

export interface GraphMutationResult<T extends JsonValue> {
  state: GraphState;
  result: T;
  replayed: boolean;
}

export interface GraphStateStoreDependencies {
  fileExists(path: string): boolean;
  readText(path: string): string;
  writeAtomic(path: string, value: unknown): void;
  withExclusiveLock<T>(path: string, callback: () => T): { acquired: boolean; value: T | undefined };
  now?(): string;
}

export interface GraphStateStoreOptions {
  sessionId: string;
  worktreeRoot?: string;
  dependencies?: Partial<GraphStateStoreDependencies>;
}

export class GraphStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GraphStoreError';
    this.code = code;
  }
}

const DEFAULT_DEPENDENCIES: GraphStateStoreDependencies = {
  fileExists: existsSync,
  readText: (path) => readFileSync(path, 'utf8'),
  writeAtomic: atomicWriteJsonSync,
  withExclusiveLock: (path, callback) => withStateFileMutationLock(path, callback, true),
  now: () => new Date().toISOString(),
};

function boundedJsonClone<T extends JsonValue>(value: T, label: string): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new GraphStoreError('invalid_result', `${label} is not JSON serializable: ${String(error)}`);
  }
  if (serialized === undefined) {
    throw new GraphStoreError('invalid_result', `${label} must be a JSON value`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > GRAPH_MAX_TRANSITION_RESULT_BYTES) {
    throw new GraphStoreError('result_too_large', `${label} exceeds ${GRAPH_MAX_TRANSITION_RESULT_BYTES} bytes`);
  }
  return JSON.parse(serialized) as T;
}

function requestFingerprint(request: GraphMutationRequest): string {
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

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new GraphStoreError('invalid_request', `${name} must be a stable identifier`);
  }
}

function assertRequest(request: GraphMutationRequest): void {
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

function assertFence(state: GraphState, request: GraphMutationRequest): void {
  const expected = request.expected;
  if (state.session_id !== expected.session_id) {
    throw new GraphStoreError('session_mismatch', 'Graph session fence does not match');
  }
  if (state.run_id !== expected.run_id) {
    throw new GraphStoreError('run_mismatch', 'Graph run fence does not match');
  }
  if (state.commit_sequence !== expected.commit_sequence) {
    throw new GraphStoreError(
      'sequence_conflict',
      `Expected commit sequence ${expected.commit_sequence}, found ${state.commit_sequence}`,
    );
  }

  if ((request.fence_scope ?? 'active') === 'pending_patch_base') {
    const patch = state.pending_patch;
    if (
      state.status !== 'waiting_patch_approval'
      || !patch
      || patch.base_revision_id !== expected.revision_id
      || patch.base_revision_hash !== expected.revision_hash
      || patch.base_dispatch_generation !== expected.dispatch_generation
      || state.active_revision_id !== expected.revision_id
      || state.active_revision_hash !== expected.revision_hash
    ) {
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

function assertStoreManagedFieldsUnchanged(before: GraphState, next: GraphState): void {
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
  readonly sessionId: string;
  readonly worktreeRoot: string | undefined;
  readonly path: string;
  private readonly readPath: string;
  private readonly dependencies: GraphStateStoreDependencies;

  constructor(options: GraphStateStoreOptions) {
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

  read(): GraphState | null {
    if (!this.dependencies.fileExists(this.readPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.dependencies.readText(this.readPath));
    } catch (error) {
      throw new GraphStoreError('malformed_state', `Cannot parse graph-state.json: ${String(error)}`);
    }
    const state = parseGraphState(parsed);
    if (state.session_id !== this.sessionId) {
      throw new GraphStoreError('session_mismatch', 'Graph state belongs to a different session');
    }
    return state;
  }

  create(state: GraphState): GraphState {
    const result = this.dependencies.withExclusiveLock(this.path, () => {
      if (this.dependencies.fileExists(this.readPath)) {
        throw new GraphStoreError('already_exists', 'Graph state already exists for this session');
      }
      const validated = parseGraphState(state);
      if (validated.session_id !== this.sessionId) {
        throw new GraphStoreError('session_mismatch', 'Initial Graph state session does not match the store');
      }
      if (validated.commit_sequence !== 0 || validated.transitions.length !== 0) {
        throw new GraphStoreError('invalid_initial_state', 'Initial Graph state must start at sequence zero');
      }
      this.assertStateSize(validated);
      this.dependencies.writeAtomic(this.path, validated);
      return validated;
    });
    if (!result.acquired || !result.value) {
      throw new GraphStoreError('lock_busy', 'Could not acquire the exclusive Graph state lock');
    }
    return result.value;
  }

  mutate<T extends JsonValue>(
    request: GraphMutationRequest,
    callback: (state: GraphState) => GraphMutationValue<T>,
  ): GraphMutationResult<T> {
    assertRequest(request);
    const fingerprint = requestFingerprint(request);
    const locked = this.dependencies.withExclusiveLock(this.path, () => {
      const current = this.read();
      if (!current) throw new GraphStoreError('not_found', 'Graph state does not exist for this session');

      const prior = current.transitions.find((transition) => transition.transition_id === request.transition_id);
      if (prior) {
        if (prior.request_fingerprint !== fingerprint) {
          throw new GraphStoreError('transition_reused', 'Transition ID was already committed for a different request');
        }
        return { state: current, result: prior.result as T, replayed: true };
      }

      assertFence(current, request);
      if (current.transitions.length >= GRAPH_MAX_TRANSITIONS) {
        throw new GraphStoreError('transition_limit', 'Graph transition limit has been reached');
      }
      const mutation = callback(structuredClone(current));
      assertStoreManagedFieldsUnchanged(current, mutation.next);
      const result = boundedJsonClone(mutation.result, 'transition result');
      const sequence = current.commit_sequence + 1;
      const committedAt = this.dependencies.now?.() ?? new Date().toISOString();
      const transition: GraphStateTransition = {
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
      this.dependencies.writeAtomic(this.path, next);
      return { state: next, result, replayed: false };
    });
    if (!locked.acquired || !locked.value) {
      throw new GraphStoreError('lock_busy', 'Could not acquire the exclusive Graph state lock');
    }
    return locked.value;
  }

  private assertStateSize(state: GraphState): void {
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
    if (bytes > GRAPH_STATE_MAX_BYTES) {
      throw new GraphStoreError('state_too_large', `Graph state exceeds ${GRAPH_STATE_MAX_BYTES} bytes`);
    }
  }
}

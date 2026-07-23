import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { sealGraphDescriptor } from '../descriptor.js';
import { createInitialGraphState } from '../runtime-types.js';
import { approveGraphPatch, proposeGraphPatch } from '../revisions.js';
import { GraphStateStore, GraphStoreError, type GraphStateStoreDependencies } from '../store.js';
import { forkJoinDescriptor } from './fixtures.js';

const temporaryDirectories: string[] = [];

function createStore(
  writeAtomic = atomicWriteJsonSync,
  withExclusiveLock: GraphStateStoreDependencies['withExclusiveLock'] = (_path, callback) => ({ acquired: true, value: callback(() => {}) }),
) {
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'omc-graph-store-'));
  temporaryDirectories.push(worktreeRoot);
  return new GraphStateStore({
    sessionId: 'session-store',
    worktreeRoot,
    dependencies: {
      fileExists: existsSync,
      readText: (path) => readFileSync(path, 'utf8'),
      writeAtomic,
      withExclusiveLock,
    },
  });
}

function initialState() {
  const descriptor = sealGraphDescriptor(forkJoinDescriptor());
  return createInitialGraphState({
    session_id: 'session-store',
    control_nonce: 'control-store',
    descriptor,
    status: 'running',
    created_at: '2026-07-21T00:00:00.000Z',
    projection: {
      activations: {},
      cohorts: {},
      branch_tokens: {},
      traversal_counts: {},
      committed_transitions: {},
      terminal_verification_activation_ids: [],
    },
    approval: {
      approved_at: '2026-07-21T00:00:00.000Z',
      evidence: { kind: 'human', ref: 'approval-1' },
    },
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('GraphStateStore', () => {
  it('uses only the explicit session-scoped authority path', () => {
    const store = createStore();
    store.create(initialState());

    expect(store.path).toContain('/state/sessions/session-store/graph-state.json');
    expect(store.path).not.toContain('/state/graph-state.json');
    expect(store.read()?.session_id).toBe('session-store');
  });

  it('commits one complete generation and replays an exact transition without a second write', () => {
    const writeAtomic = vi.fn(atomicWriteJsonSync);
    const store = createStore(writeAtomic);
    const created = store.create(initialState());
    const request = {
      transition_id: 'transition-complete-a',
      operation: 'complete-node',
      operation_fingerprint: 'complete-node:activation-a:attempt-a',
      expected: {
        session_id: created.session_id,
        run_id: created.run_id,
        revision_id: created.active_revision_id,
        revision_hash: created.active_revision_hash,
        dispatch_generation: created.dispatch_generation,
        commit_sequence: created.commit_sequence,
      },
    } as const;

    const committed = store.mutate(request, (state) => ({
      next: {
        ...state,
        diagnostics: [
          ...state.diagnostics,
          {
            kind: 'operation' as const,
            recorded_at: '2026-07-21T00:00:01.000Z',
            summary: 'node completed once',
          },
        ],
      },
      result: { selected_edge_ids: ['fan-a'] },
    }));

    const replay = store.mutate(request, () => {
      throw new Error('replayed callbacks must not execute');
    });

    expect(committed.replayed).toBe(false);
    expect(committed.state.commit_sequence).toBe(1);
    expect(replay).toMatchObject({ replayed: true, result: { selected_edge_ids: ['fan-a'] } });
    expect(replay.state.diagnostics).toHaveLength(1);
    expect(writeAtomic).toHaveBeenCalledTimes(2);
  });

  it('exposes cooperative lease renewal and renews again before publishing a graph mutation', () => {
    const renew = vi.fn();
    const store = createStore(
      atomicWriteJsonSync,
      (_path, callback) => ({ acquired: true, value: callback(renew) }),
    );
    const created = store.create(initialState());
    renew.mockClear();

    store.mutate({
      transition_id: 'renewable-transition',
      operation: 'renewable-operation',
      operation_fingerprint: 'renewable-operation:v1',
      expected: {
        session_id: created.session_id,
        run_id: created.run_id,
        revision_id: created.active_revision_id,
        revision_hash: created.active_revision_hash,
        dispatch_generation: created.dispatch_generation,
        commit_sequence: created.commit_sequence,
      },
    }, (state, renewLease) => {
      renewLease();
      return { next: state, result: 'renewed' };
    });

    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('allows one expected-sequence writer and rejects the stale competitor', async () => {
    const store = createStore();
    const created = store.create(initialState());
    const expected = {
      session_id: created.session_id,
      run_id: created.run_id,
      revision_id: created.active_revision_id,
      revision_hash: created.active_revision_hash,
      dispatch_generation: created.dispatch_generation,
      commit_sequence: 0,
    };

    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.mutate({
        transition_id: 'writer-a',
        operation: 'race',
        operation_fingerprint: 'race:a',
        expected,
      }, (state) => ({ next: state, result: 'a' }))),
      Promise.resolve().then(() => store.mutate({
        transition_id: 'writer-b',
        operation: 'race',
        operation_fingerprint: 'race:b',
        expected,
      }, (state) => ({ next: state, result: 'b' }))),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.read()?.commit_sequence).toBe(1);
  });

  it('exposes a complete old or new generation across atomic writer failures', () => {
    const store = createStore();
    const created = store.create(initialState());
    let mode: 'before' | 'after' = 'before';
    const failingStore = new GraphStateStore({
      sessionId: 'session-store',
      worktreeRoot: store.worktreeRoot,
      dependencies: {
        fileExists: existsSync,
        readText: (path) => readFileSync(path, 'utf8'),
        withExclusiveLock: (_path, callback) => ({ acquired: true, value: callback() }),
        writeAtomic: (path, value) => {
          if (mode === 'before') throw new Error('before rename');
          atomicWriteJsonSync(path, value);
          throw new Error('after rename');
        },
      },
    });
    const request = {
      transition_id: 'atomic-transition',
      operation: 'atomic-test',
      operation_fingerprint: 'atomic-test:v1',
      expected: {
        session_id: created.session_id,
        run_id: created.run_id,
        revision_id: created.active_revision_id,
        revision_hash: created.active_revision_hash,
        dispatch_generation: 0,
        commit_sequence: 0,
      },
    } as const;

    expect(() => failingStore.mutate(request, (state) => ({ next: state, result: 'new' })))
      .toThrow('before rename');
    expect(store.read()?.commit_sequence).toBe(0);

    mode = 'after';
    expect(() => failingStore.mutate(request, (state) => ({ next: state, result: 'new' })))
      .toThrow('after rename');
    expect(store.read()).toMatchObject({
      commit_sequence: 1,
      transitions: [{ transition_id: 'atomic-transition' }],
    });
  });

  it('fails closed for a reused transition ID with a different request fence', () => {
    const store = createStore();
    const created = store.create(initialState());
    const base = {
      transition_id: 'same-id',
      operation: 'complete-node',
      operation_fingerprint: 'complete:one',
      expected: {
        session_id: created.session_id,
        run_id: created.run_id,
        revision_id: created.active_revision_id,
        revision_hash: created.active_revision_hash,
        dispatch_generation: 0,
        commit_sequence: 0,
      },
    } as const;
    store.mutate(base, (state) => ({ next: state, result: 'ok' }));

    expect(() => store.mutate(
      { ...base, operation_fingerprint: 'complete:different' },
      (state) => ({ next: state, result: 'wrong' }),
    )).toThrowError(GraphStoreError);
  });

  it('accepts an old dispatch generation only while the exact pending patch base remains unchanged', () => {
    const store = createStore();
    const base = initialState();
    const proposedInput = forkJoinDescriptor();
    proposedInput.revision_id = 'revision-2';
    proposedInput.goal = 'Patched graph';
    const proposedDescriptor = sealGraphDescriptor(proposedInput);
    const proposed = proposeGraphPatch(base, {
      proposal_id: 'patch-1',
      base_revision_id: base.active_revision_id,
      base_revision_hash: base.active_revision_hash,
      proposed_descriptor: proposedDescriptor,
      invalidated_node_ids: [],
      proposal_evidence: [],
      proposed_at: '2026-07-21T00:00:01.000Z',
    });
    store.create(proposed);
    const oldFence = {
      session_id: proposed.session_id,
      run_id: proposed.run_id,
      revision_id: proposed.active_revision_id,
      revision_hash: proposed.active_revision_hash,
      dispatch_generation: 0,
      commit_sequence: 0,
    };
    const drained = store.mutate({
      transition_id: 'old-claim-complete',
      operation: 'complete-node',
      operation_fingerprint: 'old-claim:lease-1',
      expected: oldFence,
      fence_scope: 'pending_patch_base',
    }, (state) => ({ next: state, result: 'drained' }));
    expect(drained.state.commit_sequence).toBe(1);

    const activated = store.mutate({
      transition_id: 'approve-patch',
      operation: 'approve-patch',
      operation_fingerprint: 'approve:patch-1',
      expected: {
        ...oldFence,
        dispatch_generation: 1,
        commit_sequence: 1,
      },
    }, (state) => ({
      next: approveGraphPatch(state, {
        proposal_id: 'patch-1',
        base_revision_id: base.active_revision_id,
        base_revision_hash: base.active_revision_hash,
        proposed_revision_hash: proposedDescriptor.descriptor_hash,
        invalidated_node_ids: [],
        approval_evidence: { kind: 'human', ref: 'approve-patch' },
        approved_at: '2026-07-21T00:00:02.000Z',
      }, (projection) => projection),
      result: 'approved',
    }));
    expect(activated.state.active_revision_id).toBe('revision-2');

    expect(() => store.mutate({
      transition_id: 'late-old-claim',
      operation: 'complete-node',
      operation_fingerprint: 'old-claim:lease-2',
      expected: { ...oldFence, commit_sequence: 2 },
      fence_scope: 'pending_patch_base',
    }, (state) => ({ next: state, result: 'must-not-commit' }))).toThrow(/pending patch/i);
  });
});

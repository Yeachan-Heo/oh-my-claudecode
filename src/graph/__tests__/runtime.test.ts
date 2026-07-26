import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ControlOwnerStore } from '../control-owner.js';
import { sealGraphDescriptor } from '../descriptor.js';
import { occCommitMutation, occReadCurrentState } from '../../lib/mode-state-io.js';
import { graphCommandService } from '../runtime.js';
import { createInitialGraphState } from '../runtime-types.js';
import { GraphStateStore } from '../store.js';
import type { GraphSchedulerProjection } from '../types.js';
import { forkJoinDescriptor } from './fixtures.js';

type ForkJoin = ReturnType<typeof forkJoinDescriptor>;

const temporaryDirectories: string[] = [];
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

// Drop into a fresh temp worktree dir so the runtime's GraphStateStore (which
// resolves against process.cwd() when no worktreeRoot is given) writes into an
// isolated .omc/state tree. The store requires a session-scoped write path.
function useTempWorktree(sessionId: string): { worktree: string; store: GraphStateStore } {
  const worktree = mkdtempSync(join(tmpdir(), 'omc-graph-runtime-'));
  temporaryDirectories.push(worktree);
  mkdirSync(join(worktree, '.omc', 'state', 'sessions', sessionId), { recursive: true });
  process.chdir(worktree);
  const store = new GraphStateStore({
    sessionId,
    worktreeRoot: worktree,
    dependencies: {
      fileExists: existsSync,
      readText: (path) => readFileSync(path, 'utf8'),
      readCurrent: occReadCurrentState,
      occCommit: occCommitMutation,
    },
  });
  return { worktree, store };
}

function linearDescriptor(opts: { reconcile?: boolean; runId?: string; goal?: string } = {}): ForkJoin {
  return {
    descriptor_version: 1,
    run_id: opts.runId ?? 'run-linear',
    revision_id: 'revision-linear',
    goal: opts.goal ?? 'Linear side-effect-free path',
    entry_node_ids: ['start'],
    concurrency_limit: 1,
    terminal_verification_node_id: 'verify',
    nodes: [
      {
        id: 'start', kind: 'agent', title: 'start', instructions: 'Do start',
        timeout_ms: 1_000, max_attempts: 2,
        effect_policy: opts.reconcile ? { policy: 'reconcile' } : { policy: 'side_effect_free' },
      },
      {
        id: 'verify', kind: 'command', title: 'verify', command: 'run-verify',
        timeout_ms: 1_000, max_attempts: 2, effect_policy: { policy: 'side_effect_free' },
      },
    ],
    edges: [{ id: 'start-verify', kind: 'fixed', from: 'start', to: 'verify' }],
  } as unknown as ForkJoin;
}

function seedRunning(sessionId: string, descriptor: ReturnType<typeof sealGraphDescriptor>, startNodeId = 'start', projectionOverride?: GraphSchedulerProjection) {
  const { store } = useTempWorktree(sessionId);
  const startActivationId = `${descriptor.run_id}:act:${startNodeId}:entry`;
  const state = createInitialGraphState({
    session_id: sessionId,
    control_nonce: 'nonce-runtime',
    descriptor,
    status: 'running',
    created_at: '2026-07-21T00:00:00.000Z',
    projection: projectionOverride ?? {
      activations: {
        [startActivationId]: {
          activation_id: startActivationId, node_id: startNodeId, status: 'ready',
          attempt_no: 0, attempt_ids: [], traversal_owner_id: startActivationId,
        },
      },
      cohorts: {}, branch_tokens: {}, traversal_counts: {},
      committed_transitions: {}, terminal_verification_activation_ids: [],
    },
    approval: { approved_at: '2026-07-21T00:00:00.000Z', evidence: { kind: 'human', ref: 'approval-1' } },
  });
  store.create(state);
  return { store, startActivationId };
}

async function exec(operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return graphCommandService.execute({ operation: operation as never, cwd: process.cwd(), input }) as Promise<Record<string, unknown>>;
}

describe('graphCommandService runtime operations', () => {
  it('B6: claims a human-approval node, transitions to waiting_human, and completes with the human answer', async () => {
    const sessionId = 'session-human-approval';
    const descriptor = sealGraphDescriptor(forkJoinDescriptor());
    const { store, startActivationId } = seedRunning(sessionId, descriptor, 'approval');

    const claimed = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 'transition-claim', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };

    const claim = claimed.result.claims[0];
    expect(claim.kind).toBe('human-approval');
    expect(claim.waiting_human).toBe(true);
    expect(claim.activation_id).toBe(startActivationId);

    const afterClaim = store.read()!;
    expect(afterClaim.status).toBe('waiting_human');
    expect(afterClaim.claims[claim.lease_id as string]).toMatchObject({ status: 'live' });

    const completed = await exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 'transition-approve',
      claim: { lease_id: claim.lease_id, activation_id: claim.activation_id, attempt_id: claim.attempt_id },
      result: {
        outcome: 'succeeded',
        evidence_refs: [{ kind: 'human', ref: 'human-answer-yes', summary: 'Operator approved' }],
      },
    }) as { result: { outcome: string; created_activation_ids: string[] } };

    expect(completed.result.outcome).toBe('succeeded');
    expect(completed.result.created_activation_ids).toHaveLength(1);
    const afterComplete = store.read()!;
    expect(afterComplete.claims[claim.lease_id as string].status).toBe('completed');
  });

  it('B2: resolve-join resolves a ready join activation through the runtime', async () => {
    const sessionId = 'session-resolve-join';
    const descriptor = sealGraphDescriptor(forkJoinDescriptor());
    const { store } = seedRunning(sessionId, descriptor, 'approval');

    // approval (human-approval) -> complete -> analyze (fan-out) -> branches -> join
    const ap = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim-approval', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const aClaim = ap.result.claims[0];
    await exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-complete-approval',
      claim: { lease_id: aClaim.lease_id, activation_id: aClaim.activation_id, attempt_id: aClaim.attempt_id },
      result: { outcome: 'succeeded', evidence_refs: [{ kind: 'human', ref: 'ok' }] },
    });

    const az = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      driver_id: 'driver-1', transition_id: 't-claim-analyze', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const zClaim = az.result.claims[0];
    await exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 3,
      transition_id: 't-complete-analyze',
      claim: { lease_id: zClaim.lease_id, activation_id: zClaim.activation_id, attempt_id: zClaim.attempt_id },
      result: { outcome: 'succeeded', evidence_refs: [{ kind: 'command', ref: 'analyze' }] },
    });

    for (const i of [0, 1]) {
      const bc = await exec('claim', {
        session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
        descriptor_hash: descriptor.descriptor_hash, expected_sequence: 4 + i * 2,
        driver_id: 'driver-1', transition_id: `t-claim-branch-${i}`, limit: 1,
      }) as { result: { claims: Array<Record<string, unknown>> } };
      const bClaim = bc.result.claims[0];
      await exec('complete', {
        session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
        descriptor_hash: descriptor.descriptor_hash, expected_sequence: 5 + i * 2,
        transition_id: `t-complete-branch-${i}`,
        claim: { lease_id: bClaim.lease_id, activation_id: bClaim.activation_id, attempt_id: bClaim.attempt_id },
        result: { outcome: 'succeeded', evidence_refs: [{ kind: 'command', ref: `branch-${i}` }] },
        // Completing the second branch fills the cohort and activates the join;
        // supply the join activation identity the scheduler needs at arrival.
        identities: { join_activation_id: `${descriptor.run_id}:act:join-build:resolved` },
      });
    }

    const readyForJoin = await exec('ready', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 8,
    }) as { joins: Array<Record<string, unknown>> };
    expect(readyForJoin.joins).toHaveLength(1);
    const joinActivationId = readyForJoin.joins[0].activation_id as string;

    const resolved = await exec('resolve-join', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 8,
      transition_id: 't-resolve-join',
      activation_id: joinActivationId,
      identities: { next_activation_ids: { 'join-to-verify': `${descriptor.run_id}:act:verify:resolved` } },
    }) as { result: { outcome: string; created_activation_ids: string[] } };

    expect(resolved.result.outcome).toBe('join_resolved');
    expect(resolved.result.created_activation_ids).toHaveLength(1);
    const finalState = store.read()!;
    expect(finalState.projection.activations[joinActivationId].status).toBe('completed');
  });

  it('B3: renew-claim renews a live tracked lease and rejects a mismatched owner', async () => {
    const sessionId = 'session-renew';
    const descriptor = sealGraphDescriptor(linearDescriptor());
    const { store } = seedRunning(sessionId, descriptor, 'start');

    const claimed = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim = claimed.result.claims[0];

    const renewed = await exec('renew-claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-renew',
      lease_id: claim.lease_id, driver_id: 'driver-1', tracking_id: claim.tracking_id,
      tool_still_running: true, now: '2026-07-21T00:00:01.000Z',
    }) as { result: { renewal_count: number } };

    expect(renewed.result.renewal_count).toBe(1);
    const after = store.read()!;
    expect(after.claims[claim.lease_id as string].renewal_count).toBe(1);

    await expect(exec('renew-claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      transition_id: 't-renew-wrong',
      lease_id: claim.lease_id, driver_id: 'driver-other', tracking_id: claim.tracking_id,
      tool_still_running: true, now: '2026-07-21T00:00:01.500Z',
    })).rejects.toThrow(/owner/i);
  });

  it('B3: release-attempt-for-retry returns an activation to ready and fences its claim', async () => {
    const sessionId = 'session-release';
    const descriptor = sealGraphDescriptor(linearDescriptor());
    const { store } = seedRunning(sessionId, descriptor, 'start');

    const claimed = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim = claimed.result.claims[0];

    const released = await exec('release-attempt-for-retry', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-release',
      activation_id: claim.activation_id, attempt_id: claim.attempt_id,
    }) as { result: { released: boolean } };

    expect(released.result.released).toBe(true);
    const after = store.read()!;
    expect(after.projection.activations[claim.activation_id as string].status).toBe('ready');
    expect(after.claims[claim.lease_id as string].status).toBe('fenced');
  });

  it('B3: record-late-claim-result records a bounded diagnostic for a fenced lease', async () => {
    const sessionId = 'session-late';
    const descriptor = sealGraphDescriptor(linearDescriptor());
    const { store } = seedRunning(sessionId, descriptor, 'start');

    const claimed = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim = claimed.result.claims[0];
    // Fence the claim via release-attempt-for-retry so it is no longer live,
    // making it eligible for a late-result diagnostic.
    await exec('release-attempt-for-retry', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-release',
      activation_id: claim.activation_id, attempt_id: claim.attempt_id,
    });

    const late = await exec('record-late-claim-result', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      transition_id: 't-late',
      lease_id: claim.lease_id, attempt_id: claim.attempt_id,
      recorded_at: '2026-07-21T00:00:03.000Z',
      summary: 'old result arrived after release',
    }) as { result: { kind: string; lease_id: string } };

    expect(late.result.kind).toBe('late_result');
    expect(late.result.lease_id).toBe(claim.lease_id);
    const after = store.read()!;
    expect(after.diagnostics.at(-1)).toMatchObject({ kind: 'late_result', lease_id: claim.lease_id });
  });

  it('B3: recover-expired-claim takes over an expired side-effect-free lease', async () => {
    const sessionId = 'session-recover';
    const descriptor = sealGraphDescriptor(linearDescriptor());
    const { store } = seedRunning(sessionId, descriptor, 'start');

    const claimed = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim = claimed.result.claims[0];
    // recoverExpiredGraphClaim requires `now` to be at/after the lease expiry.
    const expiresAt = claim.expires_at as string;
    const recoverNow = new Date(Date.parse(expiresAt) + 1_000).toISOString();

    const recovered = await exec('recover-expired-claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-recover',
      lease_id: claim.lease_id, now: recoverNow,
      new_attempt_id: 'attempt-2', new_lease_id: 'lease-2', new_tracking_id: 'tool-2',
      driver_id: 'driver-2', reconciliation_id: 'reconciliation-1',
    }) as { result: { disposition: string; replacement_lease_id: string } };

    expect(recovered.result.disposition).toBe('taken_over');
    expect(recovered.result.replacement_lease_id).toBe('lease-2');
    const after = store.read()!;
    expect(after.claims['lease-2']).toMatchObject({ status: 'live', attempt_no: 2 });
    expect(after.claims[claim.lease_id as string].status).toBe('expired_retryable');
  });

  it('B5: resolve-reconciliation exits the reconciling phase back to running', async () => {
    const sessionId = 'session-reconcile';
    const descriptor = sealGraphDescriptor(linearDescriptor({ reconcile: true, runId: 'run-reconcile', goal: 'Reconcile-policy path' }));
    const { store, startActivationId } = seedRunning(sessionId, descriptor, 'start');
    // Force the graph into 'reconciling' with an unresolved reconciliation record
    // (as recoverExpiredGraphClaim would for a reconcile-policy claim).
    const leaseId = 'lease-reconcile-1';
    const running = store.read()!;
    const reconcilingState = {
      ...running,
      status: 'reconciling' as const,
      projection: {
        ...running.projection,
        activations: {
          ...running.projection.activations,
          [startActivationId]: {
            ...running.projection.activations[startActivationId],
            status: 'running' as const,
            attempt_no: 1,
            attempt_ids: ['attempt-1'],
            active_attempt_id: 'attempt-1',
          },
        },
      },
      claims: {
        [leaseId]: {
          run_id: running.run_id,
          revision_id: running.active_revision_id,
          revision_hash: running.active_revision_hash,
          dispatch_generation: running.dispatch_generation,
          activation_id: startActivationId,
          attempt_id: 'attempt-1',
          attempt_no: 1,
          claim_owner_session_id: sessionId,
          driver_instance_id: 'driver-1',
          lease_id: leaseId,
          tracking_id: 'tool-1',
          issued_at: '2026-07-21T00:00:00.000Z',
          expires_at: '2026-07-21T00:00:02.000Z',
          lease_duration_ms: 2_000,
          renewal_count: 0,
          max_renewals: 2,
          effect_policy: { policy: 'reconcile' },
          status: 'reconciling' as const,
          fenced_at: '2026-07-21T00:00:02.000Z',
        },
      },
      reconciliations: {
        'reconciliation-1': {
          reconciliation_id: 'reconciliation-1',
          activation_id: startActivationId,
          attempt_id: 'attempt-1',
          lease_id: leaseId,
          revision_id: running.active_revision_id,
          revision_hash: running.active_revision_hash,
          dispatch_generation: running.dispatch_generation,
          status: 'unresolved' as const,
          reason: 'expired_ambiguous' as const,
          created_at: '2026-07-21T00:00:02.000Z',
        },
      },
    } as unknown as typeof running;
    // Publish the externally-recovered reconciling state through the OCC
    // journal (B11/B): the journal is the source of truth, so a direct canonical
    // write would be invisible to the next mutation. Simulate the recovery by
    // committing the reconciling state as a journal entry.
    const storePath = (store as unknown as { path: string }).path;
    occCommitMutation(storePath, () => ({ state: reconcilingState, result: true }));
    // Sanity: the store re-reads the reconciling state.
    expect(store.read()?.status).toBe('reconciling');

    const resolved = await exec('resolve-reconciliation', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      transition_id: 't-resolve-recon',
      evidence: { kind: 'human', ref: 'operator-resolved', summary: 'Operator confirmed no external effect' },
      resolved_at: '2026-07-21T00:00:05.000Z',
    }) as { result: { status: string; resolved_reconciliation_ids: string[] } };

    expect(resolved.result.status).toBe('running');
    expect(resolved.result.resolved_reconciliation_ids).toEqual(['reconciliation-1']);
    const after = store.read()!;
    expect(after.status).toBe('running');
    expect(after.reconciliations['reconciliation-1'].status).toBe('accepted');
  });

  it('non-blocker: create is idempotent only when the descriptor hash matches', async () => {
    const sessionId = 'session-idempotent';
    const descriptor = sealGraphDescriptor(linearDescriptor({ runId: 'run-linear', goal: 'Original goal' }));
    const { worktree, store } = useTempWorktree(sessionId);
    // Seed an existing graph with the SAME run_id/revision_id but a DIFFERENT goal
    // (and therefore a different descriptor hash).
    const otherInput = linearDescriptor({ runId: descriptor.run_id, goal: 'A different goal for hash mismatch' });
    const otherDescriptor = sealGraphDescriptor(otherInput);
    expect(otherDescriptor.run_id).toBe(descriptor.run_id);
    expect(otherDescriptor.revision_id).toBe(descriptor.revision_id);
    expect(otherDescriptor.descriptor_hash).not.toBe(descriptor.descriptor_hash);
    store.create(createInitialGraphState({
      session_id: sessionId,
      control_nonce: 'nonce-idem',
      descriptor: otherDescriptor,
      status: 'running',
      created_at: '2026-07-21T00:00:00.000Z',
      projection: {
        activations: {}, cohorts: {}, branch_tokens: {}, traversal_counts: {},
        committed_transitions: {}, terminal_verification_activation_ids: [],
      },
      approval: { approved_at: '2026-07-21T00:00:00.000Z', evidence: { kind: 'human', ref: 'approve' } },
    }));
    const controls = new ControlOwnerStore({ sessionId, worktreeRoot: worktree });
    controls.reserveRoot({
      mode: 'graph',
      run_id: otherDescriptor.run_id,
      nonce: 'nonce-idem',
      reserved_at: '2026-07-21T00:00:00.000Z',
      graph_revision: { revision_id: otherDescriptor.revision_id, revision_hash: otherDescriptor.descriptor_hash },
    });
    controls.promoteRoot({
      mode: 'graph',
      run_id: otherDescriptor.run_id,
      nonce: 'nonce-idem',
      promoted_at: '2026-07-21T00:00:00.000Z',
      driver_lease: {
        driver_instance_id: 'driver-idem',
        lease_id: 'lease-idem',
        expires_at: '2026-07-21T01:00:00.000Z',
      },
    });

    // create with a different hash must throw hash_mismatch, not silently return.
    await expect(exec('create', {
      goal: descriptor.goal,
      descriptor,
      session_id: sessionId,
      driver_id: 'driver-1',
      transition_id: 't-create-mismatch',
    })).rejects.toThrow(/hash_mismatch/);

    // Re-creating with the exact same descriptor is idempotent.
    const idempotent = await exec('create', {
      goal: otherDescriptor.goal,
      descriptor: otherDescriptor,
      session_id: sessionId,
      driver_id: 'driver-1',
      transition_id: 't-create-idem',
    }) as { run_id: string };
    expect(idempotent.run_id).toBe(otherDescriptor.run_id);
  });

  it('reserves the control root before publishing and leaves no graph when another root owns the session', async () => {
    const sessionId = 'session-create-root-conflict';
    const descriptor = sealGraphDescriptor(linearDescriptor({ runId: 'run-create-root-conflict' }));
    const { worktree, store } = useTempWorktree(sessionId);
    const controls = new ControlOwnerStore({ sessionId, worktreeRoot: worktree });
    controls.reserveRoot({
      mode: 'autopilot',
      run_id: 'autopilot-owner',
      nonce: 'autopilot-nonce',
      reserved_at: '2026-07-21T00:00:00.000Z',
    });

    await expect(exec('create', {
      goal: descriptor.goal,
      descriptor,
      session_id: sessionId,
      driver_id: 'driver-create',
      transition_id: 't-create-conflict',
    })).rejects.toThrow(/root_conflict/i);

    expect(store.read()).toBeNull();
    expect(controls.read()?.root).toMatchObject({
      mode: 'autopilot', run_id: 'autopilot-owner', nonce: 'autopilot-nonce', phase: 'reserved',
    });
  });

  it('reuses only the exact pre-publish graph reservation, then approval promotes that reservation', async () => {
    const sessionId = 'session-create-reservation-retry';
    const descriptor = sealGraphDescriptor(linearDescriptor({ runId: 'run-create-reservation-retry' }));
    const { worktree, store } = useTempWorktree(sessionId);
    const controls = new ControlOwnerStore({ sessionId, worktreeRoot: worktree });
    controls.reserveRoot({
      mode: 'graph',
      run_id: descriptor.run_id,
      nonce: 'crash-before-publish-nonce',
      reserved_at: '2026-07-21T00:00:00.000Z',
      graph_revision: { revision_id: descriptor.revision_id, revision_hash: descriptor.descriptor_hash },
    });

    const created = await exec('create', {
      goal: descriptor.goal,
      descriptor,
      session_id: sessionId,
      driver_id: 'driver-create',
      transition_id: 't-create-retry',
    });
    expect(created.control_nonce).toBe('crash-before-publish-nonce');
    expect(store.read()).toMatchObject({ control_nonce: 'crash-before-publish-nonce', status: 'awaiting_approval' });
    expect(controls.read()?.root).toMatchObject({ nonce: 'crash-before-publish-nonce', phase: 'reserved' });

    await exec('approve', {
      session_id: sessionId,
      run_id: descriptor.run_id,
      revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash,
      transition_id: 't-approve-retried-create',
      approval: {
        approved_at: '2026-07-21T00:00:01.000Z',
        evidence: { kind: 'human', ref: 'operator-approved' },
        driver_id: 'driver-approve',
      },
    });

    expect(controls.read()?.root).toMatchObject({ nonce: 'crash-before-publish-nonce', phase: 'active' });
  });

  it('rolls back only its own reservation when the initial durable publish fails', async () => {
    const sessionId = 'session-create-publish-failure';
    const descriptor = sealGraphDescriptor(linearDescriptor({ runId: 'run-create-publish-failure' }));
    const { worktree, store } = useTempWorktree(sessionId);
    const create = vi.spyOn(GraphStateStore.prototype, 'create').mockImplementationOnce(() => {
      throw new Error('simulated initial publish failure');
    });

    try {
      await expect(exec('create', {
        goal: descriptor.goal,
        descriptor,
        session_id: sessionId,
        driver_id: 'driver-create',
        transition_id: 't-create-publish-failure',
      })).rejects.toThrow(/simulated initial publish failure/);
    } finally {
      create.mockRestore();
    }

    expect(store.read()).toBeNull();
    expect(new ControlOwnerStore({ sessionId, worktreeRoot: worktree }).read()?.root).toBeNull();
  });

  it('returns the exact concurrent publish as an idempotent create success', async () => {
    const sessionId = 'session-create-concurrent-idempotent';
    const descriptor = sealGraphDescriptor(linearDescriptor({ runId: 'run-create-concurrent-idempotent' }));
    const { store } = useTempWorktree(sessionId);
    const originalCreate = GraphStateStore.prototype.create;
    const create = vi.spyOn(GraphStateStore.prototype, 'create').mockImplementationOnce(function(this: GraphStateStore, state: Parameters<GraphStateStore['create']>[0]) {
      originalCreate.call(this, state);
      const raced = new Error('Graph state already exists for this session') as Error & { code: string };
      raced.code = 'already_exists';
      throw raced;
    });

    try {
      const result = await exec('create', {
        goal: descriptor.goal,
        descriptor,
        session_id: sessionId,
        driver_id: 'driver-create',
        transition_id: 't-create-concurrent-idempotent',
      }) as { run_id: string };
      expect(result.run_id).toBe(descriptor.run_id);
    } finally {
      create.mockRestore();
    }

    expect(store.read()).toMatchObject({ run_id: descriptor.run_id, status: 'awaiting_approval' });
    expect(new ControlOwnerStore({ sessionId }).read()?.root).toMatchObject({
      mode: 'graph', run_id: descriptor.run_id, phase: 'reserved',
    });
  });
});

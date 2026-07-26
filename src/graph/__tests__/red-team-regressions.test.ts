import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sealGraphDescriptor } from '../descriptor.js';
import { occCommitMutation, occReadCurrentState } from '../../lib/mode-state-io.js';
import { settleDriverClaims } from '../claims.js';
import { graphCommandService } from '../runtime.js';
import { createInitialGraphState } from '../runtime-types.js';
import { GraphStateStore } from '../store.js';
import type { GraphDescriptorInput, GraphSchedulerProjection } from '../types.js';
import { forkJoinDescriptor } from './fixtures.js';

const temporaryDirectories: string[] = [];
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function useTempWorktree(sessionId: string): { worktree: string; store: GraphStateStore } {
  const worktree = mkdtempSync(join(tmpdir(), 'omc-graph-redteam-'));
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

function linearDescriptor(opts: { runId?: string; revisionId?: string; goal?: string } = {}): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: opts.runId ?? 'run-redteam',
    revision_id: opts.revisionId ?? 'revision-1',
    goal: opts.goal ?? 'Linear red-team path',
    entry_node_ids: ['start'],
    concurrency_limit: 1,
    terminal_verification_node_id: 'verify',
    nodes: [
      {
        id: 'start', kind: 'agent', title: 'start', instructions: 'Do start',
        timeout_ms: 1_000, max_attempts: 2, effect_policy: { policy: 'side_effect_free' },
      },
      {
        id: 'verify', kind: 'command', title: 'verify', command: 'run-verify',
        timeout_ms: 1_000, max_attempts: 2, effect_policy: { policy: 'side_effect_free' },
      },
    ],
    edges: [{ id: 'start-verify', kind: 'fixed', from: 'start', to: 'verify' }],
  };
}

// A second descriptor for patch proposals: same run identity, new revision id,
// same nodes (so no completed-node repurposing), only the goal changes.
function patchedDescriptor(base: GraphDescriptorInput, revisionId: string, goal: string): GraphDescriptorInput {
  return {
    ...base,
    revision_id: revisionId,
    goal,
    nodes: base.nodes.map((node) => ({ ...node })),
    edges: base.edges.map((edge) => ({ ...edge })),
  };
}

function seedRunning(
  sessionId: string,
  descriptor: ReturnType<typeof sealGraphDescriptor>,
  startNodeId = 'start',
  projectionOverride?: GraphSchedulerProjection,
) {
  const { store } = useTempWorktree(sessionId);
  const startActivationId = `${descriptor.run_id}:act:${startNodeId}:entry`;
  const state = createInitialGraphState({
    session_id: sessionId,
    control_nonce: 'nonce-redteam',
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

async function claimOne(
  sessionId: string,
  revisionId: string,
  descriptorHash: string,
  runId: string,
  expectedSeq: number,
  transitionId: string,
  driverId = 'driver-1',
) {
  const claimed = await exec('claim', {
    session_id: sessionId, run_id: runId, revision_id: revisionId,
    descriptor_hash: descriptorHash, expected_sequence: expectedSeq,
    driver_id: driverId, transition_id: transitionId, limit: 1,
  }) as { result: { claims: Array<Record<string, unknown>> } };
  return claimed.result.claims[0];
}

describe('red-team state-machine regressions', () => {
  it('#2: abandon atomically fences live claims and rejects a late completion against the cancelled graph', async () => {
    const sessionId = 'session-abandon-late';
    const descriptor = sealGraphDescriptor(linearDescriptor());
    const { store } = seedRunning(sessionId, descriptor, 'start');

    const claim = await claimOne(sessionId, descriptor.revision_id, descriptor.descriptor_hash, descriptor.run_id, 0, 't-claim');
    const before = store.read()!;
    expect(before.claims[claim.lease_id as string].status).toBe('live');

    // Abandon while the claim is still live (worker still "running").
    await exec('abandon', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-abandon',
      confirmation: { run_id: descriptor.run_id },
    });

    const afterAbandon = store.read()!;
    expect(afterAbandon.status).toBe('cancelled');
    // #2(a): the live claim was atomically fenced in the SAME transition.
    expect(afterAbandon.claims[claim.lease_id as string].status).toBe('fenced');
    expect(afterAbandon.claims[claim.lease_id as string].fenced_at).toBeDefined();

    // #2(b): the worker tries to complete AFTER cancel -> must be rejected before
    // commit (graph is terminal). The terminal-graph gate runs before the claim
    // liveness gate, so the error names the cancelled status, not the claim.
    await expect(exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      transition_id: 't-late-complete',
      claim: { lease_id: claim.lease_id, activation_id: claim.activation_id, attempt_id: claim.attempt_id },
      result: { outcome: 'succeeded', evidence_refs: [{ kind: 'command', ref: 'late' }] },
    })).rejects.toThrow(/cancelled/);

    // The terminal run was not mutated by the late result.
    const afterLate = store.read()!;
    expect(afterLate.commit_sequence).toBe(afterAbandon.commit_sequence);
    expect(afterLate.projection.activations[claim.activation_id as string].status).not.toBe('completed');
  });

  it('#2: fail is also rejected against a cancelled graph before commit', async () => {
    const sessionId = 'session-abandon-late-fail';
    const descriptor = sealGraphDescriptor(linearDescriptor({ runId: 'run-abandon-fail' }));
    const { store } = seedRunning(sessionId, descriptor, 'start');
    const claim = await claimOne(sessionId, descriptor.revision_id, descriptor.descriptor_hash, descriptor.run_id, 0, 't-claim');

    await exec('abandon', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-abandon', confirmation: { run_id: descriptor.run_id },
    });

    await expect(exec('fail', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      transition_id: 't-late-fail',
      claim: { lease_id: claim.lease_id, activation_id: claim.activation_id, attempt_id: claim.attempt_id },
      result: { outcome: 'failed', evidence_refs: [{ kind: 'command', ref: 'late-fail' }] },
    })).rejects.toThrow(/cancelled/);
    expect(store.read()!.status).toBe('cancelled');
  });

  it('#3: settleDriverClaims resets a settled activation to ready (re-claimable) at the claims layer', () => {
    // Mirror recovery.test.ts runningState/claimState to drive settleDriverClaims directly.
    const descriptor = sealGraphDescriptor(forkJoinDescriptor());
    const running = createInitialGraphState({
      session_id: 'session-settle-claims',
      control_nonce: 'control-settle',
      descriptor,
      status: 'running',
      created_at: '2026-07-21T00:00:00.000Z',
      projection: {
        activations: {
          activation: {
            activation_id: 'activation', node_id: 'analyze', status: 'running',
            attempt_no: 1, attempt_ids: ['attempt-1'], active_attempt_id: 'attempt-1',
            traversal_owner_id: 'root',
          },
        },
        cohorts: {}, branch_tokens: {}, traversal_counts: {},
        committed_transitions: {}, terminal_verification_activation_ids: [],
      },
      approval: { approved_at: '2026-07-21T00:00:00.000Z', evidence: { kind: 'human', ref: 'approval' } },
    });
    // Issue a live claim on the running activation.
    const live = {
      ...running,
      claims: {
        'lease-1': {
          run_id: running.run_id,
          revision_id: running.active_revision_id,
          revision_hash: running.active_revision_hash,
          dispatch_generation: running.dispatch_generation,
          activation_id: 'activation',
          attempt_id: 'attempt-1',
          attempt_no: 1,
          claim_owner_session_id: running.session_id,
          driver_instance_id: 'driver-1',
          lease_id: 'lease-1',
          tracking_id: 'tool-1',
          issued_at: '2026-07-21T00:00:00.000Z',
          expires_at: '2026-07-21T00:01:00.000Z',
          lease_duration_ms: 60_000,
          renewal_count: 0,
          max_renewals: 2,
          effect_policy: { policy: 'side_effect_free' },
          status: 'live' as const,
        },
      },
    } as unknown as typeof running;

    const settled = settleDriverClaims(live, {
      claim_owner_session_id: 'session-settle-claims',
      driver_instance_id: 'driver-1',
      recorded_at: '2026-07-21T00:00:01.000Z',
    });

    // The claim is fenced abandoned_retryable...
    expect(settled.state.claims['lease-1'].status).toBe('abandoned_retryable');
    // ...AND the activation was atomically returned to 'ready' (re-claimable),
    // so the work is not permanently lost after SessionEnd.
    expect(settled.state.projection.activations.activation.status).toBe('ready');
    expect(settled.state.projection.activations.activation.active_attempt_id).toBeUndefined();
    // Attempt history is preserved (the abandoned attempt is still in the log).
    expect(settled.state.projection.activations.activation.attempt_ids).toEqual(['attempt-1']);
  });

  it('#3: after settle-session, a worker can re-claim the previously-stranded activation', async () => {
    const sessionId = 'session-settle-reclaim';
    const descriptor = sealGraphDescriptor(linearDescriptor({ runId: 'run-settle-reclaim' }));
    const { store, startActivationId } = seedRunning(sessionId, descriptor, 'start');

    const claim = await claimOne(sessionId, descriptor.revision_id, descriptor.descriptor_hash, descriptor.run_id, 0, 't-claim');
    expect(store.read()!.projection.activations[startActivationId].status).toBe('running');

    // SessionEnd settles the worker's live claim.
    await exec('settle-session', {
      session_id: sessionId, driver_id: 'driver-1', transition_id: 't-settle',
    });
    const afterSettle = store.read()!;
    expect(afterSettle.claims[claim.lease_id as string].status).toBe('abandoned_retryable');
    // #3: the activation is back to 'ready' -> the work is re-claimable, not lost.
    expect(afterSettle.projection.activations[startActivationId].status).toBe('ready');

    // A new driver can claim the same activation and complete it.
    const reclaimed = await claimOne(sessionId, descriptor.revision_id, descriptor.descriptor_hash, descriptor.run_id, afterSettle.commit_sequence, 't-reclaim', 'driver-2');
    expect(reclaimed.activation_id).toBe(startActivationId);
    expect(store.read()!.claims[reclaimed.lease_id as string].status).toBe('live');

    const completed = await exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash,
      expected_sequence: afterSettle.commit_sequence + 1,
      transition_id: 't-complete',
      claim: { lease_id: reclaimed.lease_id, activation_id: reclaimed.activation_id, attempt_id: reclaimed.attempt_id },
      result: { outcome: 'succeeded', evidence_refs: [{ kind: 'command', ref: 'redone' }] },
    }) as { result: { outcome: string } };
    expect(completed.result.outcome).toBe('succeeded');
    expect(store.read()!.projection.activations[startActivationId].status).toBe('completed');
  });

  it('#4: dispatch_generation fence is threaded through active-scope ops across a full patch cycle', async () => {
    const sessionId = 'session-gen-thread';
    const baseInput = linearDescriptor({ runId: 'run-gen' });
    const descriptor = sealGraphDescriptor(baseInput);
    const { store } = seedRunning(sessionId, descriptor, 'start');

    // Generation 0: claim + complete start (active-scope fence must accept gen 0).
    const startClaim = await claimOne(sessionId, descriptor.revision_id, descriptor.descriptor_hash, descriptor.run_id, 0, 't-claim-start');
    await exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-complete-start',
      claim: { lease_id: startClaim.lease_id, activation_id: startClaim.activation_id, attempt_id: startClaim.attempt_id },
      result: { outcome: 'succeeded', evidence_refs: [{ kind: 'command', ref: 'start' }] },
    });
    const verifyActivationId = Object.values(store.read()!.projection.activations)
      .find((activation) => activation.node_id === 'verify')!.activation_id;

    // First patch cycle: propose (gen 0 -> 1) then approve. No live claims at approve time.
    const patch1 = sealGraphDescriptor(patchedDescriptor(baseInput, 'revision-2', 'Patched goal v1'));
    await exec('propose-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: descriptor.revision_id,
      base_descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      transition_id: 't-propose-1', patch: { proposed_descriptor: patch1, invalidated_node_ids: [], proposal_evidence: [] },
    });
    await exec('approve-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: descriptor.revision_id,
      base_descriptor_hash: descriptor.descriptor_hash, expected_sequence: 3,
      transition_id: 't-approve-1',
      approval: {
        proposed_revision_hash: patch1.descriptor_hash, invalidated_node_ids: [],
        evidence: { kind: 'human', ref: 'approve-patch-1' },
      },
    });
    const afterPatch1 = store.read()!;
    expect(afterPatch1.dispatch_generation).toBe(1);
    expect(afterPatch1.active_revision_id).toBe('revision-2');
    // Old-claim drain: the completed start claim must NOT conflict on generation
    // (it was completed at gen 0; the post-approval graph is at gen 1).
    expect(afterPatch1.claims[startClaim.lease_id as string].status).toBe('completed');

    // Post-approval execution at generation 1: claim + complete verify. A
    // hardcoded-0 fence here would throw dispatch_generation_conflict.
    const verifyClaim = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: 'revision-2',
      descriptor_hash: patch1.descriptor_hash, expected_sequence: 4,
      driver_id: 'driver-1', transition_id: 't-claim-verify', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const vClaim = verifyClaim.result.claims[0];
    expect(vClaim.activation_id).toBe(verifyActivationId);

    const verifyComplete = await exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: 'revision-2',
      descriptor_hash: patch1.descriptor_hash, expected_sequence: 5,
      transition_id: 't-complete-verify',
      claim: { lease_id: vClaim.lease_id, activation_id: vClaim.activation_id, attempt_id: vClaim.attempt_id },
      result: { outcome: 'succeeded', evidence_refs: [{ kind: 'command', ref: 'verify' }] },
    }) as { result: { succeeded: boolean } };
    // The terminal node completed with evidence -> the projection is logically
    // succeeded (the runtime surfaces this as result.succeeded; the graph status
    // stays 'running' - it is not auto-promoted to a terminal status here).
    expect(verifyComplete.result.succeeded).toBe(true);

    // Second patch cycle: propose off revision-2 at gen 1 (-> gen 2). A
    // hardcoded-0 propose-patch fence would throw dispatch_generation_conflict
    // here because the active generation is now 1. The graph is still 'running',
    // so the propose must be accepted (no live claims at propose time).
    const patch2 = sealGraphDescriptor(patchedDescriptor(baseInput, 'revision-3', 'Patched goal v2'));
    await exec('propose-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: 'revision-2',
      base_descriptor_hash: patch1.descriptor_hash, expected_sequence: 6,
      transition_id: 't-propose-2',
      patch: { proposed_descriptor: patch2, invalidated_node_ids: [], proposal_evidence: [] },
    });
    await exec('approve-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: 'revision-2',
      base_descriptor_hash: patch1.descriptor_hash, expected_sequence: 7,
      transition_id: 't-approve-2',
      approval: {
        proposed_revision_hash: patch2.descriptor_hash, invalidated_node_ids: [],
        evidence: { kind: 'human', ref: 'approve-patch-2' },
      },
    });
    const afterCycle2 = store.read()!;
    expect(afterCycle2.dispatch_generation).toBe(2);
    expect(afterCycle2.active_revision_id).toBe('revision-3');
  });

  it('#4: second patch cycle on a paused-then-resumed graph fences at base_generation>=1', async () => {
    const sessionId = 'session-gen-second-cycle';
    const baseInput = linearDescriptor({ runId: 'run-gen-2' });
    const descriptor = sealGraphDescriptor(baseInput);
    const { store } = seedRunning(sessionId, descriptor, 'start');

    // Cycle 1: patch (gen 0->1) without claiming anything.
    const patch1 = sealGraphDescriptor(patchedDescriptor(baseInput, 'revision-2', 'Patched goal v1'));
    await exec('propose-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: descriptor.revision_id,
      base_descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      transition_id: 't-propose-1', patch: { proposed_descriptor: patch1, invalidated_node_ids: [], proposal_evidence: [] },
    });
    await exec('approve-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: descriptor.revision_id,
      base_descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-approve-1',
      approval: {
        proposed_revision_hash: patch1.descriptor_hash, invalidated_node_ids: [],
        evidence: { kind: 'human', ref: 'approve-patch-1' },
      },
    });
    expect(store.read()!.dispatch_generation).toBe(1);

    // Claim + complete start at gen 1 (post-approval execution). The active
    // revision is now revision-2; claim fence uses gen 1.
    const startClaim = await claimOne(sessionId, 'revision-2', patch1.descriptor_hash, descriptor.run_id, 2, 't-claim-start');
    await exec('complete', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: 'revision-2',
      descriptor_hash: patch1.descriptor_hash, expected_sequence: 3,
      transition_id: 't-complete-start',
      claim: { lease_id: startClaim.lease_id, activation_id: startClaim.activation_id, attempt_id: startClaim.attempt_id },
      result: { outcome: 'succeeded', evidence_refs: [{ kind: 'command', ref: 'start' }] },
    });

    // Cycle 2: second patch off revision-2 at gen 1 (-> gen 2). A hardcoded-0
    // propose-patch fence would throw dispatch_generation_conflict here.
    const patch2 = sealGraphDescriptor(patchedDescriptor(baseInput, 'revision-3', 'Patched goal v2'));
    await exec('propose-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: 'revision-2',
      base_descriptor_hash: patch1.descriptor_hash, expected_sequence: 4,
      transition_id: 't-propose-2', patch: { proposed_descriptor: patch2, invalidated_node_ids: [], proposal_evidence: [] },
    });
    await exec('approve-patch', {
      session_id: sessionId, run_id: descriptor.run_id, base_revision_id: 'revision-2',
      base_descriptor_hash: patch1.descriptor_hash, expected_sequence: 5,
      transition_id: 't-approve-2',
      approval: {
        proposed_revision_hash: patch2.descriptor_hash, invalidated_node_ids: [],
        evidence: { kind: 'human', ref: 'approve-patch-2' },
      },
    });
    const afterCycle2 = store.read()!;
    expect(afterCycle2.dispatch_generation).toBe(2);
    expect(afterCycle2.active_revision_id).toBe('revision-3');
  });

  it('#5: human-approval claim returns the persisted lease expiry, not the issue timestamp', async () => {
    const sessionId = 'session-human-expiry';
    const descriptor = sealGraphDescriptor(forkJoinDescriptor());
    const { store } = seedRunning(sessionId, descriptor, 'approval');

    const claimed = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim = claimed.result.claims[0];
    expect(claim.kind).toBe('human-approval');

    const persisted = store.read()!.claims[claim.lease_id as string];
    // The returned expires_at must equal the persisted claim's lease expiry, and
    // must NOT equal the issued_at timestamp (the #5 bug).
    expect(claim.expires_at).toBe(persisted.expires_at);
    expect(claim.expires_at).not.toBe(persisted.issued_at);
    // The lease expiry is issued_at + HUMAN_APPROVAL_LEASE_MS (1h).
    expect(Date.parse(claim.expires_at as string)).toBe(
      Date.parse(persisted.issued_at) + 60 * 60 * 1000,
    );
  });
});

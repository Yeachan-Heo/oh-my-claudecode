import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sealGraphDescriptor } from '../descriptor.js';
import { graphCommandService } from '../runtime.js';
import { createInitialGraphState } from '../runtime-types.js';
import { GraphStateStore } from '../store.js';
import {
  GraphSchedulerError,
  applyNodeResult,
  beginActivationAttempt,
  initializeGraphProjection,
  isGraphSucceeded,
  listReadyExecutableActivations,
  releaseAttemptForRetry,
} from '../index.js';
import type { GraphDescriptorInput, GraphSchedulerProjection } from '../types.js';

// A descriptor whose entry agent node has a tunable max_attempts. The node has
// a single fixed edge to a terminal verification node so we can drive the
// scheduler through claim/fail/reclaim without involving joins or back-edges.
function retryDescriptor(maxAttempts: number): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: `run-retry-${maxAttempts}`,
    revision_id: `revision-retry-${maxAttempts}`,
    goal: `Retry a failing agent node with max_attempts ${maxAttempts}`,
    entry_node_ids: ['start'],
    concurrency_limit: 1,
    terminal_verification_node_id: 'verify',
    nodes: [
      {
        id: 'start', kind: 'agent', title: 'start', instructions: 'Do start',
        timeout_ms: 1_000, max_attempts: maxAttempts,
        effect_policy: { policy: 'side_effect_free' },
      },
      {
        id: 'verify', kind: 'command', title: 'verify', command: 'run-verify',
        timeout_ms: 1_000, max_attempts: 2, effect_policy: { policy: 'side_effect_free' },
      },
    ],
    edges: [{ id: 'start-verify', kind: 'fixed', from: 'start', to: 'verify' }],
  };
}

describe('A2: beginActivationAttempt enforces max_attempts', () => {
  it('throws max_attempts_exceeded when a release+reclaim would exceed the bound', () => {
    const descriptor = sealGraphDescriptor(retryDescriptor(1));
    let projection = initializeGraphProjection(descriptor, { start: 'act-start' });

    // Attempt 1: within bound (attempt_no 1 <= max_attempts 1).
    projection = beginActivationAttempt(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-1', max_attempts: 1,
    });
    expect(projection.activations['act-start'].attempt_no).toBe(1);

    // Release the attempt (returns the activation to 'ready'); then reclaiming
    // must be refused because attempt_no would become 2 > max_attempts 1.
    projection = releaseAttemptForRetry(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-1',
    });
    expect(projection.activations['act-start'].status).toBe('ready');

    let thrown: unknown;
    try {
      beginActivationAttempt(projection, {
        activation_id: 'act-start', attempt_id: 'attempt-2', max_attempts: 1,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GraphSchedulerError);
    expect((thrown as GraphSchedulerError).code).toBe('max_attempts_exceeded');
    expect(String((thrown as GraphSchedulerError).message)).toMatch(/exceeds max_attempts/);
  });

  it('does not throw before the bound is reached and allows a second begin under max_attempts 2', () => {
    const descriptor = sealGraphDescriptor(retryDescriptor(2));
    let projection = initializeGraphProjection(descriptor, { start: 'act-start' });

    projection = beginActivationAttempt(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-1', max_attempts: 2,
    });
    projection = releaseAttemptForRetry(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-1',
    });
    // attempt_no 2 is still within max_attempts 2, so the begin succeeds.
    projection = beginActivationAttempt(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-2', max_attempts: 2,
    });
    expect(projection.activations['act-start'].attempt_no).toBe(2);

    // A third begin (reclaim) now exceeds the bound.
    projection = releaseAttemptForRetry(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-2',
    });
    let thrown: unknown;
    try {
      beginActivationAttempt(projection, {
        activation_id: 'act-start', attempt_id: 'attempt-3', max_attempts: 2,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GraphSchedulerError);
    expect((thrown as GraphSchedulerError).code).toBe('max_attempts_exceeded');
  });
});
describe('A3: applyNodeResult makes a failed activation retryable or terminal-failed', () => {
  function failAttempt(
    descriptor: ReturnType<typeof sealGraphDescriptor>,
    projection: ReturnType<typeof initializeGraphProjection>,
    activationId: string,
    attemptId: string,
    transitionId: string,
  ) {
    return applyNodeResult(descriptor, projection, {
      activation_id: activationId,
      transition_id: transitionId,
      result: { outcome: 'failed', attempt_id: attemptId, evidence_refs: [] },
    });
  }

  it('returns a failed activation to ready while attempt budget remains (retryable)', () => {
    const descriptor = sealGraphDescriptor(retryDescriptor(2));
    let projection = initializeGraphProjection(descriptor, { start: 'act-start' });
    projection = beginActivationAttempt(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-1', max_attempts: 2,
    });

    const failed = failAttempt(descriptor, projection, 'act-start', 'attempt-1', 't-fail-1');
    // attempt_no 1 < max_attempts 2 -> retryable: back to 'ready', not 'failed'.
    expect(failed.projection.activations['act-start'].status).toBe('ready');
    // The activation must be re-claimable (ready executable list includes it).
    expect(listReadyExecutableActivations(descriptor, failed.projection).map((a) => a.activation_id))
      .toContain('act-start');
    // Not terminal: the graph is not succeeded.
    expect(isGraphSucceeded(descriptor, failed.projection)).toBe(false);
  });

  it('marks the activation terminal-failed once the budget is exhausted', () => {
    const descriptor = sealGraphDescriptor(retryDescriptor(1));
    let projection = initializeGraphProjection(descriptor, { start: 'act-start' });
    projection = beginActivationAttempt(projection, {
      activation_id: 'act-start', attempt_id: 'attempt-1', max_attempts: 1,
    });

    const failed = failAttempt(descriptor, projection, 'act-start', 'attempt-1', 't-fail-1');
    // attempt_no 1 >= max_attempts 1 -> exhausted -> terminal 'failed'.
    expect(failed.projection.activations['act-start'].status).toBe('failed');
    // A terminal-failed activation is neither claimable nor retryable.
    expect(listReadyExecutableActivations(descriptor, failed.projection).map((a) => a.activation_id))
      .not.toContain('act-start');
    expect(isGraphSucceeded(descriptor, failed.projection)).toBe(false);
  });
});

describe('A3: runtime promotes the graph to failed when an exhausted node fails', () => {
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
  // isolated .omc/state tree. Uses the store's default fs dependencies.
  function seedRunning(sessionId: string, descriptor: ReturnType<typeof sealGraphDescriptor>) {
    const worktree = mkdtempSync(join(tmpdir(), 'omc-graph-maxattempts-'));
    temporaryDirectories.push(worktree);
    mkdirSync(join(worktree, '.omc', 'state', 'sessions', sessionId), { recursive: true });
    process.chdir(worktree);
    const store = new GraphStateStore({ sessionId, worktreeRoot: worktree });
    const startActivationId = `${descriptor.run_id}:act:start:entry`;
    const state = createInitialGraphState({
      session_id: sessionId,
      control_nonce: 'nonce-max-attempts',
      descriptor,
      status: 'running',
      created_at: '2026-07-21T00:00:00.000Z',
      projection: {
        activations: {
          [startActivationId]: {
            activation_id: startActivationId, node_id: 'start', status: 'ready',
            attempt_no: 0, attempt_ids: [], traversal_owner_id: startActivationId,
          },
        },
        cohorts: {}, branch_tokens: {}, traversal_counts: {},
        committed_transitions: {}, terminal_verification_activation_ids: [],
      } as GraphSchedulerProjection,
      approval: { approved_at: '2026-07-21T00:00:00.000Z', evidence: { kind: 'human', ref: 'approval-1' } },
    });
    store.create(state);
    return { store, startActivationId };
  }

  async function exec(operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return graphCommandService.execute({ operation: operation as never, cwd: process.cwd(), input }) as Promise<Record<string, unknown>>;
  }

  it('max_attempts:1 - a single failure reaches terminal graph status failed (no wedge)', async () => {
    const sessionId = 'session-max-1';
    const descriptor = sealGraphDescriptor(retryDescriptor(1));
    const { store } = seedRunning(sessionId, descriptor);

    const claimed = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim = claimed.result.claims[0];

    await exec('fail', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-fail',
      claim: { lease_id: claim.lease_id, activation_id: claim.activation_id, attempt_id: claim.attempt_id },
      result: {
        outcome: 'failed',
        evidence_refs: [{ kind: 'command', ref: 'start-failed', summary: 'first attempt failed' }],
      },
    });

    const after = store.read()!;
    // Budget exhausted on a max_attempts:1 node -> graph promoted to 'failed'.
    expect(after.status).toBe('failed');
    expect(after.projection.activations[claim.activation_id as string].status).toBe('failed');

    // Terminal guard: a subsequent claim against the failed graph is refused
    // (the store's OCC wrapper surfaces a commit failure; the inner status
    // fence / sequence fence rejects the terminal graph regardless).
    await expect(exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      driver_id: 'driver-1', transition_id: 't-claim-2', limit: 1,
    })).rejects.toThrow();
    // The graph stays terminal-failed after the rejected claim attempt.
    expect(store.read()!.status).toBe('failed');
  });

  it('max_attempts:2 - first failure stays retryable, second failure promotes to failed', async () => {
    const sessionId = 'session-max-2';
    const descriptor = sealGraphDescriptor(retryDescriptor(2));
    const { store } = seedRunning(sessionId, descriptor);

    // Attempt 1: claim, then fail -> still retryable (budget remains), graph stays running.
    const claimed1 = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 0,
      driver_id: 'driver-1', transition_id: 't-claim-1', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim1 = claimed1.result.claims[0];

    await exec('fail', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 1,
      transition_id: 't-fail-1',
      claim: { lease_id: claim1.lease_id, activation_id: claim1.activation_id, attempt_id: claim1.attempt_id },
      result: {
        outcome: 'failed',
        evidence_refs: [{ kind: 'command', ref: 'start-failed-1', summary: 'first attempt failed' }],
      },
    });

    const afterFirst = store.read()!;
    expect(afterFirst.status).toBe('running');
    // Retryable: activation back to 'ready' (not 'failed').
    expect(afterFirst.projection.activations[claim1.activation_id as string].status).toBe('ready');

    // Attempt 2: reclaim the ready activation, then fail again -> now exhausted -> graph 'failed'.
    const claimed2 = await exec('claim', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 2,
      driver_id: 'driver-1', transition_id: 't-claim-2', limit: 1,
    }) as { result: { claims: Array<Record<string, unknown>> } };
    const claim2 = claimed2.result.claims[0];

    await exec('fail', {
      session_id: sessionId, run_id: descriptor.run_id, revision_id: descriptor.revision_id,
      descriptor_hash: descriptor.descriptor_hash, expected_sequence: 3,
      transition_id: 't-fail-2',
      claim: { lease_id: claim2.lease_id, activation_id: claim2.activation_id, attempt_id: claim2.attempt_id },
      result: {
        outcome: 'failed',
        evidence_refs: [{ kind: 'command', ref: 'start-failed-2', summary: 'second attempt failed' }],
      },
    });

    const afterSecond = store.read()!;
    expect(afterSecond.status).toBe('failed');
    expect(afterSecond.projection.activations[claim1.activation_id as string].status).toBe('failed');
  });
});

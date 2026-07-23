import { describe, expect, it } from 'vitest';

import {
  GraphSchedulerError,
  applyNodeResult,
  beginActivationAttempt,
  initializeGraphProjection,
  isGraphSucceeded,
  listReadyExecutableActivations,
  listReadyJoinActivations,
  releaseAttemptForRetry,
  resolveJoin,
  sealGraphDescriptor,
} from '../index.js';
import type {
  GraphEvidenceReference,
  GraphSchedulerProjection,
  SchedulerTransitionIdentities,
} from '../types.js';
import { forkJoinDescriptor, loopDescriptor } from './fixtures.js';

function begin(
  projection: GraphSchedulerProjection,
  activationId: string,
  attemptId: string,
): GraphSchedulerProjection {
  return beginActivationAttempt(projection, {
    activation_id: activationId,
    attempt_id: attemptId,
  });
}

function succeed(
  descriptor: ReturnType<typeof sealGraphDescriptor>,
  projection: GraphSchedulerProjection,
  activationId: string,
  attemptId: string,
  transitionId: string,
  identities: SchedulerTransitionIdentities = {},
  route?: string,
  evidenceRefs: GraphEvidenceReference[] = [],
) {
  return applyNodeResult(descriptor, projection, {
    activation_id: activationId,
    transition_id: transitionId,
    result: {
      outcome: 'succeeded',
      attempt_id: attemptId,
      evidence_refs: evidenceRefs,
      ...(route ? { route } : {}),
    },
    identities,
  });
}

describe('graph scheduler', () => {
  it('retries under one activation and gives each attempt a distinct identity', () => {
    const descriptor = sealGraphDescriptor(loopDescriptor());
    let projection = initializeGraphProjection(descriptor, {
      start: 'activation-start',
    });
    projection = begin(projection, 'activation-start', 'attempt-1');
    projection = releaseAttemptForRetry(projection, {
      activation_id: 'activation-start',
      attempt_id: 'attempt-1',
    });
    projection = begin(projection, 'activation-start', 'attempt-2');

    expect(projection.activations['activation-start']).toMatchObject({
      activation_id: 'activation-start',
      attempt_no: 2,
      active_attempt_id: 'attempt-2',
      attempt_ids: ['attempt-1', 'attempt-2'],
    });
  });

  it('fails closed on an undeclared route and enforces a back-edge bound per lineage', () => {
    const descriptor = sealGraphDescriptor(loopDescriptor());
    let projection = initializeGraphProjection(descriptor, { start: 'a-start' });
    projection = begin(projection, 'a-start', 'try-start');
    projection = succeed(descriptor, projection, 'a-start', 'try-start', 't-start', {
      next_activation_ids: { 'start-test': 'a-test-1' },
    }).projection;

    projection = begin(projection, 'a-test-1', 'try-test-1');
    expect(() =>
      succeed(descriptor, projection, 'a-test-1', 'try-test-1', 'bad-route', {}, 'unknown'),
    ).toThrow(/undeclared route/i);

    projection = succeed(
      descriptor,
      projection,
      'a-test-1',
      'try-test-1',
      't-test-1',
      { next_activation_ids: { 'test-fail': 'a-fix-1' } },
      'fail',
    ).projection;
    projection = begin(projection, 'a-fix-1', 'try-fix-1');
    projection = succeed(
      descriptor,
      projection,
      'a-fix-1',
      'try-fix-1',
      't-fix-1',
      { next_activation_ids: { 'retry-test': 'a-test-2' } },
      'retry',
    ).projection;
    projection = begin(projection, 'a-test-2', 'try-test-2');
    projection = succeed(
      descriptor,
      projection,
      'a-test-2',
      'try-test-2',
      't-test-2',
      { next_activation_ids: { 'test-fail': 'a-fix-2' } },
      'fail',
    ).projection;
    projection = begin(projection, 'a-fix-2', 'try-fix-2');
    projection = succeed(
      descriptor,
      projection,
      'a-fix-2',
      'try-fix-2',
      't-fix-2',
      { next_activation_ids: { 'retry-test': 'a-test-3' } },
      'retry',
    ).projection;
    projection = begin(projection, 'a-test-3', 'try-test-3');
    projection = succeed(
      descriptor,
      projection,
      'a-test-3',
      'try-test-3',
      't-test-3',
      { next_activation_ids: { 'test-fail': 'a-fix-3' } },
      'fail',
    ).projection;
    projection = begin(projection, 'a-fix-3', 'try-fix-3');

    expect(() =>
      succeed(
        descriptor,
        projection,
        'a-fix-3',
        'try-fix-3',
        't-fix-3',
        { next_activation_ids: { 'retry-test': 'a-test-4' } },
        'retry',
      ),
    ).toThrow(/traversal bound/i);
  });

  it('creates a selected fan-out cohort and consumes its branch tokens once at join', () => {
    const descriptor = sealGraphDescriptor(forkJoinDescriptor());
    let projection = initializeGraphProjection(descriptor, { approval: 'act-approval' });
    expect(listReadyExecutableActivations(descriptor, projection).map((item) => item.node_id))
      .toEqual(['approval']);
    projection = begin(projection, 'act-approval', 'try-approval');
    projection = succeed(
      descriptor,
      projection,
      'act-approval',
      'try-approval',
      'transition-approval',
      { next_activation_ids: { 'approval-to-analyze': 'act-analyze' } },
    ).projection;
    expect(listReadyExecutableActivations(descriptor, projection).map((item) => item.node_id))
      .toEqual(['analyze']);
    projection = begin(projection, 'act-analyze', 'try-analyze');
    projection = succeed(
      descriptor,
      projection,
      'act-analyze',
      'try-analyze',
      'transition-analyze',
      {
        cohort_id: 'cohort-build',
        next_activation_ids: { 'fan-a': 'act-a', 'fan-b': 'act-b' },
        branch_token_ids: { 'fan-a': 'token-a', 'fan-b': 'token-b' },
      },
    ).projection;

    expect(listReadyExecutableActivations(descriptor, projection).map((item) => item.activation_id))
      .toEqual(['act-a', 'act-b']);
    expect(projection.cohorts['cohort-build'].expected_branch_token_ids).toEqual([
      'token-a',
      'token-b',
    ]);

    projection = begin(projection, 'act-a', 'try-a');
    projection = succeed(
      descriptor,
      projection,
      'act-a',
      'try-a',
      'transition-a',
    ).projection;
    expect(listReadyJoinActivations(descriptor, projection)).toEqual([]);

    projection = begin(projection, 'act-b', 'try-b');
    const completedB = succeed(
      descriptor,
      projection,
      'act-b',
      'try-b',
      'transition-b',
      { join_activation_id: 'act-join' },
    );
    projection = completedB.projection;
    expect(listReadyJoinActivations(descriptor, projection).map((item) => item.activation_id))
      .toEqual(['act-join']);

    const replay = succeed(
      descriptor,
      projection,
      'act-b',
      'try-b',
      'transition-b',
      { join_activation_id: 'act-join' },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.projection).toBe(projection);
    expect(() =>
      succeed(
        descriptor,
        projection,
        'act-b',
        'try-b',
        'transition-b',
        { join_activation_id: 'different-id' },
      ),
    ).toThrow(/fingerprint/i);

    const joined = resolveJoin(descriptor, projection, {
      activation_id: 'act-join',
      transition_id: 'transition-join',
      identities: { next_activation_ids: { 'join-to-verify': 'act-verify' } },
    });
    projection = joined.projection;
    expect(projection.branch_tokens['token-a'].status).toBe('consumed');
    expect(projection.branch_tokens['token-b'].status).toBe('consumed');
    const joinReplay = resolveJoin(descriptor, projection, {
      activation_id: 'act-join',
      transition_id: 'transition-join',
      identities: { next_activation_ids: { 'join-to-verify': 'act-verify' } },
    });
    expect(joinReplay.replayed).toBe(true);
    expect(() =>
      resolveJoin(descriptor, projection, {
        activation_id: 'act-join',
        transition_id: 'transition-join',
        identities: { next_activation_ids: { 'join-to-verify': 'different-verify' } },
      }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      resolveJoin(descriptor, projection, {
        activation_id: 'act-join',
        transition_id: 'another-transition',
        identities: { next_activation_ids: { 'join-to-verify': 'other-verify' } },
      }),
    ).toThrow(GraphSchedulerError);

    projection = begin(projection, 'act-verify', 'try-verify');
    projection = succeed(
      descriptor,
      projection,
      'act-verify',
      'try-verify',
      'transition-verify',
      {},
      undefined,
      [{ kind: 'test', ref: 'npm-test', summary: 'All checks passed' }],
    ).projection;
    expect(isGraphSucceeded(descriptor, projection)).toBe(true);
  });

  it('does not report success while runnable work remains', () => {
    const descriptor = sealGraphDescriptor(forkJoinDescriptor());
    const projection = initializeGraphProjection(descriptor, { approval: 'act-approval' });

    expect(isGraphSucceeded(descriptor, projection)).toBe(false);
  });

  it('requires evidence for terminal success and keeps terminal failure non-successful', () => {
    const descriptor = sealGraphDescriptor(loopDescriptor());
    let projection = initializeGraphProjection(descriptor, { start: 'act-start' });
    projection = begin(projection, 'act-start', 'try-start');
    projection = succeed(descriptor, projection, 'act-start', 'try-start', 'transition-start', {
      next_activation_ids: { 'start-test': 'act-test' },
    }).projection;
    projection = begin(projection, 'act-test', 'try-test');
    projection = succeed(
      descriptor,
      projection,
      'act-test',
      'try-test',
      'transition-test',
      { next_activation_ids: { 'test-pass': 'act-verify' } },
      'pass',
    ).projection;
    projection = begin(projection, 'act-verify', 'try-verify');

    expect(() =>
      succeed(
        descriptor,
        projection,
        'act-verify',
        'try-verify',
        'transition-no-evidence',
      ),
    ).toThrow(/fresh evidence/i);

    const failed = applyNodeResult(descriptor, projection, {
      activation_id: 'act-verify',
      transition_id: 'transition-failed-verify',
      result: {
        outcome: 'failed',
        attempt_id: 'try-verify',
        output_summary: 'Verification failed',
        evidence_refs: [{ kind: 'test', ref: 'npm-test', summary: 'One test failed' }],
      },
    });
    expect(failed.projection.activations['act-verify'].status).toBe('failed');
    expect(isGraphSucceeded(descriptor, failed.projection)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  applyNodeResult,
  beginActivationAttempt,
  initializeGraphProjection,
  sealGraphDescriptor,
} from '../index.js';
import { createInitialGraphState, parseGraphState } from '../runtime-types.js';
import type { GraphEvidenceReference, GraphSchedulerProjection, SchedulerTransitionIdentities } from '../types.js';
import { loopDescriptor } from './fixtures.js';

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

// Drive the loop descriptor through one full back-edge traversal of `retry-test`
// (start -> test --fail--> remediate --retry--> test), leaving the back-edge still
// traversable (max_traversals = 2, count = 1) so a second traversal is legal.
function projectionAfterOneBackEdgeTraversal(descriptor: ReturnType<typeof sealGraphDescriptor>): {
  projection: GraphSchedulerProjection;
  ownerActivationId: string;
} {
  let projection = initializeGraphProjection(descriptor, { start: 'a-start' });
  projection = begin(projection, 'a-start', 'try-start');
  projection = succeed(descriptor, projection, 'a-start', 'try-start', 't-start', {
    next_activation_ids: { 'start-test': 'a-test-1' },
  }).projection;

  projection = begin(projection, 'a-test-1', 'try-test-1');
  projection = succeed(
    descriptor,
    projection,
    'a-test-1',
    'try-test-1',
    't-test-1',
    { next_activation_ids: { 'test-fail': 'a-fix-1' } },
    'fail',
  ).projection;

  // This transition selects the `retry-test` back-edge and increments
  // traversal_counts[canonicalJson([traversal_owner_id, 'retry-test'])].
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

  return { projection, ownerActivationId: 'a-start' };
}

describe('graph state traversal_counts persistence (blocker A1)', () => {
  it('round-trips a persisted back-edge traversal count and allows a second traversal', () => {
    const descriptor = sealGraphDescriptor(loopDescriptor());
    const { projection, ownerActivationId } = projectionAfterOneBackEdgeTraversal(descriptor);

    // Sanity: exactly one back-edge counter was recorded, keyed by the canonical
    // [owner, edgeId] JSON form rather than a raw edge id. The traversal_owner_id
    // propagates along the lineage from the originating activation `a-start`, so
    // the counter owner is `a-start` even though `a-fix-1` performed the traversal.
    const traversalKeys = Object.keys(projection.traversal_counts);
    expect(traversalKeys).toHaveLength(1);
    const [parsedOwner, parsedEdge] = JSON.parse(traversalKeys[0] as string) as [string, string];
    expect(parsedOwner).toBe(ownerActivationId);
    expect(parsedEdge).toBe('retry-test');
    expect(projection.traversal_counts[traversalKeys[0] as string]).toBe(1);

    const state = createInitialGraphState({
      session_id: 'session-traversal',
      control_nonce: 'control-traversal',
      descriptor,
      status: 'running',
      created_at: '2026-07-21T00:00:00.000Z',
      projection,
      approval: {
        approved_at: '2026-07-21T00:00:00.000Z',
        evidence: { kind: 'human', ref: 'approval-1' },
      },
    });

    // Before the fix, parseGraphState rejected this state because it validated
    // traversal_counts keys as raw edge ids and saw `["<owner>","retry-test"]`
    // as an "unknown back-edge". Now it must round-trip cleanly.
    const roundTripped = parseGraphState(JSON.parse(JSON.stringify(state)));
    expect(roundTripped.projection.traversal_counts[traversalKeys[0] as string]).toBe(1);

    // The real regression: after persisting a loop traversal, traversing the
    // back-edge again must NOT throw "traversal count references unknown back-edge".
    // We replay the second back-edge traversal against the freshly-parsed state's
    // projection to prove the persisted counter survives the round-trip.
    let replayed = roundTripped.projection;
    replayed = begin(replayed, 'a-test-2', 'try-test-2');
    replayed = succeed(
      descriptor,
      replayed,
      'a-test-2',
      'try-test-2',
      't-test-2',
      { next_activation_ids: { 'test-fail': 'a-fix-2' } },
      'fail',
    ).projection;

    replayed = begin(replayed, 'a-fix-2', 'try-fix-2');
    expect(() =>
      succeed(
        descriptor,
        replayed,
        'a-fix-2',
        'try-fix-2',
        't-fix-2',
        { next_activation_ids: { 'retry-test': 'a-test-3' } },
        'retry',
      ),
    ).not.toThrow();

    // The second back-edge traversal must have incremented the persisted counter.
    expect(replayed.traversal_counts[traversalKeys[0] as string]).toBe(1);
    const afterSecond = succeed(
      descriptor,
      replayed,
      'a-fix-2',
      'try-fix-2',
      't-fix-2',
      { next_activation_ids: { 'retry-test': 'a-test-3' } },
      'retry',
    ).projection;
    expect(afterSecond.traversal_counts[traversalKeys[0] as string]).toBe(2);
  });
});

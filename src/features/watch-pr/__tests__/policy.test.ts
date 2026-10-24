import { describe, expect, it } from 'vitest';
import { decideWatchVerdict, NO_CHECKS_FIRST_SIGHTING_REASON, type WatchPrFacts } from '../policy.js';

function facts(overrides: Partial<WatchPrFacts> = {}): WatchPrFacts {
  return {
    number: 7,
    headSha: 'abc123',
    state: 'open',
    isDraft: false,
    checks: [{ name: 'ci', state: 'pass' }],
    reviewDecision: 'approved',
    mergeable: 'mergeable',
    ...overrides,
  };
}

const NOW = 1_000_000;

describe('decideWatchVerdict', () => {
  it('ready when every visible gate is green, with head SHA proof', () => {
    const verdict = decideWatchVerdict(facts(), { nowMs: NOW });
    expect(verdict.kind).toBe('ready');
    expect(verdict.proof).toEqual({ headSha: 'abc123' });
  });

  it('closed and merged PRs are gone, not blocked', () => {
    expect(decideWatchVerdict(facts({ state: 'merged' }), { nowMs: NOW }).kind).toBe('gone');
    expect(decideWatchVerdict(facts({ state: 'closed' }), { nowMs: NOW }).kind).toBe('gone');
  });

  it('conflicts block ahead of checks and review', () => {
    const verdict = decideWatchVerdict(
      facts({ mergeable: 'conflicting', checks: [{ name: 'ci', state: 'fail' }], reviewDecision: 'changes_requested' }),
      { nowMs: NOW },
    );
    expect(verdict.kind).toBe('blocked');
    expect(verdict.reasons[0]).toContain('merge conflicts');
  });

  it('failed checks block and are named', () => {
    const verdict = decideWatchVerdict(
      facts({ checks: [{ name: 'lint', state: 'fail' }, { name: 'ci', state: 'pass' }] }),
      { nowMs: NOW },
    );
    expect(verdict.kind).toBe('blocked');
    expect(verdict.reasons.join(' ')).toContain('lint');
  });

  it('requested changes block', () => {
    expect(decideWatchVerdict(facts({ reviewDecision: 'changes_requested' }), { nowMs: NOW }).kind).toBe('blocked');
  });

  it('missing approval blocks only when a review is required', () => {
    const noReview = facts({ reviewDecision: 'none' });
    expect(decideWatchVerdict(noReview, { nowMs: NOW }).kind).toBe('ready');
    expect(decideWatchVerdict(noReview, { nowMs: NOW, reviewRequired: true }).kind).toBe('blocked');
  });

  it('unknown mergeability waits and is never an error', () => {
    const verdict = decideWatchVerdict(facts({ mergeable: 'unknown' }), { nowMs: NOW });
    expect(verdict.kind).toBe('waiting');
    expect(verdict.reasons.join(' ')).toContain('mergeability');
  });

  it('pending checks wait and are named', () => {
    const verdict = decideWatchVerdict(
      facts({ checks: [{ name: 'ci', state: 'pending' }] }),
      { nowMs: NOW },
    );
    expect(verdict.kind).toBe('waiting');
    expect(verdict.reasons.join(' ')).toContain('ci');
  });

  it('a first sighting of no checks is never readiness', () => {
    const verdict = decideWatchVerdict(facts({ checks: [{ name: 'ci', state: 'skipping' }] }), { nowMs: NOW });
    expect(verdict.kind).toBe('waiting');
    expect(verdict.reasons).toContain(NO_CHECKS_FIRST_SIGHTING_REASON);
  });

  it('no-checks readiness requires the full confirmation window on the same head', () => {
    const noChecks = { checks: [{ name: 'ci', state: 'skipping' as const }] };
    const serving = decideWatchVerdict(facts(noChecks), { nowMs: NOW, noChecksFirstSeenMs: NOW - 30_000 });
    expect(serving.kind).toBe('waiting');
    expect(serving.reasons.join(' ')).toContain('30000ms of 60000ms');

    const served = decideWatchVerdict(facts(noChecks), { nowMs: NOW, noChecksFirstSeenMs: NOW - 60_000 });
    expect(served.kind).toBe('ready');

    const custom = decideWatchVerdict(facts(noChecks), {
      nowMs: NOW,
      noChecksFirstSeenMs: NOW - 5_000,
      noChecksConfirmMs: 5_000,
    });
    expect(custom.kind).toBe('ready');
  });

  it('draft waits behind everything green', () => {
    expect(decideWatchVerdict(facts({ isDraft: true }), { nowMs: NOW }).kind).toBe('waiting');
  });
});

/**
 * watch-pr verdict policy — pure PR readiness classification.
 *
 * Mechanism credit: the gate ordering, the mergeability-unknown wait, and the
 * no-checks confirmation window derive from pstack's watch-pr design
 * (https://github.com/cursor/plugins/tree/main/pstack, ported at
 * https://github.com/michael-denyer/pstack-claude), reimplemented for OMC.
 *
 * This module is intentionally pure: callers (the `babysit` skill, tests)
 * own all I/O. Classification is first-match-wins over the gates below, and
 * the ordering is the contract — conflicts before checks, failing checks
 * before pending, blocking reviews before waiting states, and a first
 * sighting of "no checks" is never readiness.
 */

/** Check run state as normalized by the caller. */
export type WatchCheckState = 'pass' | 'fail' | 'pending' | 'skipping';

export interface WatchCheckRun {
  readonly name: string;
  readonly state: WatchCheckState;
}

export type WatchReviewDecision = 'approved' | 'changes_requested' | 'none';

export type WatchMergeability = 'mergeable' | 'unknown' | 'conflicting';

/** Facts snapshot for one pull request at one poll. */
export interface WatchPrFacts {
  readonly number: number;
  readonly headSha: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly isDraft: boolean;
  readonly checks: readonly WatchCheckRun[];
  readonly reviewDecision: WatchReviewDecision;
  readonly mergeable: WatchMergeability;
}

export interface WatchOptions {
  /** Wall clock in ms for window math. */
  readonly nowMs: number;
  /**
   * When the current head SHA was first observed with zero checks, in ms.
   * Undefined on a first sighting — the caller persists it per head SHA.
   */
  readonly noChecksFirstSeenMs?: number;
  /** Confirmation window for "no checks configured". Default 60_000 ms. */
  readonly noChecksConfirmMs?: number;
  /** Whether this branch requires an approving review before merge. */
  readonly reviewRequired?: boolean;
}

export type WatchVerdictKind = 'ready' | 'waiting' | 'blocked' | 'gone';

export interface WatchVerdict {
  readonly kind: WatchVerdictKind;
  readonly reasons: readonly string[];
  /** Present only on `ready`: the head SHA the verdict was earned on. */
  readonly proof?: { readonly headSha: string };
}

const DEFAULT_NO_CHECKS_CONFIRM_MS = 60_000;

export const NO_CHECKS_FIRST_SIGHTING_REASON =
  'no checks configured — first sighting, confirmation window not yet served';

/**
 * Classify one PR facts snapshot. Gates, in order:
 * closed/merged → gone; conflicts, failed checks, requested changes, and
 * (when required) missing approval → blocked; draft, unknown mergeability,
 * pending checks, and an unserved no-checks window → waiting; otherwise
 * ready with the head SHA as proof.
 */
export function decideWatchVerdict(facts: WatchPrFacts, options: WatchOptions): WatchVerdict {
  if (facts.state !== 'open') {
    return { kind: 'gone', reasons: [`pr is ${facts.state}`] };
  }

  const blocked: string[] = [];
  if (facts.mergeable === 'conflicting') {
    blocked.push('merge conflicts — branch owner decides the resolution');
  }
  const failed = facts.checks.filter((c) => c.state === 'fail');
  if (failed.length > 0) {
    blocked.push(`failing checks: ${failed.map((c) => c.name).join(', ')}`);
  }
  if (facts.reviewDecision === 'changes_requested') {
    blocked.push('changes requested in review');
  }
  if (options.reviewRequired && facts.reviewDecision !== 'approved') {
    blocked.push('required approving review missing');
  }
  if (blocked.length > 0) {
    return { kind: 'blocked', reasons: blocked };
  }

  const waiting: string[] = [];
  if (facts.isDraft) {
    waiting.push('draft');
  }
  if (facts.mergeable === 'unknown') {
    waiting.push('mergeability not yet computed — re-poll, never an error');
  }
  const pending = facts.checks.filter((c) => c.state === 'pending');
  if (pending.length > 0) {
    waiting.push(`pending checks: ${pending.map((c) => c.name).join(', ')}`);
  }
  if (facts.checks.every((c) => c.state === 'skipping')) {
    const window = options.noChecksConfirmMs ?? DEFAULT_NO_CHECKS_CONFIRM_MS;
    if (options.noChecksFirstSeenMs === undefined) {
      waiting.push(NO_CHECKS_FIRST_SIGHTING_REASON);
    } else if (options.nowMs - options.noChecksFirstSeenMs < window) {
      waiting.push(
        `no checks configured — confirming (${Math.max(0, options.nowMs - options.noChecksFirstSeenMs)}ms of ${window}ms served)`,
      );
    }
  }
  if (waiting.length > 0) {
    return { kind: 'waiting', reasons: waiting };
  }

  return { kind: 'ready', reasons: ['all visible gates green'], proof: { headSha: facts.headSha } };
}

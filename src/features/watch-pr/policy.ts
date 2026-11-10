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

/** Check run state as normalized by the caller (gh pr checks `bucket` values). */
export type WatchCheckState = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface WatchCheckRun {
  readonly name: string;
  readonly state: WatchCheckState;
}

export type WatchReviewDecision = 'approved' | 'changes_requested' | 'none';

export type WatchMergeability = 'mergeable' | 'unknown' | 'conflicting';
// GitHub's MergeStateStatus enum in full. BEHIND, DIRTY, DRAFT, and HAS_HOOKS
// join the four the classifier originally handled so no raw enum value can
// fall through to a ready verdict.
export type WatchMergeStateStatus =
  | 'clean'
  | 'unstable'
  | 'blocked'
  | 'unknown'
  | 'behind'
  | 'dirty'
  | 'draft'
  | 'has_hooks';

/** Facts snapshot for one pull request at one poll. */
export interface WatchPrFacts {
  readonly number: number;
  readonly headSha: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly isDraft: boolean;
  readonly checks: readonly WatchCheckRun[];
  readonly reviewDecision: WatchReviewDecision;
  readonly mergeable: WatchMergeability;
  readonly mergeStateStatus: WatchMergeStateStatus;
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
export function decideWatchVerdict(rawFacts: WatchPrFacts, options: WatchOptions): WatchVerdict {
  // Callers following skills/babysit pass GitHub's raw JSON, whose enums are
  // uppercase (OPEN, CHANGES_REQUESTED, CONFLICTING, BEHIND, ...). Normalize
  // every enum-shaped field once here so a literal uppercase value can never
  // fall through to the wrong gate.
  const lower = (v: string) => v.toLowerCase();
  const facts = {
    ...rawFacts,
    state: lower(String(rawFacts.state)) as WatchPrFacts['state'],
    reviewDecision: lower(String(rawFacts.reviewDecision)) as WatchPrFacts['reviewDecision'],
    mergeable: (lower(String(rawFacts.mergeable)) || 'unknown') as WatchPrFacts['mergeable'],
    mergeStateStatus: lower(String(rawFacts.mergeStateStatus)) as WatchPrFacts['mergeStateStatus'],
    checks: rawFacts.checks.map((c) => ({ ...c, state: lower(String(c.state)) as typeof c.state })),
  };
  if (facts.state !== 'open') {
    return { kind: 'gone', reasons: [`pr is ${facts.state}`] };
  }

  const blocked: string[] = [];
  const waiting: string[] = [];
  if (facts.mergeable === 'conflicting') {
    blocked.push('merge conflicts — branch owner decides the resolution');
  }
  if (facts.mergeStateStatus === 'blocked') {
    blocked.push('aggregate merge gate is blocked');
  }
  const pending = facts.checks.filter((c) => c.state === 'pending');
  if (facts.mergeStateStatus === 'unstable') {
    // UNSTABLE is "mergeable with non-passing commit status" — that includes
    // statuses that have not finished yet. While a visible check is still
    // pending the PR is running CI (waiting); only an unstable aggregate with
    // nothing pending proves a failure and blocks.
    if (pending.length > 0) {
      waiting.push('aggregate merge state is unstable while checks run — re-poll');
    } else {
      blocked.push('aggregate merge state is unstable — failing or missing required checks; re-poll');
    }
  }
  if (facts.mergeStateStatus === 'dirty') {
    blocked.push('aggregate merge state is dirty — merge conflicts; branch owner decides the resolution');
  }
  if (facts.mergeStateStatus === 'behind') {
    blocked.push('head is behind the base branch — the branch owner updates it; babysit never rebases or force-pushes');
  }
  const failed = facts.checks.filter((c) => c.state === 'fail');
  if (failed.length > 0) {
    blocked.push(`failing checks: ${failed.map((c) => c.name).join(', ')}`);
  }
  const canceled = facts.checks.filter((c) => c.state === 'cancel');
  if (canceled.length > 0) {
    blocked.push(`canceled checks: ${canceled.map((c) => c.name).join(', ')} — rerun or clear them`);
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

  if (facts.isDraft) {
    waiting.push('draft');
  }
  if (facts.mergeable === 'unknown') {
    waiting.push('mergeability not yet computed — re-poll, never an error');
  }
  if (facts.mergeStateStatus === 'unknown') {
    waiting.push('aggregate merge state not yet computed — re-poll');
  }
  if (facts.mergeStateStatus === 'draft' && !facts.isDraft) {
    waiting.push('merge state reports a draft — re-poll');
  }
  // has_hooks is not a wait: GitHub defines it as "mergeable with passing
  // commit status and pre-receive hooks" — the hooks belong to the server's
  // merge attempt, not to a check that will later report. Re-polling here
  // would hold an otherwise green PR in waiting forever.
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

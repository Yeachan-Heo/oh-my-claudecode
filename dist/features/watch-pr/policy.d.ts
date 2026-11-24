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
export type WatchMergeStateStatus = 'clean' | 'unstable' | 'blocked' | 'unknown' | 'behind' | 'dirty' | 'draft' | 'has_hooks';
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
    readonly proof?: {
        readonly headSha: string;
    };
}
export declare const NO_CHECKS_FIRST_SIGHTING_REASON = "no checks configured \u2014 first sighting, confirmation window not yet served";
/**
 * Classify one PR facts snapshot. Gates, in order:
 * closed/merged → gone; conflicts, failed checks, requested changes, and
 * (when required) missing approval → blocked; draft, unknown mergeability,
 * pending checks, and an unserved no-checks window → waiting; otherwise
 * ready with the head SHA as proof.
 */
export declare function decideWatchVerdict(rawFacts: WatchPrFacts, options: WatchOptions): WatchVerdict;
//# sourceMappingURL=policy.d.ts.map
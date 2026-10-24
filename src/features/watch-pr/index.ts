/**
 * watch-pr feature barrel: pure PR-readiness classification.
 *
 * Mechanism credit: gate ordering, mergeability-unknown wait, and the
 * no-checks confirmation window derive from pstack's watch-pr design
 * (see docs/CREDITS.md).
 */
export {
  decideWatchVerdict,
  NO_CHECKS_FIRST_SIGHTING_REASON,
  type WatchCheckRun,
  type WatchCheckState,
  type WatchMergeability,
  type WatchOptions,
  type WatchPrFacts,
  type WatchReviewDecision,
  type WatchVerdict,
  type WatchVerdictKind,
} from './policy.js';

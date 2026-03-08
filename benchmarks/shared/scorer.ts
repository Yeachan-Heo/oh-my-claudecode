/**
 * Shared scorer — re-exports from harsh-critic scoring module.
 *
 * The harsh-critic scorer is the reference implementation. This module
 * re-exports its functions so all agent benchmarks use the same scoring logic.
 */

export {
  matchFindings,
  scoreFixture,
  aggregateScores,
} from '../harsh-critic/scoring/scorer.ts';

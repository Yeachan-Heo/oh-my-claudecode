/**
 * Sentinel Health Analyzer
 *
 * Parses JSONL log files of sentinel runs and computes readiness stats.
 * Ported from sentinel_health.py (issue #1155).
 */
import type { SentinelStats, SentinelReadinessResult, SentinelReadinessPolicy } from './types.js';
export declare function getPassRate(stats: SentinelStats): number;
export declare function getTimeoutRate(stats: SentinelStats): number;
export declare function getWarnPlusFailRate(stats: SentinelStats): number;
export declare function getReasonCoverageRate(stats: SentinelStats): number;
/**
 * Parse a JSONL log file and compute aggregate sentinel stats.
 *
 * @param logPath - Path to the JSONL log file
 * @returns Aggregated sentinel statistics
 */
export declare function analyzeLog(logPath: string): SentinelStats;
/**
 * Determine if the sentinel signal is upstream-ready based on
 * configurable thresholds.
 *
 * @param stats  - Computed sentinel statistics
 * @param policy - Readiness thresholds (from config or provided)
 * @returns Tuple of [ready, blockers] — ready is true if all thresholds met
 */
export declare function isUpstreamReady(stats: SentinelStats, policy: SentinelReadinessPolicy): [boolean, string[]];
/**
 * Convenience wrapper: analyze a log file and check readiness.
 */
export declare function checkSentinelHealth(logPath: string, workspace?: string): SentinelReadinessResult;
//# sourceMappingURL=sentinel.d.ts.map
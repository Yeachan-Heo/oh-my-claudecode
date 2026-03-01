/**
 * Sentinel Health Analyzer
 *
 * Parses JSONL log files of sentinel runs and computes readiness stats.
 * Ported from sentinel_health.py (issue #1155).
 */

import { readFileSync, existsSync } from 'fs';
import type {
  SentinelLogEntry,
  SentinelStats,
  SentinelReadinessResult,
  SentinelReadinessPolicy,
} from './types.js';
import { loadGuardsConfig } from './config.js';

// ---------------------------------------------------------------------------
// Stats computation helpers
// ---------------------------------------------------------------------------

function computeRate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function getPassRate(stats: SentinelStats): number {
  return computeRate(stats.pass_count, stats.total_runs);
}

export function getTimeoutRate(stats: SentinelStats): number {
  return computeRate(stats.timeout_count, stats.total_runs);
}

export function getWarnPlusFailRate(stats: SentinelStats): number {
  return computeRate(stats.warn_count + stats.fail_count, stats.total_runs);
}

export function getReasonCoverageRate(stats: SentinelStats): number {
  return computeRate(stats.reason_coverage_count, stats.total_runs);
}

// ---------------------------------------------------------------------------
// Log entry helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a verdict string to PASS, WARN, or FAIL.
 */
function extractVerdict(entry: SentinelLogEntry): 'PASS' | 'WARN' | 'FAIL' {
  const raw = String(entry.verdict ?? '').toUpperCase().trim();
  if (raw === 'PASS') return 'PASS';
  if (raw === 'WARN') return 'WARN';
  return 'FAIL';
}

/**
 * Check if a log entry has a reason/explanation.
 */
function hasReason(entry: SentinelLogEntry): boolean {
  return !!(entry.reason || entry.error || entry.message);
}

/**
 * Check if a log entry indicates a timeout.
 */
function isTimeout(entry: SentinelLogEntry): boolean {
  if (entry.runtime?.timed_out === true) return true;
  if (entry.runtime?.global_timeout === true) return true;
  const reason = String(entry.reason ?? '').toLowerCase();
  return reason.includes('timeout');
}

// ---------------------------------------------------------------------------
// Log analysis
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL log file and compute aggregate sentinel stats.
 *
 * @param logPath - Path to the JSONL log file
 * @returns Aggregated sentinel statistics
 */
export function analyzeLog(logPath: string): SentinelStats {
  const stats: SentinelStats = {
    total_runs: 0,
    pass_count: 0,
    warn_count: 0,
    fail_count: 0,
    timeout_count: 0,
    reason_coverage_count: 0,
  };

  if (!existsSync(logPath)) {
    return stats;
  }

  let content: string;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    return stats;
  }

  const lines = content.split('\n').filter(line => line.trim().length > 0);

  for (const line of lines) {
    let entry: SentinelLogEntry;
    try {
      entry = JSON.parse(line) as SentinelLogEntry;
    } catch {
      // Skip malformed lines
      continue;
    }

    stats.total_runs++;

    const verdict = extractVerdict(entry);
    if (verdict === 'PASS') stats.pass_count++;
    else if (verdict === 'WARN') stats.warn_count++;
    else stats.fail_count++;

    if (isTimeout(entry)) stats.timeout_count++;
    if (hasReason(entry)) stats.reason_coverage_count++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Readiness check
// ---------------------------------------------------------------------------

/**
 * Determine if the sentinel signal is upstream-ready based on
 * configurable thresholds.
 *
 * @param stats  - Computed sentinel statistics
 * @param policy - Readiness thresholds (from config or provided)
 * @returns Tuple of [ready, blockers] — ready is true if all thresholds met
 */
export function isUpstreamReady(
  stats: SentinelStats,
  policy: SentinelReadinessPolicy,
): [boolean, string[]] {
  const blockers: string[] = [];

  const passRate = getPassRate(stats);
  if (passRate < policy.min_pass_rate) {
    blockers.push(
      `pass_rate ${passRate.toFixed(3)} < min ${policy.min_pass_rate}`,
    );
  }

  const timeoutRate = getTimeoutRate(stats);
  if (timeoutRate > policy.max_timeout_rate) {
    blockers.push(
      `timeout_rate ${timeoutRate.toFixed(3)} > max ${policy.max_timeout_rate}`,
    );
  }

  const warnFailRate = getWarnPlusFailRate(stats);
  if (warnFailRate > policy.max_warn_plus_fail_rate) {
    blockers.push(
      `warn_plus_fail_rate ${warnFailRate.toFixed(3)} > max ${policy.max_warn_plus_fail_rate}`,
    );
  }

  const reasonRate = getReasonCoverageRate(stats);
  if (reasonRate < policy.min_reason_coverage_rate) {
    blockers.push(
      `reason_coverage_rate ${reasonRate.toFixed(3)} < min ${policy.min_reason_coverage_rate}`,
    );
  }

  return [blockers.length === 0, blockers];
}

/**
 * Convenience wrapper: analyze a log file and check readiness.
 */
export function checkSentinelHealth(
  logPath: string,
  workspace?: string,
): SentinelReadinessResult {
  const config = loadGuardsConfig(workspace);
  const stats = analyzeLog(logPath);
  const [ready, blockers] = isUpstreamReady(stats, config.sentinel.readiness);
  return { ready, blockers, stats };
}

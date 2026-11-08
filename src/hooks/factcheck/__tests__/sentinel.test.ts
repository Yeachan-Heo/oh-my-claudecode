/**
 * Sentinel Health Analyzer Tests
 *
 * Ported from tests/test_sentinel_health.py (issue #1155).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { analyzeLog, isUpstreamReady, getPassRate, getTimeoutRate } from '../sentinel.js';
import type { SentinelReadinessPolicy } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultReadinessPolicy(): SentinelReadinessPolicy {
  return {
    min_pass_rate: 0.60,
    max_timeout_rate: 0.10,
    max_warn_plus_fail_rate: 0.40,
    min_reason_coverage_rate: 0.95,
  };
}

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sentinel Health Analyzer (issue #1155)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sentinel-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('readiness blocks degraded signal', () => {
    const logPath = join(tempDir, 'sentinel_stop.jsonl');
    const rows = [
      { verdict: 'FAIL', runtime: { timed_out: true }, reason: 'timeout' },
      { verdict: 'WARN', runtime: { global_timeout: true }, reason: '' },
      { verdict: 'WARN', reason: 'no_parseable_verdicts' },
      { verdict: 'FAIL', reason: 'required_models_unavailable' },
      { verdict: 'PASS', reason: 'ok' },
    ];
    writeJsonl(logPath, rows);

    const policy = defaultReadinessPolicy();
    const stats = analyzeLog(logPath);
    const [ready, blockers] = isUpstreamReady(stats, policy);

    expect(ready).toBe(false);
    expect(blockers.length).toBeGreaterThan(0);

    // Verify stats
    expect(stats.total_runs).toBe(5);
    expect(stats.pass_count).toBe(1);
    expect(stats.warn_count).toBe(2);
    expect(stats.fail_count).toBe(2);
    expect(stats.timeout_count).toBe(2); // timed_out + global_timeout
    expect(getPassRate(stats)).toBeCloseTo(0.2, 2);
    expect(getTimeoutRate(stats)).toBeCloseTo(0.4, 2);
  });

  it('readiness passes healthy signal', () => {
    const logPath = join(tempDir, 'sentinel_stop.jsonl');
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push({ verdict: 'PASS', reason: `ok-${i}`, runtime: { timed_out: false } });
    }
    rows.push({ verdict: 'WARN', reason: 'low-confidence', runtime: { timed_out: false } });
    rows.push({ verdict: 'FAIL', reason: 'policy-block', runtime: { timed_out: false } });
    writeJsonl(logPath, rows);

    const policy = defaultReadinessPolicy();
    const stats = analyzeLog(logPath);
    const [ready, blockers] = isUpstreamReady(stats, policy);

    expect(ready).toBe(true);
    expect(blockers).toEqual([]);

    // Verify stats
    expect(stats.total_runs).toBe(10);
    expect(stats.pass_count).toBe(8);
    expect(stats.warn_count).toBe(1);
    expect(stats.fail_count).toBe(1);
    expect(stats.timeout_count).toBe(0);
    expect(stats.reason_coverage_count).toBe(10);
  });

  it('handles missing log file gracefully', () => {
    const stats = analyzeLog(join(tempDir, 'nonexistent.jsonl'));
    expect(stats.total_runs).toBe(0);
    expect(stats.pass_count).toBe(0);
  });

  it('skips malformed JSON lines', () => {
    const logPath = join(tempDir, 'bad.jsonl');
    writeFileSync(logPath, '{"verdict":"PASS","reason":"ok"}\nnot-json\n{"verdict":"FAIL","reason":"err"}\n');

    const stats = analyzeLog(logPath);
    expect(stats.total_runs).toBe(2);
    expect(stats.pass_count).toBe(1);
    expect(stats.fail_count).toBe(1);
  });

  it('detects timeout from reason string', () => {
    const logPath = join(tempDir, 'timeout.jsonl');
    writeJsonl(logPath, [
      { verdict: 'FAIL', reason: 'operation timeout exceeded', runtime: {} },
    ]);

    const stats = analyzeLog(logPath);
    expect(stats.timeout_count).toBe(1);
  });

  it('reason coverage counts entries with reason/error/message', () => {
    const logPath = join(tempDir, 'coverage.jsonl');
    writeJsonl(logPath, [
      { verdict: 'PASS', reason: 'ok' },
      { verdict: 'PASS', error: 'some error' },
      { verdict: 'PASS', message: 'some message' },
      { verdict: 'PASS' }, // no reason/error/message
    ]);

    const stats = analyzeLog(logPath);
    expect(stats.reason_coverage_count).toBe(3);
    expect(stats.total_runs).toBe(4);
  });
});

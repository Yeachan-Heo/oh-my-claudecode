/**
 * Sentinel Readiness Gate Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkSentinelReadiness,
  waitForSentinelReadiness,
} from '../../../team/sentinel-gate.js';

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(path, content, 'utf-8');
}

describe('Sentinel readiness gate', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sentinel-gate-'));

    // Pin guard thresholds in test-local project config for deterministic behavior.
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tempDir, '.claude', 'omc.jsonc'),
      JSON.stringify({
        guards: {
          factcheck: {
            enabled: true,
            mode: 'strict',
          },
          sentinel: {
            enabled: true,
            readiness: {
              min_pass_rate: 0.60,
              max_timeout_rate: 0.10,
              max_warn_plus_fail_rate: 0.40,
              min_reason_coverage_rate: 0.95,
            },
          },
        },
      }),
      'utf-8',
    );

    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns ready:true when disabled', () => {
    const result = checkSentinelReadiness({ enabled: false });

    expect(result).toEqual({
      ready: true,
      blockers: [],
      skipped: true,
    });
  });

  it('checks sentinel health when logPath is provided', () => {
    const logPath = join(tempDir, 'sentinel_stop.jsonl');
    writeJsonl(logPath, [
      { verdict: 'PASS', reason: 'ok-1', runtime: { timed_out: false } },
      { verdict: 'PASS', reason: 'ok-2', runtime: { timed_out: false } },
      { verdict: 'PASS', reason: 'ok-3', runtime: { timed_out: false } },
      { verdict: 'PASS', reason: 'ok-4', runtime: { timed_out: false } },
      { verdict: 'PASS', reason: 'ok-5', runtime: { timed_out: false } },
    ]);

    const result = checkSentinelReadiness({ logPath });

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.skipped).toBe(false);
  });

  it('checks factcheck when claims are provided', () => {
    const result = checkSentinelReadiness({
      claims: { schema_version: '1.0' },
    });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.blockers.some(blocker => blocker.startsWith('[factcheck]'))).toBe(true);
  });

  it('blocks when sentinel stats fail thresholds', () => {
    const logPath = join(tempDir, 'sentinel_stop.jsonl');
    writeJsonl(logPath, [
      { verdict: 'FAIL', runtime: { timed_out: true }, reason: 'timeout' },
      { verdict: 'WARN', runtime: { global_timeout: true }, reason: '' },
      { verdict: 'WARN', reason: 'no_parseable_verdicts' },
      { verdict: 'FAIL', reason: 'required_models_unavailable' },
      { verdict: 'PASS', reason: 'ok' },
    ]);

    const result = checkSentinelReadiness({ logPath });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers.some(blocker => blocker.includes('pass_rate'))).toBe(true);
  });

  it('does not throw on malformed claims and returns blockers instead', () => {
    // files_modified as object instead of array — previously would throw
    const result = checkSentinelReadiness({
      claims: { files_modified: {}, files_created: 'not-an-array' } as unknown as Record<string, unknown>,
    });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    // Should have blockers (from factcheck) but should NOT have thrown
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('returns ready:false when enabled but no logPath or claims provided', () => {
    // enabled defaults to true; no logPath, no claims
    const result = checkSentinelReadiness({});

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers[0]).toContain('no logPath or claims provided');
  });

  it('returns ready:false with explicit enabled:true and no inputs', () => {
    const result = checkSentinelReadiness({ enabled: true });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.blockers.some(b => b.includes('cannot verify readiness'))).toBe(true);
  });

  it('respects sentinel.enabled from config when enabled is omitted', () => {
    writeFileSync(
      join(tempDir, '.claude', 'omc.jsonc'),
      JSON.stringify({
        guards: {
          sentinel: {
            enabled: false,
          },
        },
      }),
      'utf-8',
    );

    const result = checkSentinelReadiness({});
    expect(result).toEqual({
      ready: true,
      blockers: [],
      skipped: true,
    });
  });

  it('times out and fails closed when readiness never arrives', async () => {
    const logPath = join(tempDir, 'sentinel_stop.jsonl');

    const result = await waitForSentinelReadiness({
      logPath,
      timeoutMs: 120,
      pollIntervalMs: 50,
    });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.blockers.some(b => b.includes('timed out'))).toBe(true);
  });

  it('waits until readiness signal appears before succeeding', async () => {
    const logPath = join(tempDir, 'sentinel_stop.jsonl');

    setTimeout(() => {
      writeJsonl(logPath, [
        { verdict: 'PASS', reason: 'ok-1', runtime: { timed_out: false } },
        { verdict: 'PASS', reason: 'ok-2', runtime: { timed_out: false } },
        { verdict: 'PASS', reason: 'ok-3', runtime: { timed_out: false } },
        { verdict: 'PASS', reason: 'ok-4', runtime: { timed_out: false } },
        { verdict: 'PASS', reason: 'ok-5', runtime: { timed_out: false } },
      ]);
    }, 60);

    const result = await waitForSentinelReadiness({
      logPath,
      timeoutMs: 800,
      pollIntervalMs: 40,
    });

    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.blockers).toEqual([]);
  });
});

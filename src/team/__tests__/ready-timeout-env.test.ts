import { describe, expect, it } from 'vitest';
import { resolveWorkerReadyTimeoutMs } from '../scaling.js';
import {
  describeStartupReadyTimeout,
  parseReadyTimeoutMs,
  resolveStartupReadyTimeoutMs,
} from '../ready-timeout.js';

describe('resolveWorkerReadyTimeoutMs', () => {
  it('reads a plain timeout at or above the 5000ms floor', () => {
    expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '60000' })).toBe(60_000);
  });

  it('keeps the 45000ms default when the value is below the floor', () => {
    expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '1000' })).toBe(45_000);
  });

  it.each(['0', '-60000', 'not-a-number', '1.5', ' ', '9007199254740992'])(
    'keeps the default for invalid, below-floor, or unsafe value %j',
    (raw) => {
      expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: raw })).toBe(45_000);
    },
  );

  it('trims surrounding whitespace around an integer value', () => {
    expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: ' 60000 ' })).toBe(60_000);
  });

  it('reads a scientific integer instead of stopping at the exponent', () => {
    expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '5000e2' })).toBe(500_000);
  });

  it('ignores trailing junk instead of keeping a prefix that clears the floor', () => {
    expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '20000x' })).toBe(45_000);
  });
});

describe('startup readiness wait from OMC_TEAM_READY_TIMEOUT_MS', () => {
  const env = (raw: string | undefined): NodeJS.ProcessEnv =>
    raw === undefined ? {} : { OMC_TEAM_READY_TIMEOUT_MS: raw };

  it.each([
    [undefined, undefined, 30_000],
    ['', undefined, 30_000],
    ['abc', undefined, 30_000],
    ['1.5', undefined, 30_000],
    ['NaN', undefined, 30_000],
    ['Infinity', undefined, 30_000],
    ['4999', 4_999, 30_000],
    ['5000', 5_000, 30_000],
    ['29999', 29_999, 30_000],
    ['30000', 30_000, 30_000],
    [' 60000 ', 60_000, 60_000],
    ['60000', 60_000, 60_000],
    ['120000', 120_000, 120_000],
    ['120001', 120_001, 120_000],
    ['600000', 600_000, 120_000],
  ] as const)('reads %j as %j and waits %i ms at startup', (raw, parsed, waitMs) => {
    expect(parseReadyTimeoutMs(env(raw))).toBe(parsed);
    expect(resolveStartupReadyTimeoutMs(env(raw))).toBe(waitMs);
  });

  it('names the variable, the set value, and the value actually used', () => {
    expect(describeStartupReadyTimeout(env('5000'))).toBe(
      'OMC_TEAM_READY_TIMEOUT_MS=5000 (effective 30000ms; startup wait is clamped to 30000..120000ms)',
    );
    expect(describeStartupReadyTimeout(env('600000'))).toContain('=600000 (effective 120000ms;');
    expect(describeStartupReadyTimeout(env(undefined))).toContain('OMC_TEAM_READY_TIMEOUT_MS unset (effective 30000ms;');
  });

  it('keeps the note on one line when the value holds a newline', () => {
    expect(describeStartupReadyTimeout(env('6\n0000'))).toContain('OMC_TEAM_READY_TIMEOUT_MS="6\\n0000" (effective 30000ms;');
  });
});

import { describe, expect, it } from 'vitest';
import { resolveWorkerReadyTimeoutMs } from '../scaling.js';

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

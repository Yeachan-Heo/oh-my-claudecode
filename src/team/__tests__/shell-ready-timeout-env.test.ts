import { afterEach, describe, expect, it } from 'vitest';
import { resolveTeamShellReadyTimeoutMs } from '../tmux-session.js';

describe('resolveTeamShellReadyTimeoutMs', () => {
  afterEach(() => {
    delete process.env.OMC_TEAM_SHELL_READY_TIMEOUT_MS;
  });

  it('keeps an explicit positive timeout', () => {
    expect(resolveTeamShellReadyTimeoutMs({ OMC_TEAM_SHELL_READY_TIMEOUT_MS: '1' }, 1_234)).toBe(1_234);
  });

  it('reads a plain millisecond value', () => {
    expect(resolveTeamShellReadyTimeoutMs({ OMC_TEAM_SHELL_READY_TIMEOUT_MS: '8000' })).toBe(8_000);
  });

  it('reads a scientific integer instead of stopping at the exponent', () => {
    expect(resolveTeamShellReadyTimeoutMs({ OMC_TEAM_SHELL_READY_TIMEOUT_MS: '1e5' })).toBe(100_000);
  });

  it('ignores a numeric separator instead of keeping the digits before it', () => {
    expect(resolveTeamShellReadyTimeoutMs({ OMC_TEAM_SHELL_READY_TIMEOUT_MS: '30_000' })).toBe(5_000);
  });

  it('ignores trailing junk instead of keeping the truncated prefix', () => {
    expect(resolveTeamShellReadyTimeoutMs({ OMC_TEAM_SHELL_READY_TIMEOUT_MS: '12abc' })).toBe(5_000);
  });
});

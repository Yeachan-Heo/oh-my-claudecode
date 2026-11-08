/**
 * Tests for HUD rate limits error indicator rendering.
 */

import { describe, it, expect } from 'vitest';
import { renderRateLimitsError } from '../../hud/elements/limits.js';

describe('renderRateLimitsError', () => {
  it('returns null for no_credentials (expected for API key users)', () => {
    const result = renderRateLimitsError({ rateLimits: null, error: 'no_credentials' });
    expect(result).toBeNull();
  });

  it('returns yellow [API err] for network errors', () => {
    const result = renderRateLimitsError({ rateLimits: null, error: 'network' });
    expect(result).not.toBeNull();
    expect(result).toContain('[API err]');
    // Verify yellow ANSI color code is present
    expect(result).toContain('\x1b[33m');
  });

  it('returns yellow [API auth] for auth errors', () => {
    const result = renderRateLimitsError({ rateLimits: null, error: 'auth' });
    expect(result).not.toBeNull();
    expect(result).toContain('[API auth]');
    // Verify yellow ANSI color code is present
    expect(result).toContain('\x1b[33m');
  });

  it('returns dimmed [API 429] for rate_limited errors', () => {
    const result = renderRateLimitsError({ rateLimits: null, error: 'rate_limited' });
    expect(result).not.toBeNull();
    expect(result).toContain('[API 429]');
    // Verify dim ANSI code is present (not yellow)
    expect(result).toContain('\x1b[2m');
    expect(result).not.toContain('\x1b[33m');
  });

  it('suppresses [API 429] when stale rate limit data is available', () => {
    const result = renderRateLimitsError({
      rateLimits: { fiveHourPercent: 50, weeklyPercent: 30 },
      error: 'rate_limited',
    });
    expect(result).toBeNull();
  });
});

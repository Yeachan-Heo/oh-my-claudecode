/**
 * Tests for rate limits error indicator (Issue #1253)
 */

import { describe, it, expect } from 'vitest';
import { renderRateLimitsError } from '../../hud/elements/limits.js';
import type { UsageResult } from '../../hud/types.js';

describe('renderRateLimitsError', () => {
  it('returns null when result is null', () => {
    const result = renderRateLimitsError(null);
    expect(result).toBeNull();
  });

  it('returns null when result has no error', () => {
    const usageResult: UsageResult = {
      rateLimits: {
        fiveHourPercent: 50,
        weeklyPercent: 30,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
      },
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toBeNull();
  });

  it('returns null when rateLimits is null but no error', () => {
    const usageResult: UsageResult = {
      rateLimits: null,
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toBeNull();
  });

  it('returns [API err] in yellow when network error', () => {
    const usageResult: UsageResult = {
      rateLimits: null,
      error: 'network',
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toContain('[API err]');
    expect(result).toContain('\x1b[33m'); // Yellow ANSI code
  });

  it('returns [API err] in yellow when timeout error', () => {
    const usageResult: UsageResult = {
      rateLimits: null,
      error: 'timeout',
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toContain('[API err]');
    expect(result).toContain('\x1b[33m'); // Yellow ANSI code
  });

  it('returns [API err] in yellow when http error', () => {
    const usageResult: UsageResult = {
      rateLimits: null,
      error: 'http',
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toContain('[API err]');
    expect(result).toContain('\x1b[33m'); // Yellow ANSI code
  });

  it('includes reset code in output', () => {
    const usageResult: UsageResult = {
      rateLimits: null,
      error: 'network',
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toContain('\x1b[0m'); // Reset ANSI code
  });

  it('returns dimmed [API 429] for rate_limited error', () => {
    const usageResult: UsageResult = {
      rateLimits: null,
      error: 'rate_limited',
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toContain('[API 429]');
    expect(result).toContain('\x1b[2m'); // Dim ANSI code
    expect(result).not.toContain('\x1b[33m'); // Not yellow
  });

  it('returns null for rate_limited error when stale rate limit data is available', () => {
    const usageResult: UsageResult = {
      rateLimits: {
        fiveHourPercent: 50,
        weeklyPercent: 30,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
      },
      error: 'rate_limited',
    };
    const result = renderRateLimitsError(usageResult);
    expect(result).toBeNull();
  });
});

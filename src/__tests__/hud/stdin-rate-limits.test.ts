/**
 * Tests for stdin rate_limits parsing and contract preservation.
 *
 * Proves:
 * 1. parseStdinRateLimits produces the same RateLimits shape as parseUsageResponse
 *    for equivalent input data (contract preservation).
 * 2. parseStdinRateLimits returns null when stdin has no usable data (safe fallback).
 */

import { describe, it, expect } from 'vitest';
import { parseStdinRateLimits } from '../../hud/usage-api.js';
import { parseUsageResponse } from '../../hud/usage-api.js';

describe('parseStdinRateLimits', () => {
  it('returns null when rate_limits is undefined', () => {
    expect(parseStdinRateLimits(undefined)).toBeNull();
  });

  it('returns null when both buckets are empty', () => {
    expect(parseStdinRateLimits({ five_hour: {}, seven_day: {} })).toBeNull();
  });

  it('parses five_hour only', () => {
    const result = parseStdinRateLimits({
      five_hour: { used_percentage: 42, resets_at: 1776348000 },
    });
    expect(result).toEqual({
      fiveHourPercent: 42,
      weeklyPercent: undefined,
      fiveHourResetsAt: new Date(1776348000 * 1000),
      weeklyResetsAt: null,
    });
  });

  it('parses both buckets', () => {
    const result = parseStdinRateLimits({
      five_hour: { used_percentage: 11, resets_at: 1776348000 },
      seven_day: { used_percentage: 2, resets_at: 1776916800 },
    });
    expect(result).toEqual({
      fiveHourPercent: 11,
      weeklyPercent: 2,
      fiveHourResetsAt: new Date(1776348000 * 1000),
      weeklyResetsAt: new Date(1776916800 * 1000),
    });
  });

  it('clamps out-of-range values', () => {
    const result = parseStdinRateLimits({
      five_hour: { used_percentage: 150 },
      seven_day: { used_percentage: -10 },
    });
    expect(result!.fiveHourPercent).toBe(100);
    expect(result!.weeklyPercent).toBe(0);
  });
});

describe('contract: stdin vs OAuth produce identical RateLimits shape', () => {
  // Equivalent data as it would arrive from each source
  const stdinInput = {
    five_hour: { used_percentage: 11, resets_at: 1776348000 },
    seven_day: { used_percentage: 2, resets_at: 1776916800 },
  };

  const oauthInput = {
    five_hour: { utilization: 11, resets_at: new Date(1776348000 * 1000).toISOString() },
    seven_day: { utilization: 2, resets_at: new Date(1776916800 * 1000).toISOString() },
  };

  it('produces matching fiveHourPercent and weeklyPercent', () => {
    const fromStdin = parseStdinRateLimits(stdinInput)!;
    const fromOAuth = parseUsageResponse(oauthInput)!;

    expect(fromStdin.fiveHourPercent).toBe(fromOAuth.fiveHourPercent);
    expect(fromStdin.weeklyPercent).toBe(fromOAuth.weeklyPercent);
  });

  it('produces matching reset timestamps', () => {
    const fromStdin = parseStdinRateLimits(stdinInput)!;
    const fromOAuth = parseUsageResponse(oauthInput)!;

    expect(fromStdin.fiveHourResetsAt!.getTime()).toBe(fromOAuth.fiveHourResetsAt!.getTime());
    expect(fromStdin.weeklyResetsAt!.getTime()).toBe(fromOAuth.weeklyResetsAt!.getTime());
  });
});

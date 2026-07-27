/**
 * A provider may report no 5-hour bucket at all (e.g. a Kimi payload whose
 * limits[] carries no 300-minute window). The renderers must omit the bucket
 * rather than printing "5h:0%", which would assert zero usage of a quota we
 * have no data for.
 */

import { describe, it, expect } from 'vitest';
import {
  renderRateLimits,
  renderRateLimitsCompact,
  renderRateLimitsWithBar,
} from '../../hud/elements/limits.js';
import type { RateLimits } from '../../hud/types.js';

/** Strip ANSI so assertions read against plain text */
function plain(value: string | null): string | null {
  return value == null ? value : value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderers omit an absent 5-hour bucket', () => {
  const weeklyOnly: RateLimits = { weeklyPercent: 45, weeklyResetsAt: null };

  it('renderRateLimits omits 5h and still shows weekly', () => {
    const out = plain(renderRateLimits(weeklyOnly));
    expect(out).not.toBeNull();
    expect(out).not.toContain('5h:');
    expect(out).toContain('wk:45%');
  });

  it('renderRateLimitsCompact omits the 5h slot', () => {
    const out = plain(renderRateLimitsCompact(weeklyOnly));
    expect(out).toBe('45%');
  });

  it('renderRateLimitsWithBar omits the 5h bar', () => {
    const out = plain(renderRateLimitsWithBar(weeklyOnly));
    expect(out).not.toBeNull();
    expect(out).not.toContain('5h:');
    expect(out).toContain('wk:');
  });

  it('still renders 5h when the bucket is present, including a genuine 0%', () => {
    const genuineZero: RateLimits = { fiveHourPercent: 0, weeklyPercent: 45 };
    expect(plain(renderRateLimits(genuineZero))).toContain('5h:0%');
    expect(plain(renderRateLimitsCompact(genuineZero))).toBe('0%/45%');
    expect(plain(renderRateLimitsWithBar(genuineZero))).toContain('5h:[');
  });

  it('returns null rather than an empty string when every bucket is absent', () => {
    const empty: RateLimits = {};
    expect(renderRateLimits(empty)).toBeNull();
    expect(renderRateLimitsCompact(empty)).toBeNull();
    expect(renderRateLimitsWithBar(empty)).toBeNull();
    // A stale marker alone would be meaningless
    expect(renderRateLimitsCompact(empty, true)).toBeNull();
  });
});

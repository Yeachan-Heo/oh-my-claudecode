/**
 * Tests for the /api/oauth/usage 403 fallback.
 *
 * Tokens minted by `claude setup-token` (headless / multi-account setups) lack the
 * `user:profile` scope /api/oauth/usage requires, so it answers 403. Such a token
 * can still read its own throttle status from the `anthropic-ratelimit-unified-*`
 * headers of an ordinary /v1/messages call. `rateLimitHeadersToUsage()` is the pure
 * header -> UsageApiResponse transform; the final case runs its output through
 * parseUsageResponse to confirm the end-to-end shape (5h + weekly, no per-model
 * buckets — those live only in the /api/oauth/usage body).
 */
import { describe, it, expect } from 'vitest';
import { rateLimitHeadersToUsage, parseUsageResponse } from '../../hud/usage-api.js';

const RESET_5H = 1789882800; // unix epoch seconds
const RESET_7D = 1790348400;

describe('rateLimitHeadersToUsage', () => {
  it('scales 0..1 utilization to 0..100 and converts epoch resets to ISO', () => {
    const usage = rateLimitHeadersToUsage({
      'anthropic-ratelimit-unified-5h-utilization': '0.27',
      'anthropic-ratelimit-unified-5h-reset': String(RESET_5H),
      'anthropic-ratelimit-unified-7d-utilization': '0.3',
      'anthropic-ratelimit-unified-7d-reset': String(RESET_7D),
    });
    expect(usage).not.toBeNull();
    expect(usage!.five_hour?.utilization).toBeCloseTo(27);
    expect(usage!.seven_day?.utilization).toBeCloseTo(30);
    expect(usage!.five_hour?.resets_at).toBe(new Date(RESET_5H * 1000).toISOString());
    expect(usage!.seven_day?.resets_at).toBe(new Date(RESET_7D * 1000).toISOString());
  });

  it('returns null when neither utilization header is present', () => {
    expect(rateLimitHeadersToUsage({})).toBeNull();
    expect(
      rateLimitHeadersToUsage({ 'anthropic-ratelimit-unified-status': 'allowed' })
    ).toBeNull();
  });

  it('includes a window even when its reset header is missing', () => {
    const usage = rateLimitHeadersToUsage({
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
    });
    expect(usage?.seven_day?.utilization).toBeCloseTo(50);
    expect(usage?.seven_day?.resets_at).toBeUndefined();
    expect(usage?.five_hour).toBeUndefined();
  });

  it('ignores non-numeric header values', () => {
    expect(
      rateLimitHeadersToUsage({ 'anthropic-ratelimit-unified-5h-utilization': 'n/a' })
    ).toBeNull();
  });

  it('uses the first value when a header arrives as an array', () => {
    const usage = rateLimitHeadersToUsage({
      'anthropic-ratelimit-unified-5h-utilization': ['0.42', '0.99'],
    });
    expect(usage?.five_hour?.utilization).toBeCloseTo(42);
  });

  it('feeds parseUsageResponse to yield 5h + weekly without per-model buckets', () => {
    const usage = rateLimitHeadersToUsage({
      'anthropic-ratelimit-unified-5h-utilization': '0.27',
      'anthropic-ratelimit-unified-5h-reset': String(RESET_5H),
      'anthropic-ratelimit-unified-7d-utilization': '0.95',
      'anthropic-ratelimit-unified-7d-reset': String(RESET_7D),
    })!;
    const limits = parseUsageResponse(usage, { subscriptionType: 'max', rateLimitTier: null });
    expect(limits).not.toBeNull();
    expect(limits!.fiveHourPercent).toBeCloseTo(27);
    expect(limits!.weeklyPercent).toBeCloseTo(95);
    expect(limits!.fiveHourResetsAt?.getTime()).toBe(RESET_5H * 1000);
    expect(limits!.weeklyResetsAt?.getTime()).toBe(RESET_7D * 1000);
    // Headers carry no per-model breakdown, so no "Fable"-style buckets appear.
    expect(limits!.scopedWeeklyBuckets).toBeUndefined();
    expect(limits!.sonnetWeeklyPercent).toBeUndefined();
    expect(limits!.opusWeeklyPercent).toBeUndefined();
  });
});

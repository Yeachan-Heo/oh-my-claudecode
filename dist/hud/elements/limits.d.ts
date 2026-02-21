/**
 * OMC HUD - Rate Limits Element
 *
 * Renders 5-hour and weekly rate limit usage display (built-in providers),
 * and custom rate limit buckets from the rateLimitsProvider command.
 */
import type { RateLimits, CustomProviderResult } from '../types.js';
/**
 * Render rate limits display.
 *
 * Format: 5h:45%(3h42m) wk:12%(2d5h) mo:8%(15d3h)
 */
export declare function renderRateLimits(limits: RateLimits | null): string | null;
/**
 * Render compact rate limits (just percentages).
 *
 * Format: 45%/12% or 45%/12%/8% (with monthly)
 */
export declare function renderRateLimitsCompact(limits: RateLimits | null): string | null;
/**
 * Render rate limits with visual progress bars.
 *
 * Format: 5h:[████░░░░░░]45%(3h42m) wk:[█░░░░░░░░░]12%(2d5h) mo:[░░░░░░░░░░]8%(15d3h)
 */
export declare function renderRateLimitsWithBar(limits: RateLimits | null, barWidth?: number): string | null;
/**
 * Render custom rate limit buckets from the rateLimitsProvider command.
 *
 * Format (normal):  label:32%  label2:250/300  label3:as-is
 * Format (stale):   label:32%*  (asterisk marks stale/cached data)
 * Format (error):   [cmd:err]
 *
 * resetsAt is shown only when usage exceeds thresholdPercent (default 85).
 */
export declare function renderCustomBuckets(result: CustomProviderResult, thresholdPercent?: number): string | null;
//# sourceMappingURL=limits.d.ts.map
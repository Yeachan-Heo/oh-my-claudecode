/**
 * OMC HUD - Rate Limits Element
 *
 * Renders 5-hour and weekly rate limit usage display.
 */
import type { RateLimits } from '../types.js';
/**
 * Render rate limits display.
 *
 * Format: 5h:45%(3h42m) wk:12%(2d5h)
 */
export declare function renderRateLimits(limits: RateLimits | null): string | null;
/**
 * Render compact rate limits (just percentages).
 *
 * Format: 45%/12%
 */
export declare function renderRateLimitsCompact(limits: RateLimits | null): string | null;
/**
 * Render rate limits with visual progress bars.
 *
 * Format: 5h:[████░░░░░░]45%(3h42m) wk:[█░░░░░░░░░]12%(2d5h)
 */
export declare function renderRateLimitsWithBar(limits: RateLimits | null, barWidth?: number): string | null;
//# sourceMappingURL=limits.d.ts.map
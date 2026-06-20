/**
 * OMC HUD - Rate Limits Element
 *
 * Renders 5-hour and weekly rate limit usage display (built-in providers),
 * and custom rate limit buckets from the rateLimitsProvider command.
 */
import type { RateLimits, CustomProviderResult, UsageResult } from '../types.js';
/**
 * Render rate limits display.
 *
 * Format: 5h:45%(3h42m) wk:12%(2d5h) mo:8%(15d3h) sn:20%(1d2h) op:5%(1d2h)
 */
export declare function renderRateLimits(limits: RateLimits | null, stale?: boolean): string | null;
/**
 * Render compact rate limits (just percentages).
 *
 * Format: 45%/12% or 45%/12%/8%/20%/5% (5h/wk/mo/sn/op)
 */
export declare function renderRateLimitsCompact(limits: RateLimits | null, stale?: boolean): string | null;
/**
 * Render rate limits with visual progress bars.
 *
 * Format: 5h:[████░░░░░░]45%(3h42m) wk:[█░░░░░░░░░]12%(2d5h) mo:[░░░░░░░░░░]8%(15d3h) sn:[██░░░░░░░░]20%(1d2h) op:[░░░░░░░░░░]5%(1d2h)
 */
export declare function renderRateLimitsWithBar(limits: RateLimits | null, barWidth?: number, stale?: boolean): string | null;
/**
 * Render an error indicator when the built-in rate limit API call fails.
 *
 * - 'network': API timeout, HTTP error, or parse failure → [API err]
 * - 'auth': credentials expired, refresh failed → [API auth]
 * - 'no_credentials': no OAuth credentials (expected for API key users) → null (no display)
 */
export declare function renderRateLimitsError(result: UsageResult | null): string | null;
/**
 * Render a usage hint for Anthropic API-key users.
 *
 * Built-in usage/rate-limit data is only available for OAuth subscribers
 * (and z.ai/MiniMax tokens). Plain Anthropic API-key users get a
 * 'no_credentials' result, which would otherwise render nothing, leaving
 * them with no explanation for the missing usage display. Anthropic does
 * not expose a usage endpoint for regular x-api-key callers (only the
 * org-scoped Admin API, which needs a separate admin key), so we point
 * users at the custom rateLimitsProvider hook (#794) instead.
 *
 * Returns null unless the user is in API-key mode, the built-in fetch
 * failed with 'no_credentials', and no custom provider is configured.
 */
export declare function renderApiKeyUsageHint(result: UsageResult | null, apiKeyMode: boolean, hasCustomProvider: boolean): string | null;
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
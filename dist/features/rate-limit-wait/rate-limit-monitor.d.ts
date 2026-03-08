/**
 * Rate Limit Monitor
 *
 * Wraps the existing usage-api.ts to provide rate limit status monitoring.
 * Uses the OAuth API to check utilization percentages.
 */
import type { RateLimitStatus } from './types.js';
/**
 * Check current rate limit status using the OAuth API
 *
 * @returns Rate limit status or null if API unavailable
 */
export declare function checkRateLimitStatus(): Promise<RateLimitStatus | null>;
/**
 * Format time until reset for display
 */
export declare function formatTimeUntilReset(ms: number): string;
/**
 * Get a human-readable rate limit status message
 */
export declare function formatRateLimitStatus(status: RateLimitStatus): string;
/**
 * Whether the underlying usage API is currently degraded by 429/stale-cache behavior.
 */
export declare function isRateLimitStatusDegraded(status: RateLimitStatus | null): boolean;
/**
 * Whether the daemon should keep monitoring blocked panes.
 * This includes both confirmed limit hits and degraded 429/stale-cache states.
 */
export declare function shouldMonitorBlockedPanes(status: RateLimitStatus | null): boolean;
//# sourceMappingURL=rate-limit-monitor.d.ts.map
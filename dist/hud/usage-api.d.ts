/**
 * OMC HUD - Usage API
 *
 * Fetches rate limit usage from Anthropic's OAuth API.
 * Based on claude-hud implementation by jarrodwatts.
 *
 * Authentication:
 * - macOS: Reads from Keychain "Claude Code-credentials"
 * - Linux/fallback: Reads from ~/.claude/.credentials.json
 *
 * API: api.anthropic.com/api/oauth/usage
 * Response: { five_hour: { utilization }, seven_day: { utilization } }
 */
import { type RateLimits, type UsageResult } from './types.js';
interface UsageApiResponse {
    five_hour?: {
        utilization?: number;
        resets_at?: string;
    };
    seven_day?: {
        utilization?: number;
        resets_at?: string;
    };
    seven_day_sonnet?: {
        utilization?: number;
        resets_at?: string;
    };
    seven_day_opus?: {
        utilization?: number;
        resets_at?: string;
    };
    extra_usage?: {
        utilization?: number;
        spent_usd?: number;
        limit_usd?: number;
        resets_at?: string;
        is_enabled?: boolean;
        used_credits?: number;
        monthly_limit?: number | null;
        currency?: string;
    };
}
interface ParseUsageResponseOptions {
    /** Subscription type from OAuth credentials (for distinguishing Max/Pro overage from Enterprise billing) */
    subscriptionType?: string | null;
    /** Rate limit tier from OAuth credentials; claude_zero tiers behave like Enterprise billing */
    rateLimitTier?: string | null;
}
interface ZaiQuotaResponse {
    data?: {
        limits?: Array<{
            type: string;
            percentage: number;
            remain_count?: number;
            quota_count?: number;
            currentValue?: number;
            usage?: number;
            nextResetTime?: number;
            unit?: number;
            number?: number;
        }>;
    };
}
/**
 * Check if a URL points to z.ai (exact hostname match)
 */
export declare function isZaiHost(urlString: string): boolean;
/**
 * Check if a URL points to MiniMax.
 * Matches all known MiniMax domains:
 *   - minimax.io / *.minimax.io  (international)
 *   - minimaxi.com / *.minimaxi.com  (China)
 *   - minimax.com / *.minimax.com  (China alternative)
 */
export declare function isMinimaxHost(urlString: string): boolean;
interface MinimaxModelRemain {
    model_name: string;
    current_interval_total_count: number;
    /** Remaining request count in the current 5-hour window */
    current_interval_usage_count: number;
    start_time: number;
    end_time: number;
    remains_time: number;
    current_weekly_total_count: number;
    /** Remaining request count in the current weekly window */
    current_weekly_usage_count: number;
    weekly_start_time: number;
    weekly_end_time: number;
    weekly_remains_time: number;
}
interface MinimaxCodingPlanResponse {
    model_remains?: MinimaxModelRemain[];
    base_resp?: {
        status_code: number;
        status_msg: string;
    };
}
/**
 * Get subscription info from OAuth credentials.
 * Returns subscriptionType and rateLimitTier (null when unavailable; never throws).
 */
export declare function getSubscriptionInfo(): {
    subscriptionType: string | null;
    rateLimitTier: string | null;
};
/**
 * Parse API response into RateLimits
 */
export declare function parseUsageResponse(response: UsageApiResponse, options?: ParseUsageResponseOptions): RateLimits | null;
/**
 * Parse z.ai API response into RateLimits.
 *
 * Weekly TOKENS_LIMIT exists only for plans purchased on/after 2026-02-12
 * (UTC+8); older accounts return only the 5-hour bucket regardless of tier.
 * Classify by the entry's `unit` field (not nextResetTime) so buckets don't
 * swap near a weekly reset boundary; fall back to nextResetTime ordering
 * when `unit` is absent.
 */
export declare function parseZaiResponse(response: ZaiQuotaResponse): RateLimits | null;
/**
 * Parse MiniMax coding plan API response into RateLimits
 */
export declare function parseMinimaxResponse(response: MinimaxCodingPlanResponse): RateLimits | null;
/**
 * Get usage data (with caching)
 *
 * Returns a UsageResult with:
 * - rateLimits: RateLimits on success, null on failure/no credentials
 * - error: categorized reason when API call fails (undefined on success or no credentials)
 *   - 'network': API call failed (timeout, HTTP error, parse error)
 *   - 'auth': credentials expired and refresh failed
 *   - 'no_credentials': no OAuth credentials available (expected for API key users)
 *   - 'rate_limited': API returned 429; stale data served if available, with exponential backoff
 */
export declare function getUsage(): Promise<UsageResult>;
export {};
//# sourceMappingURL=usage-api.d.ts.map
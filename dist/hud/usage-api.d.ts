/**
 * OMC HUD - Usage API
 *
 * Fetches rate limit usage from Anthropic's OAuth API, with overrides for
 * third-party providers (z.ai, MiniMax, Kimi) detected via ANTHROPIC_BASE_URL.
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
        decimal_places?: number;
    };
    limits?: Array<{
        kind?: string;
        group?: string;
        percent?: number;
        is_active?: boolean;
        resets_at?: string;
        scope?: {
            model?: {
                id?: string | null;
                display_name?: string | null;
            } | null;
            surface?: unknown;
        } | null;
    }>;
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
/**
 * Check if a URL points to the Kimi For Coding platform (kimi.com).
 * Matches kimi.com and any subdomain (e.g. api.kimi.com). The Moonshot open
 * platform (api.moonshot.ai / api.moonshot.cn) is intentionally NOT matched:
 * it exposes balance, not plan quota windows (no /usages endpoint).
 */
export declare function isKimiHost(urlString: string): boolean;
/**
 * Kimi For Coding `/usages` payload (GET {origin}/coding/v1/usages).
 * Reverse-engineered from the open-source kimi-code CLI
 * (MoonshotAI/kimi-code, packages/oauth/src/managed-usage.ts) and verified
 * against the live endpoint with an API key.
 *
 * Quirk: `limit`/`used`/`remaining` arrive as JSON strings ("100"), not
 * numbers. `resetTime` is ISO 8601 with nano-precision fractional seconds.
 *
 * Shape (abridged live payload):
 *   {
 *     "usage":  { "limit": "100", "used": "45", "remaining": "55", "resetTime": "..." },  // weekly window
 *     "limits": [
 *       { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },                    // 5h window
 *         "detail": { "limit": "100", "used": "2", "remaining": "98", "resetTime": "..." } }
 *     ],
 *     "boosterWallet": { ... }  // optional extra (metered) monthly spend
 *   }
 */
interface KimiQuotaRow {
    /** Fields are string-typed in the wire format; numbers tolerated for robustness */
    limit?: number | string;
    used?: number | string;
    remaining?: number | string;
    /** ISO 8601, may carry nano-precision fraction (".628002Z") */
    resetTime?: string;
    /** Aliases observed across payload versions (per kimi-code's loose parser) */
    reset_at?: string;
    resetAt?: string;
}
interface KimiUsageResponse {
    usage?: KimiQuotaRow;
    limits?: Array<{
        window?: {
            duration?: number;
            timeUnit?: string;
        };
        detail?: KimiQuotaRow;
    } & KimiQuotaRow>;
    boosterWallet?: {
        balance?: {
            type?: string;
            amount?: number;
            amountLeft?: number;
        };
        monthlyChargeLimit?: {
            priceInCents?: number;
            currency?: string;
        };
        monthlyUsed?: {
            priceInCents?: number;
            currency?: string;
        };
        monthlyChargeLimitEnabled?: boolean;
    };
}
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
 * Parse Kimi For Coding `/usages` response into RateLimits.
 *
 * Mapping (verified against live payload):
 * - Top-level `usage` → weekly window (resetTime ~7 days out)
 * - `limits[]` entry whose window is exactly 300 minutes → 5-hour window
 *   (observed: window.duration=300, timeUnit=TIME_UNIT_MINUTE). Any other
 *   duration is dropped, never rendered under the HUD's "5h" label.
 * - `boosterWallet` (optional) → extra usage, USD only: the HUD's extra-usage
 *   renderer hard-codes "$", so CNY wallets are skipped rather than mislabeled.
 */
export declare function parseKimiResponse(response: KimiUsageResponse): RateLimits | null;
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
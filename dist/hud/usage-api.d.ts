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
        }>;
    };
}
/**
 * Check if a URL points to z.ai (exact hostname match)
 */
export declare function isZaiHost(urlString: string): boolean;
/**
 * Parse z.ai API response into RateLimits
 */
export declare function parseZaiResponse(response: ZaiQuotaResponse): RateLimits | null;
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
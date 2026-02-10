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
import type { RateLimits } from './types.js';
/**
 * Get usage data (with caching)
 *
 * Returns null if:
 * - No OAuth credentials available (API users)
 * - Credentials expired
 * - API call failed
 */
export declare function getUsage(): Promise<RateLimits | null>;
//# sourceMappingURL=usage-api.d.ts.map
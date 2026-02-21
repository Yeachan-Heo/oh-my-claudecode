/**
 * OMC HUD - Custom Rate Limit Provider
 *
 * Executes a user-supplied command (omcHud.rateLimitsProvider) to fetch
 * rate limit / quota data and maps the output to CustomProviderResult.
 *
 * Output contract (stdout JSON):
 *   { version: 1, generatedAt: string, buckets: CustomBucket[] }
 *
 * Each bucket:
 *   { id, label, usage: {type, ...}, resetsAt? }
 *
 * Usage types:
 *   percent  – { type: 'percent', value: number }   → renders as "32%"
 *   credit   – { type: 'credit', used, limit }       → renders as "250/300"
 *   string   – { type: 'string', value: string }     → renders as-is
 *
 * Caching: last-good result is persisted for 30 s. On failure the stale
 * cache is returned (stale: true); if no cache exists, error is set.
 */
import type { RateLimitsProviderConfig, CustomProviderResult } from './types.js';
/**
 * Execute the custom rate limit provider and return buckets.
 *
 * Behaviour:
 * - Returns fresh cached data if within 30-second TTL.
 * - On cache miss, spawns the command with the configured timeout.
 * - On success, writes cache and returns {buckets, stale: false}.
 * - On failure, returns last-good cache as {buckets, stale: true}.
 * - If no cache exists, returns {buckets: [], error: 'command failed'}.
 */
export declare function executeCustomProvider(config: RateLimitsProviderConfig): Promise<CustomProviderResult>;
//# sourceMappingURL=custom-rate-provider.d.ts.map
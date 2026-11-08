/**
 * OMC HUD - Enterprise Cost Element
 *
 * Renders billing-period cumulative spend for Claude Enterprise subscribers.
 * Shows spent:$X,XXX.XX when unlimited, or spent:$X.XX/$Y.YY (Z%) when capped.
 */
import type { RateLimits } from '../types.js';
/**
 * Render enterprise billing-period cost display.
 *
 * Format (unlimited): spent:$3,323.93
 * Format (capped):    spent:$3.21/$50.00 (7%)   with color on percent
 * Returns null when enterpriseSpentUsd is undefined (API error / no data).
 */
export declare function renderEnterpriseCost(limits: RateLimits | null | undefined, stale?: boolean): string | null;
//# sourceMappingURL=enterprise-cost.d.ts.map
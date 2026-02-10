/**
 * OMC HUD - Analytics Display
 *
 * Display components for token tracking and cost analytics in the HUD.
 * Now uses SessionHealth as the source of truth instead of TokenTracker.
 */
import type { SessionHealth } from './types.js';
export interface AnalyticsDisplay {
    sessionCost: string;
    sessionTokens: string;
    topAgents: string;
    cacheEfficiency: string;
    costColor: 'green' | 'yellow' | 'red';
}
export interface SessionHealthAnalyticsData {
    costIndicator: string;
    cost: string;
    tokens: string;
    cache: string;
    costHour: string;
}
/**
 * Get analytics display data for the current session.
 * Safe to call even if analytics modules are not initialized.
 *
 * @returns Analytics display data with safe defaults
 * @deprecated Use SessionHealth directly for HUD rendering
 */
export declare function getAnalyticsDisplay(): Promise<AnalyticsDisplay>;
/**
 * Render analytics as a single-line string for HUD display.
 * @deprecated Use renderAnalyticsLineWithConfig() for config-aware rendering
 */
export declare function renderAnalyticsLine(analytics: AnalyticsDisplay): string;
/**
 * Render analytics respecting showCost/showCache config flags.
 */
export declare function renderAnalyticsLineWithConfig(analytics: AnalyticsDisplay, showCost: boolean, showCache: boolean): string;
/**
 * Get current session info for HUD display.
 */
export declare function getSessionInfo(): Promise<string>;
/**
 * Extract structured analytics data from SessionHealth
 */
export declare function getSessionHealthAnalyticsData(sessionHealth: SessionHealth): SessionHealthAnalyticsData;
/**
 * Render analytics from SessionHealth (no longer calls TokenTracker directly)
 * @deprecated Use getSessionHealthAnalyticsData() and compose in render.ts for config-aware rendering
 */
export declare function renderSessionHealthAnalytics(sessionHealth: SessionHealth): string;
/**
 * Render budget warning if cost exceeds thresholds
 */
export declare function renderBudgetWarning(sessionHealth: SessionHealth): string;
/**
 * Render cache efficiency meter
 */
export declare function renderCacheEfficiency(sessionHealth: SessionHealth): string;
//# sourceMappingURL=analytics-display.d.ts.map
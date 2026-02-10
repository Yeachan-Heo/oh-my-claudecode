/**
 * Analytics Summary - Fast session analytics loading
 *
 * This module provides mtime-based caching for <10ms session load times.
 */
export interface AnalyticsSummary {
    sessionId: string;
    lastUpdated: string;
    lastLogOffset: number;
    totals: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        estimatedCost: number;
    };
    topAgents: Array<{
        agent: string;
        cost: number;
        tokens: number;
    }>;
    cacheHitRate: number;
}
/**
 * Get summary file path for session ID.
 */
export declare function getSummaryPath(sessionId: string): string;
/**
 * Initialize empty summary for new session.
 */
export declare function createEmptySummary(sessionId: string): AnalyticsSummary;
/**
 * Load analytics summary with mtime-based caching.
 *
 * Performance target: <10ms (vs 50-100ms full JSONL rebuild)
 *
 * Strategy:
 * 1. Check if summary file exists and is fresh (mtime >= log mtime)
 * 2. If fresh → return cached summary
 * 3. If stale → rebuild incrementally from lastLogOffset
 */
export declare function loadAnalyticsFast(sessionId: string): Promise<AnalyticsSummary | null>;
/**
 * Force rebuild summary from scratch (ignore cache)
 */
export declare function rebuildAnalyticsSummary(sessionId: string): Promise<AnalyticsSummary>;
//# sourceMappingURL=analytics-summary.d.ts.map
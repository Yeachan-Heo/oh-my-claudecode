/**
 * Session Catalog
 *
 * Derives session list from the global token-tracking.jsonl file.
 * This is the primary data source for `omc sessions` - it shows
 * real Claude Code sessions with timestamps, costs, and agent usage.
 */
import { TokenUsage } from './types.js';
export declare function isValidTokenUsage(record: unknown): record is TokenUsage;
export interface CatalogSession {
    sessionId: string;
    startTime: string;
    endTime: string;
    totalTokens: number;
    totalCost: number;
    entryCount: number;
    agentBreakdown: Record<string, {
        tokens: number;
        cost: number;
    }>;
    modelBreakdown: Record<string, {
        tokens: number;
        cost: number;
    }>;
    source: 'transcript' | 'runtime';
}
export declare class SessionCatalog {
    /**
     * Get all sessions derived from token tracking data.
     * Returns sessions sorted by startTime descending (newest first).
     */
    getSessions(limit?: number): Promise<CatalogSession[]>;
    /**
     * Get a single session by ID.
     */
    getSession(sessionId: string): Promise<CatalogSession | null>;
    /**
     * Get the total number of unique sessions.
     */
    getSessionCount(): Promise<number>;
    private buildCatalogSession;
    private readTokenLog;
}
export declare function getSessionCatalog(): SessionCatalog;
//# sourceMappingURL=session-catalog.d.ts.map
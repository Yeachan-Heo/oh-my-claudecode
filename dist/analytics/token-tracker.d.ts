import { TokenUsage, SessionTokenStats, AggregateTokenStats } from "./types.js";
export declare class TokenTracker {
    private currentSessionId;
    private sessionStats;
    constructor(sessionId?: string, skipRestore?: boolean);
    private generateSessionId;
    private initializeSessionStats;
    recordTokenUsage(usage: Omit<TokenUsage, "sessionId" | "timestamp">): Promise<void>;
    private appendToLog;
    private updateSessionStats;
    private saveSessionStats;
    loadSessionStats(sessionId?: string): Promise<SessionTokenStats | null>;
    private rebuildStatsFromLog;
    getSessionStats(): SessionTokenStats;
    getAllStats(): Promise<AggregateTokenStats>;
    private getAllStatsViaTokscale;
    private getAgentDataFromLocalLog;
    private getAllStatsLegacy;
    getTopAgentsAllSessions(limit?: number): Promise<Array<{
        agent: string;
        tokens: number;
        cost: number;
    }>>;
    getTopAgents(limit?: number): Promise<Array<{
        agent: string;
        tokens: number;
        cost: number;
    }>>;
    cleanupOldLogs(retentionDays?: number): Promise<number>;
}
export declare function getTokenTracker(sessionId?: string): TokenTracker;
export declare function resetTokenTracker(sessionId?: string): TokenTracker;
//# sourceMappingURL=token-tracker.d.ts.map
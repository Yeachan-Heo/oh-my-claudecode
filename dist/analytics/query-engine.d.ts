export interface TimeRange {
    start: string;
    end: string;
}
export interface CostReport {
    totalCost: number;
    byAgent: Record<string, number>;
    byModel: Record<string, number>;
    byDay?: Record<string, number>;
    period: 'daily' | 'weekly' | 'monthly';
    range: TimeRange;
}
export interface UsagePattern {
    peakHours: number[];
    mostExpensiveOperations: Array<{
        operation: string;
        cost: number;
    }>;
    averageCostPerSession: number;
    totalSessions: number;
}
export declare class QueryEngine {
    getCostReport(period: 'daily' | 'weekly' | 'monthly'): Promise<CostReport>;
    private getCostReportViaTokscale;
    private getCostReportLegacy;
    private getAgentCostFromLocalLog;
    getUsagePatterns(): Promise<UsagePattern>;
    cleanupOldData(retentionDays?: number): Promise<{
        removedTokens: number;
        removedMetrics: number;
    }>;
    private calculateTimeRange;
}
export declare function getQueryEngine(): QueryEngine;
//# sourceMappingURL=query-engine.d.ts.map
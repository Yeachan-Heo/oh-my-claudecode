import { getTokenTracker } from './token-tracker.js';
import { getSessionManager } from './session-manager.js';
import { calculateCost } from './cost-estimator.js';
import { getTokscaleAdapter } from './tokscale-adapter.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
export class QueryEngine {
    async getCostReport(period) {
        const adapter = await getTokscaleAdapter();
        if (adapter.isAvailable && adapter.getReport) {
            return this.getCostReportViaTokscale(adapter, period);
        }
        // Fallback to existing implementation
        return this.getCostReportLegacy(period);
    }
    async getCostReportViaTokscale(adapter, period) {
        const range = this.calculateTimeRange(period);
        try {
            const report = await adapter.getReport();
            // Get agent data from local JSONL (populated by backfill)
            const byAgent = await this.getAgentCostFromLocalLog(range);
            const byModel = {};
            for (const [model, data] of Object.entries(report.byModel)) {
                byModel[model] = data.cost;
            }
            return {
                totalCost: report.totalCost,
                byAgent, // From local JSONL
                byModel,
                byDay: {},
                period,
                range
            };
        }
        catch (error) {
            // If tokscale fails, fall back to legacy
            return this.getCostReportLegacy(period);
        }
    }
    // UNUSED: Kept for reference, but tokscale path no longer mixes local JSONL
    // private async convertParsedToEntries(parsed: any[], range: TimeRange): Promise<any[]> {
    //   const tokenLogPath = path.join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
    //   const entries: any[] = [];
    //
    //   try {
    //     const content = await fs.readFile(tokenLogPath, 'utf-8');
    //     const lines = content.trim().split('\n').filter(l => l.length > 0);
    //
    //     for (const line of lines) {
    //       const record = JSON.parse(line);
    //
    //       // Filter by time range
    //       if (record.timestamp >= range.start && record.timestamp <= range.end) {
    //         entries.push(record);
    //       }
    //     }
    //   } catch (error) {
    //     // Return empty if error
    //   }
    //
    //   return entries;
    // }
    async getCostReportLegacy(period) {
        const range = this.calculateTimeRange(period);
        const tokenLogPath = path.join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
        try {
            const content = await fs.readFile(tokenLogPath, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.length > 0);
            let totalCost = 0;
            const byAgent = {};
            const byModel = {};
            const byDay = {};
            for (const line of lines) {
                const record = JSON.parse(line);
                // Filter by time range
                if (record.timestamp < range.start || record.timestamp > range.end) {
                    continue;
                }
                // Calculate cost for this record
                const cost = calculateCost({
                    modelName: record.modelName,
                    inputTokens: record.inputTokens,
                    outputTokens: record.outputTokens,
                    cacheCreationTokens: record.cacheCreationTokens,
                    cacheReadTokens: record.cacheReadTokens
                });
                totalCost += cost.totalCost;
                // Aggregate by agent
                if (record.agentName) {
                    byAgent[record.agentName] = (byAgent[record.agentName] || 0) + cost.totalCost;
                }
                // Aggregate by model
                byModel[record.modelName] = (byModel[record.modelName] || 0) + cost.totalCost;
                // Aggregate by day
                const day = record.timestamp.split('T')[0];
                byDay[day] = (byDay[day] || 0) + cost.totalCost;
            }
            return {
                totalCost,
                byAgent,
                byModel,
                byDay,
                period,
                range
            };
        }
        catch (error) {
            // Return empty report if no data
            return {
                totalCost: 0,
                byAgent: {},
                byModel: {},
                byDay: {},
                period,
                range
            };
        }
    }
    // Hybrid data merging: Read agent attribution from local JSONL
    async getAgentCostFromLocalLog(range) {
        const tokenLogPath = path.join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
        const byAgent = {};
        try {
            const content = await fs.readFile(tokenLogPath, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.length > 0);
            for (const line of lines) {
                const record = JSON.parse(line);
                // Filter by time range
                if (record.timestamp < range.start || record.timestamp > range.end) {
                    continue;
                }
                // Aggregate by agent
                if (record.agentName) {
                    const cost = calculateCost({
                        modelName: record.modelName,
                        inputTokens: record.inputTokens,
                        outputTokens: record.outputTokens,
                        cacheCreationTokens: record.cacheCreationTokens,
                        cacheReadTokens: record.cacheReadTokens
                    });
                    byAgent[record.agentName] = (byAgent[record.agentName] || 0) + cost.totalCost;
                }
            }
        }
        catch (error) {
            // Return empty if error
        }
        return byAgent;
    }
    async getUsagePatterns() {
        const tokenLogPath = path.join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
        const manager = getSessionManager();
        const history = await manager.getHistory();
        try {
            const content = await fs.readFile(tokenLogPath, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.length > 0);
            const hourCounts = {};
            const operationCosts = {};
            for (const line of lines) {
                const record = JSON.parse(line);
                // Track peak hours
                const hour = new Date(record.timestamp).getHours();
                hourCounts[hour] = (hourCounts[hour] || 0) + 1;
                // Track operation costs (by agent)
                if (record.agentName) {
                    const cost = calculateCost({
                        modelName: record.modelName,
                        inputTokens: record.inputTokens,
                        outputTokens: record.outputTokens,
                        cacheCreationTokens: record.cacheCreationTokens,
                        cacheReadTokens: record.cacheReadTokens
                    });
                    operationCosts[record.agentName] = (operationCosts[record.agentName] || 0) + cost.totalCost;
                }
            }
            // Find peak hours (top 3)
            const peakHours = Object.entries(hourCounts)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 3)
                .map(([hour]) => parseInt(hour));
            // Find most expensive operations (top 5)
            const mostExpensiveOperations = Object.entries(operationCosts)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 5)
                .map(([operation, cost]) => ({ operation, cost }));
            const averageCostPerSession = history.totalSessions > 0
                ? history.totalCost / history.totalSessions
                : 0;
            return {
                peakHours,
                mostExpensiveOperations,
                averageCostPerSession,
                totalSessions: history.totalSessions
            };
        }
        catch (error) {
            return {
                peakHours: [],
                mostExpensiveOperations: [],
                averageCostPerSession: 0,
                totalSessions: 0
            };
        }
    }
    async cleanupOldData(retentionDays = 30) {
        const tracker = getTokenTracker();
        const removedTokens = await tracker.cleanupOldLogs(retentionDays);
        // TODO: Add metrics cleanup when metrics collector is integrated
        const removedMetrics = 0;
        return { removedTokens, removedMetrics };
    }
    calculateTimeRange(period) {
        const end = new Date();
        const start = new Date();
        if (period === 'daily') {
            start.setDate(start.getDate() - 1);
        }
        else if (period === 'weekly') {
            start.setDate(start.getDate() - 7);
        }
        else if (period === 'monthly') {
            start.setDate(start.getDate() - 30);
        }
        return {
            start: start.toISOString(),
            end: end.toISOString()
        };
    }
}
// Singleton instance
let globalEngine = null;
export function getQueryEngine() {
    if (!globalEngine) {
        globalEngine = new QueryEngine();
    }
    return globalEngine;
}
//# sourceMappingURL=query-engine.js.map
import { getTokenTracker } from './token-tracker.js';
import { getSessionManager } from './session-manager.js';
import { getMetricsCollector, aggregators } from './metrics-collector.js';
import { calculateCost } from './cost-estimator.js';
import * as fs from 'fs/promises';
import * as path from 'path';

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
  mostExpensiveOperations: Array<{ operation: string; cost: number }>;
  averageCostPerSession: number;
  totalSessions: number;
}

export class QueryEngine {
  async getCostReport(period: 'daily' | 'weekly' | 'monthly'): Promise<CostReport> {
    const range = this.calculateTimeRange(period);
    const tokenLogPath = path.resolve(process.cwd(), '.omc/state/token-tracking.jsonl');

    try {
      const content = await fs.readFile(tokenLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);

      let totalCost = 0;
      const byAgent: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      const byDay: Record<string, number> = {};

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
    } catch (error) {
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

  async getUsagePatterns(): Promise<UsagePattern> {
    const tokenLogPath = path.resolve(process.cwd(), '.omc/state/token-tracking.jsonl');
    const manager = getSessionManager();
    const history = await manager.getHistory();

    try {
      const content = await fs.readFile(tokenLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);

      const hourCounts: Record<number, number> = {};
      const operationCosts: Record<string, number> = {};

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
    } catch (error) {
      return {
        peakHours: [],
        mostExpensiveOperations: [],
        averageCostPerSession: 0,
        totalSessions: 0
      };
    }
  }

  async cleanupOldData(retentionDays: number = 30): Promise<{ removedTokens: number; removedMetrics: number }> {
    const tracker = getTokenTracker();
    const removedTokens = await tracker.cleanupOldLogs(retentionDays);

    // TODO: Add metrics cleanup when metrics collector is integrated
    const removedMetrics = 0;

    return { removedTokens, removedMetrics };
  }

  private calculateTimeRange(period: 'daily' | 'weekly' | 'monthly'): TimeRange {
    const end = new Date();
    const start = new Date();

    if (period === 'daily') {
      start.setDate(start.getDate() - 1);
    } else if (period === 'weekly') {
      start.setDate(start.getDate() - 7);
    } else if (period === 'monthly') {
      start.setDate(start.getDate() - 30);
    }

    return {
      start: start.toISOString(),
      end: end.toISOString()
    };
  }
}

// Singleton instance
let globalEngine: QueryEngine | null = null;

export function getQueryEngine(): QueryEngine {
  if (!globalEngine) {
    globalEngine = new QueryEngine();
  }
  return globalEngine;
}

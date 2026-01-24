import { readState, writeState, StateLocation } from '../features/state-manager/index.js';
import { TokenUsage, SessionTokenStats } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const TOKEN_LOG_FILE = '.omc/state/token-tracking.jsonl';
const SESSION_STATS_FILE = '.omc/state/session-token-stats.json';

export class TokenTracker {
  private currentSessionId: string;
  private sessionStats: SessionTokenStats;

  constructor(sessionId?: string) {
    this.currentSessionId = sessionId || this.generateSessionId();
    this.sessionStats = this.initializeSessionStats();
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private initializeSessionStats(): SessionTokenStats {
    return {
      sessionId: this.currentSessionId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreation: 0,
      totalCacheRead: 0,
      totalCost: 0,
      byAgent: {},
      byModel: {},
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString()
    };
  }

  async recordTokenUsage(usage: Omit<TokenUsage, 'sessionId' | 'timestamp'>): Promise<void> {
    const record: TokenUsage = {
      ...usage,
      sessionId: this.currentSessionId,
      timestamp: new Date().toISOString()
    };

    // Append to JSONL log (append-only for performance)
    await this.appendToLog(record);

    // Update session stats
    this.updateSessionStats(record);

    // Persist session stats
    await this.saveSessionStats();
  }

  private async appendToLog(record: TokenUsage): Promise<void> {
    const logPath = path.resolve(process.cwd(), TOKEN_LOG_FILE);
    const logDir = path.dirname(logPath);

    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(record) + '\n', 'utf-8');
  }

  private updateSessionStats(record: TokenUsage): void {
    this.sessionStats.totalInputTokens += record.inputTokens;
    this.sessionStats.totalOutputTokens += record.outputTokens;
    this.sessionStats.totalCacheCreation += record.cacheCreationTokens;
    this.sessionStats.totalCacheRead += record.cacheReadTokens;
    this.sessionStats.lastUpdate = record.timestamp;

    // Group by agent
    if (record.agentName) {
      if (!this.sessionStats.byAgent[record.agentName]) {
        this.sessionStats.byAgent[record.agentName] = [];
      }
      this.sessionStats.byAgent[record.agentName].push(record);
    }

    // Group by model
    if (!this.sessionStats.byModel[record.modelName]) {
      this.sessionStats.byModel[record.modelName] = [];
    }
    this.sessionStats.byModel[record.modelName].push(record);
  }

  private async saveSessionStats(): Promise<void> {
    writeState('session-token-stats', this.sessionStats, StateLocation.LOCAL);
  }

  async loadSessionStats(sessionId?: string): Promise<SessionTokenStats | null> {
    const sid = sessionId || this.currentSessionId;

    // Try to load from state
    const result = readState<SessionTokenStats>('session-token-stats', StateLocation.LOCAL);

    if (result.exists && result.data && result.data.sessionId === sid) {
      this.sessionStats = result.data;
      return result.data;
    }

    // Rebuild from JSONL log if needed
    return this.rebuildStatsFromLog(sid);
  }

  private async rebuildStatsFromLog(sessionId: string): Promise<SessionTokenStats | null> {
    const logPath = path.resolve(process.cwd(), TOKEN_LOG_FILE);

    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      const stats = this.initializeSessionStats();
      stats.sessionId = sessionId;

      for (const line of lines) {
        const record: TokenUsage = JSON.parse(line);
        if (record.sessionId === sessionId) {
          this.updateSessionStats(record);
        }
      }

      return stats.totalInputTokens > 0 ? stats : null;
    } catch (error) {
      return null;
    }
  }

  getSessionStats(): SessionTokenStats {
    return { ...this.sessionStats };
  }

  async getTopAgents(limit: number = 5): Promise<Array<{ agent: string; tokens: number; cost: number }>> {
    const { calculateCost } = await import('./cost-estimator.js');

    const agentStats = Object.entries(this.sessionStats.byAgent).map(([agent, usages]) => {
      const totalTokens = usages.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
      const totalCost = usages.reduce((sum, u) => {
        const cost = calculateCost({
          modelName: u.modelName,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          cacheReadTokens: u.cacheReadTokens
        });
        return sum + cost.totalCost;
      }, 0);

      return { agent, tokens: totalTokens, cost: totalCost };
    });

    return agentStats.sort((a, b) => b.cost - a.cost).slice(0, limit);
  }

  async cleanupOldLogs(retentionDays: number = 30): Promise<number> {
    const logPath = path.resolve(process.cwd(), TOKEN_LOG_FILE);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      let kept = 0;
      let removed = 0;

      const filteredLines = lines.filter(line => {
        const record: TokenUsage = JSON.parse(line);
        const recordDate = new Date(record.timestamp);
        if (recordDate >= cutoffDate) {
          kept++;
          return true;
        }
        removed++;
        return false;
      });

      await fs.writeFile(logPath, filteredLines.join('\n') + '\n', 'utf-8');
      return removed;
    } catch (error) {
      return 0;
    }
  }
}

// Singleton instance for current session
let globalTracker: TokenTracker | null = null;

export function getTokenTracker(sessionId?: string): TokenTracker {
  if (!globalTracker) {
    globalTracker = new TokenTracker(sessionId);
  }
  return globalTracker;
}

export function resetTokenTracker(sessionId?: string): TokenTracker {
  globalTracker = new TokenTracker(sessionId);
  return globalTracker;
}

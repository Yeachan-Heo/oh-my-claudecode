import {
  readState,
  writeState,
  StateLocation,
} from "../features/state-manager/index.js";
import { TokenUsage, SessionTokenStats, AggregateTokenStats } from "./types.js";
import { normalizeModelName } from "./cost-estimator.js";
import { getTokscaleAdapter, TokscaleAdapter } from "./tokscale-adapter.js";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { homedir } from "os";

const TOKEN_LOG_FILE = path.join(
  homedir(),
  ".omc",
  "state",
  "token-tracking.jsonl",
);

// Session index for fast log lookups
interface SessionIndex {
  sessions: Record<string, { offset: number; count: number; lastSeen: string }>;
  lastUpdated: string;
}

const SESSION_INDEX_FILE = path.join(
  homedir(),
  ".omc",
  "state",
  "token-tracking-index.json",
);
const INDEX_STALE_MS = 5 * 60 * 1000; // 5 minutes
let sessionIndexCache: SessionIndex | null = null;
let sessionIndexCacheTime = 0;

function getSessionIndex(): SessionIndex | null {
  const now = Date.now();
  if (sessionIndexCache && now - sessionIndexCacheTime < INDEX_STALE_MS) {
    return sessionIndexCache;
  }
  try {
    if (fsSync.existsSync(SESSION_INDEX_FILE)) {
      const content = fsSync.readFileSync(SESSION_INDEX_FILE, "utf-8");
      sessionIndexCache = JSON.parse(content);
      sessionIndexCacheTime = now;
      return sessionIndexCache;
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function saveSessionIndex(index: SessionIndex): void {
  try {
    const dir = path.dirname(SESSION_INDEX_FILE);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    fsSync.writeFileSync(SESSION_INDEX_FILE, JSON.stringify(index, null, 2));
    sessionIndexCache = index;
    sessionIndexCacheTime = Date.now();
  } catch {
    // Ignore write errors
  }
}

function updateSessionIndex(sessionId: string): void {
  const index = getSessionIndex() || { sessions: {}, lastUpdated: "" };
  const existing = index.sessions[sessionId];
  if (existing) {
    existing.count += 1;
    existing.lastSeen = new Date().toISOString();
  } else {
    // For new session, estimate offset from current log size
    try {
      if (fsSync.existsSync(TOKEN_LOG_FILE)) {
        const content = fsSync.readFileSync(TOKEN_LOG_FILE, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        index.sessions[sessionId] = {
          offset: lines.length,
          count: 1,
          lastSeen: new Date().toISOString(),
        };
      } else {
        index.sessions[sessionId] = {
          offset: 0,
          count: 1,
          lastSeen: new Date().toISOString(),
        };
      }
    } catch {
      index.sessions[sessionId] = {
        offset: 0,
        count: 1,
        lastSeen: new Date().toISOString(),
      };
    }
  }
  index.lastUpdated = new Date().toISOString();
  saveSessionIndex(index);
}

export class TokenTracker {
  private currentSessionId: string;
  private sessionStats: SessionTokenStats;

  constructor(sessionId?: string, skipRestore?: boolean) {
    this.currentSessionId = sessionId || this.generateSessionId();
    // Try to restore existing session stats before initializing fresh (Bug #4 fix)
    if (!skipRestore) {
      const existing = readState<SessionTokenStats>(
        "session-token-stats",
        StateLocation.GLOBAL,
      );
      if (
        existing.exists &&
        existing.data &&
        existing.data.sessionId === this.currentSessionId
      ) {
        this.sessionStats = existing.data;
        return;
      }
    }
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
      lastUpdate: new Date().toISOString(),
    };
  }

  async recordTokenUsage(
    usage: Omit<TokenUsage, "sessionId" | "timestamp">,
  ): Promise<void> {
    const record: TokenUsage = {
      ...usage,
      modelName: normalizeModelName(usage.modelName), // Bug #15: normalize model names
      sessionId: this.currentSessionId,
      timestamp: new Date().toISOString(),
    };

    // Append to JSONL log (append-only for performance)
    await this.appendToLog(record);

    // Update session stats
    this.updateSessionStats(record);

    // Persist session stats
    await this.saveSessionStats();
  }

  private async appendToLog(record: TokenUsage): Promise<void> {
    const logDir = path.dirname(TOKEN_LOG_FILE);

    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(TOKEN_LOG_FILE, JSON.stringify(record) + "\n", "utf-8");
    updateSessionIndex(record.sessionId);
  }

  private updateSessionStats(record: TokenUsage): void {
    this.sessionStats.totalInputTokens += record.inputTokens;
    this.sessionStats.totalOutputTokens += record.outputTokens;
    this.sessionStats.totalCacheCreation += record.cacheCreationTokens;
    this.sessionStats.totalCacheRead += record.cacheReadTokens;
    this.sessionStats.lastUpdate = record.timestamp;

    // Group by agent (use "(main session)" for entries without agentName)
    const agentKey = record.agentName || "(main session)";
    if (!this.sessionStats.byAgent[agentKey]) {
      this.sessionStats.byAgent[agentKey] = [];
    }
    this.sessionStats.byAgent[agentKey].push(record);

    // Group by model
    if (!this.sessionStats.byModel[record.modelName]) {
      this.sessionStats.byModel[record.modelName] = [];
    }
    this.sessionStats.byModel[record.modelName].push(record);
  }

  private async saveSessionStats(): Promise<void> {
    writeState("session-token-stats", this.sessionStats, StateLocation.GLOBAL);
  }

  async loadSessionStats(
    sessionId?: string,
  ): Promise<SessionTokenStats | null> {
    const sid = sessionId || this.currentSessionId;

    // Try to load from state
    const result = readState<SessionTokenStats>(
      "session-token-stats",
      StateLocation.GLOBAL,
    );

    if (result.exists && result.data && result.data.sessionId === sid) {
      this.sessionStats = result.data;
      return result.data;
    }

    // Rebuild from JSONL log if needed
    return this.rebuildStatsFromLog(sid);
  }

  private async rebuildStatsFromLog(
    sessionId: string,
  ): Promise<SessionTokenStats | null> {
    try {
      const index = getSessionIndex();
      const content = await fs.readFile(TOKEN_LOG_FILE, "utf-8");
      const allLines = content.trim().split("\n");

      let linesToProcess: string[];

      if (index?.sessions[sessionId]) {
        const sessionInfo = index.sessions[sessionId];
        const startOffset = Math.max(0, sessionInfo.offset);
        const endOffset = Math.min(
          allLines.length,
          startOffset + sessionInfo.count + 10,
        );
        linesToProcess = allLines.slice(startOffset, endOffset);
      } else {
        linesToProcess = allLines;
      }

      const stats = this.initializeSessionStats();
      stats.sessionId = sessionId;

      for (const line of linesToProcess) {
        if (!line.trim()) continue;
        try {
          const record: TokenUsage = JSON.parse(line);
          if (record.sessionId === sessionId) {
            this.updateSessionStats(record);
          }
        } catch {
          continue;
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

  async getAllStats(): Promise<AggregateTokenStats> {
    const adapter = await getTokscaleAdapter();

    if (adapter.isAvailable && adapter.getReport) {
      return this.getAllStatsViaTokscale(adapter);
    }

    // Fallback to existing implementation
    return this.getAllStatsLegacy();
  }

  private async getAllStatsViaTokscale(
    adapter: TokscaleAdapter,
  ): Promise<AggregateTokenStats> {
    try {
      // Get tokscale report using the new unified API
      const report = await adapter.getReport!();

      // Get agent data from local JSONL (populated by backfill)
      const agentData = await this.getAgentDataFromLocalLog();

      // Map tokscale report to our AggregateTokenStats format
      // Merge tokscale model-level data with local agent-level data
      return {
        totalInputTokens: report.totalInputTokens,
        totalOutputTokens: report.totalOutputTokens,
        totalCacheCreation: report.totalCacheCreationTokens,
        totalCacheRead: report.totalCacheReadTokens,
        totalCost: report.totalCost,
        byAgent: agentData.byAgent, // From local JSONL
        byModel: report.byModel || {},
        sessionCount: agentData.sessionCount || 1,
        entryCount: report.totalEntries,
        firstEntry: agentData.firstEntry,
        lastEntry: agentData.lastEntry,
      };
    } catch (error) {
      // If tokscale fails, fall back to legacy implementation
      return this.getAllStatsLegacy();
    }
  }

  // Hybrid data merging: Read agent attribution from local JSONL
  private async getAgentDataFromLocalLog(): Promise<{
    byAgent: Record<string, { tokens: number; cost: number }>;
    sessionCount: number;
    entryCount: number;
    firstEntry: string | null;
    lastEntry: string | null;
  }> {
    const { calculateCost } = await import("./cost-estimator.js");

    const result = {
      byAgent: {} as Record<string, { tokens: number; cost: number }>,
      sessionCount: 0,
      entryCount: 0,
      firstEntry: null as string | null,
      lastEntry: null as string | null,
    };

    try {
      const content = await fs.readFile(TOKEN_LOG_FILE, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      if (lines.length === 0) {
        return result;
      }

      const sessions = new Set<string>();

      for (const line of lines) {
        const record: TokenUsage = JSON.parse(line);
        result.entryCount++;

        // Track unique sessions
        sessions.add(record.sessionId);

        // Track timestamps
        if (!result.firstEntry || record.timestamp < result.firstEntry) {
          result.firstEntry = record.timestamp;
        }
        if (!result.lastEntry || record.timestamp > result.lastEntry) {
          result.lastEntry = record.timestamp;
        }

        // Calculate cost for this record
        const cost = calculateCost({
          modelName: record.modelName,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheCreationTokens: record.cacheCreationTokens,
          cacheReadTokens: record.cacheReadTokens,
        });

        // Aggregate by agent (use "(main session)" for entries without agentName)
        const agentKey = record.agentName || "(main session)";
        if (!result.byAgent[agentKey]) {
          result.byAgent[agentKey] = { tokens: 0, cost: 0 };
        }
        result.byAgent[agentKey].tokens +=
          record.inputTokens + record.outputTokens;
        result.byAgent[agentKey].cost += cost.totalCost;
      }

      result.sessionCount = sessions.size;
      return result;
    } catch (error) {
      // If file doesn't exist or is empty, return empty result
      return result;
    }
  }

  private async getAllStatsLegacy(): Promise<AggregateTokenStats> {
    const { calculateCost } = await import("./cost-estimator.js");

    const stats: AggregateTokenStats = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreation: 0,
      totalCacheRead: 0,
      totalCost: 0,
      byAgent: {},
      byModel: {},
      sessionCount: 0,
      entryCount: 0,
      firstEntry: null,
      lastEntry: null,
    };

    try {
      const content = await fs.readFile(TOKEN_LOG_FILE, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      if (lines.length === 0) {
        return stats;
      }

      const sessions = new Set<string>();

      for (const line of lines) {
        const record: TokenUsage = JSON.parse(line);
        stats.entryCount++;

        // Track unique sessions
        sessions.add(record.sessionId);

        // Track timestamps
        if (!stats.firstEntry || record.timestamp < stats.firstEntry) {
          stats.firstEntry = record.timestamp;
        }
        if (!stats.lastEntry || record.timestamp > stats.lastEntry) {
          stats.lastEntry = record.timestamp;
        }

        // Aggregate totals
        stats.totalInputTokens += record.inputTokens;
        stats.totalOutputTokens += record.outputTokens;
        stats.totalCacheCreation += record.cacheCreationTokens;
        stats.totalCacheRead += record.cacheReadTokens;

        // Calculate cost for this record
        const cost = calculateCost({
          modelName: record.modelName,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheCreationTokens: record.cacheCreationTokens,
          cacheReadTokens: record.cacheReadTokens,
        });
        stats.totalCost += cost.totalCost;

        // Aggregate by agent (use "(main session)" for entries without agentName)
        const agentKey = record.agentName || "(main session)";
        if (!stats.byAgent[agentKey]) {
          stats.byAgent[agentKey] = { tokens: 0, cost: 0 };
        }
        stats.byAgent[agentKey].tokens +=
          record.inputTokens + record.outputTokens;
        stats.byAgent[agentKey].cost += cost.totalCost;

        // Aggregate by model
        if (!stats.byModel[record.modelName]) {
          stats.byModel[record.modelName] = { tokens: 0, cost: 0 };
        }
        stats.byModel[record.modelName].tokens +=
          record.inputTokens + record.outputTokens;
        stats.byModel[record.modelName].cost += cost.totalCost;
      }

      stats.sessionCount = sessions.size;
      return stats;
    } catch (error) {
      // If file doesn't exist or is empty, return empty stats
      return stats;
    }
  }

  async getTopAgentsAllSessions(
    limit: number = 5,
  ): Promise<Array<{ agent: string; tokens: number; cost: number }>> {
    const allStats = await this.getAllStats();

    const agentStats = Object.entries(allStats.byAgent).map(
      ([agent, stats]) => ({
        agent,
        tokens: stats.tokens,
        cost: stats.cost,
      }),
    );

    return agentStats.sort((a, b) => b.cost - a.cost).slice(0, limit);
  }

  async getTopAgents(
    limit: number = 5,
  ): Promise<Array<{ agent: string; tokens: number; cost: number }>> {
    const { calculateCost } = await import("./cost-estimator.js");

    const agentStats = Object.entries(this.sessionStats.byAgent).map(
      ([agent, usages]) => {
        const totalTokens = usages.reduce(
          (sum, u) => sum + u.inputTokens + u.outputTokens,
          0,
        );
        const totalCost = usages.reduce((sum, u) => {
          const cost = calculateCost({
            modelName: u.modelName,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheCreationTokens: u.cacheCreationTokens,
            cacheReadTokens: u.cacheReadTokens,
          });
          return sum + cost.totalCost;
        }, 0);

        return { agent, tokens: totalTokens, cost: totalCost };
      },
    );

    return agentStats.sort((a, b) => b.cost - a.cost).slice(0, limit);
  }

  async cleanupOldLogs(retentionDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    try {
      const content = await fs.readFile(TOKEN_LOG_FILE, "utf-8");
      const lines = content.trim().split("\n");
      let kept = 0;
      let removed = 0;

      const filteredLines = lines.filter((line) => {
        const record: TokenUsage = JSON.parse(line);
        const recordDate = new Date(record.timestamp);
        if (recordDate >= cutoffDate) {
          kept++;
          return true;
        }
        removed++;
        return false;
      });

      await fs.writeFile(
        TOKEN_LOG_FILE,
        filteredLines.join("\n") + "\n",
        "utf-8",
      );
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
  globalTracker = new TokenTracker(sessionId, true);
  return globalTracker;
}

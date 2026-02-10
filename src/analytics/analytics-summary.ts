/**
 * Analytics Summary - Fast session analytics loading
 *
 * This module provides mtime-based caching for <10ms session load times.
 */

export interface AnalyticsSummary {
  sessionId: string;
  lastUpdated: string;
  lastLogOffset: number;  // For incremental JSONL reads
  totals: {
    inputTokens: number;
    outputTokens: number;  // Estimated
    cacheCreationTokens: number;
    cacheReadTokens: number;
    estimatedCost: number;
  };
  topAgents: Array<{ agent: string; cost: number; tokens: number }>;
  cacheHitRate: number;
}

import { homedir } from 'os';
import { join } from 'path';

/**
 * Get summary file path for session ID.
 */
export function getSummaryPath(sessionId: string): string {
  return join(homedir(), '.omc', 'state', `analytics-summary-${sessionId}.json`);
}

/**
 * Initialize empty summary for new session.
 */
export function createEmptySummary(sessionId: string): AnalyticsSummary {
  return {
    sessionId,
    lastUpdated: new Date().toISOString(),
    lastLogOffset: 0,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCost: 0
    },
    topAgents: [],
    cacheHitRate: 0
  };
}

import * as fs from 'fs/promises';
import { calculateCost } from './cost-estimator.js';
import { TokenUsage } from './types.js';

/**
 * Get file modification time
 */
async function getFileMtime(filePath: string): Promise<Date | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime;
  } catch {
    return null;
  }
}

/**
 * Update top agents list
 */
function updateTopAgents(
  summary: AnalyticsSummary,
  agentName: string,
  cost: number,
  tokens: number
): void {
  let agent = summary.topAgents.find(a => a.agent === agentName);

  if (!agent) {
    agent = { agent: agentName, cost: 0, tokens: 0 };
    summary.topAgents.push(agent);
  }

  agent.cost += cost;
  agent.tokens += tokens;

  // Sort by cost and keep top 10
  summary.topAgents.sort((a, b) => b.cost - a.cost);
  summary.topAgents = summary.topAgents.slice(0, 10);
}

/**
 * Calculate cache hit rate percentage
 */
function calculateCacheHitRate(totals: AnalyticsSummary['totals']): number {
  const total = totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  if (total === 0) return 0;
  return (totals.cacheReadTokens / total) * 100;
}

/**
 * Rebuild summary incrementally from JSONL log.
 *
 * Starts from lastLogOffset to avoid re-processing entire log.
 */
async function rebuildSummaryIncremental(
  sessionId: string,
  summaryPath: string,
  logPath: string
): Promise<AnalyticsSummary> {
  let summary: AnalyticsSummary;
  let startOffset = 0;

  try {
    // Try to load existing summary
    const content = await fs.readFile(summaryPath, 'utf-8');
    summary = JSON.parse(content);
    startOffset = summary.lastLogOffset;
  } catch {
    // Start fresh
    summary = createEmptySummary(sessionId);
  }

  // Read JSONL from lastLogOffset
  const logContent = await fs.readFile(logPath, 'utf-8');
  const lines = logContent.split('\n').slice(startOffset);

  for (const line of lines) {
    if (!line.trim()) continue;

    const record: TokenUsage = JSON.parse(line);
    if (record.sessionId !== sessionId) continue;

    // Update totals
    summary.totals.inputTokens += record.inputTokens || 0;
    summary.totals.outputTokens += record.outputTokens || 0;
    summary.totals.cacheCreationTokens += record.cacheCreationTokens || 0;
    summary.totals.cacheReadTokens += record.cacheReadTokens || 0;

    // Update cost
    const cost = calculateCost({
      modelName: record.modelName,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      cacheReadTokens: record.cacheReadTokens
    });
    summary.totals.estimatedCost += cost.totalCost;

    // Update top agents (use "(main session)" for entries without agentName)
    const agentKey = record.agentName || '(main session)';
    updateTopAgents(
      summary,
      agentKey,
      cost.totalCost,
      record.inputTokens + record.outputTokens
    );
  }

  // Update metadata
  summary.lastUpdated = new Date().toISOString();
  summary.lastLogOffset = startOffset + lines.length;
  summary.cacheHitRate = calculateCacheHitRate(summary.totals);

  // Save updated summary
  const summaryDir = join(homedir(), '.omc', 'state');
  await fs.mkdir(summaryDir, { recursive: true });
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  return summary;
}

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
export async function loadAnalyticsFast(sessionId: string): Promise<AnalyticsSummary | null> {
  const summaryPath = getSummaryPath(sessionId);
  const logPath = join(homedir(), '.omc', 'state', 'token-tracking.jsonl');

  try {
    // Check if summary exists and is fresh
    const summaryMtime = await getFileMtime(summaryPath);
    const logMtime = await getFileMtime(logPath);

    if (summaryMtime && logMtime && summaryMtime >= logMtime) {
      // Summary is up-to-date, use cached version
      const content = await fs.readFile(summaryPath, 'utf-8');
      return JSON.parse(content);
    }

    // Need to rebuild (incremental if summary exists)
    return await rebuildSummaryIncremental(sessionId, summaryPath, logPath);
  } catch (error) {
    // No summary exists yet or error reading
    return null;
  }
}

/**
 * Force rebuild summary from scratch (ignore cache)
 */
export async function rebuildAnalyticsSummary(sessionId: string): Promise<AnalyticsSummary> {
  const summaryPath = getSummaryPath(sessionId);
  const logPath = join(homedir(), '.omc', 'state', 'token-tracking.jsonl');

  // Delete existing summary to force full rebuild
  try {
    await fs.unlink(summaryPath);
  } catch {
    // Ignore if doesn't exist
  }

  return await rebuildSummaryIncremental(sessionId, summaryPath, logPath);
}

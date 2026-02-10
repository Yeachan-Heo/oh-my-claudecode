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
export async function getAnalyticsDisplay(): Promise<AnalyticsDisplay> {
  try {
    // Dynamic imports to avoid circular dependencies and handle missing modules
    const { getTokenTracker } = await import('../analytics/token-tracker.js');
    const { calculateCost, formatCost, getCostColor } = await import('../analytics/cost-estimator.js');

    const tracker = getTokenTracker();
    const stats = tracker.getSessionStats();

    // Calculate total cost
    let totalCost = 0;
    for (const [model, usages] of Object.entries(stats.byModel)) {
      for (const usage of usages) {
        const cost = calculateCost({
          modelName: model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          cacheReadTokens: usage.cacheReadTokens
        });
        totalCost += cost.totalCost;
      }
    }

    // Get top agents
    const topAgents = await tracker.getTopAgents(3);
    const topAgentsStr = topAgents.length > 0
      ? topAgents.map(a => `${a.agent}:${formatCost(a.cost)}`).join(' ')
      : 'none';

    // Calculate cache efficiency
    const totalCacheRead = stats.totalCacheRead;
    const totalInput = stats.totalInputTokens + stats.totalCacheCreation + stats.totalCacheRead;
    const cacheHitRate = totalInput > 0 ? (totalCacheRead / totalInput) * 100 : 0;
    const cacheEfficiency = `${cacheHitRate.toFixed(1)}%`;

    // Format totals
    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
    const sessionTokens = formatTokenCount(totalTokens);
    const sessionCost = formatCost(totalCost);
    const costColor = getCostColor(totalCost);

    return {
      sessionCost,
      sessionTokens,
      topAgents: topAgentsStr,
      cacheEfficiency,
      costColor
    };
  } catch (error) {
    // Return safe defaults if analytics not yet initialized
    return {
      sessionCost: '$0.00',
      sessionTokens: '0',
      topAgents: 'none',
      cacheEfficiency: '0%',
      costColor: 'green'
    };
  }
}

/**
 * Format token count with K/M suffix for readability.
 */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

/**
 * Get color indicator emoji for cost color.
 */
function getCostColorIndicator(color: 'green' | 'yellow' | 'red'): string {
  switch (color) {
    case 'green': return '🟢';
    case 'yellow': return '🟡';
    case 'red': return '🔴';
  }
}

/**
 * Get indicator emoji for health status.
 */
function getHealthIndicator(health: 'healthy' | 'warning' | 'critical'): string {
  switch (health) {
    case 'healthy': return '🟢';
    case 'warning': return '🟡';
    case 'critical': return '🔴';
  }
}

/**
 * Render analytics as a single-line string for HUD display.
 * @deprecated Use renderAnalyticsLineWithConfig() for config-aware rendering
 */
export function renderAnalyticsLine(analytics: AnalyticsDisplay): string {
  const costIndicator = getCostColorIndicator(analytics.costColor);

  return `${costIndicator} Cost: ${analytics.sessionCost} | Tokens: ${analytics.sessionTokens} | Cache: ${analytics.cacheEfficiency} | Top: ${analytics.topAgents}`;
}

/**
 * Render analytics respecting showCost/showCache config flags.
 */
export function renderAnalyticsLineWithConfig(
  analytics: AnalyticsDisplay,
  showCost: boolean,
  showCache: boolean
): string {
  const parts: string[] = [];

  if (showCost) {
    const costIndicator = getCostColorIndicator(analytics.costColor);
    parts.push(`${costIndicator} Cost: ${analytics.sessionCost}`);
  }

  if (showCache) {
    parts.push(`Cache: ${analytics.cacheEfficiency}`);
  }

  parts.push(`Top: ${analytics.topAgents}`);

  return parts.join(' | ');
}

/**
 * Get current session info for HUD display.
 */
export async function getSessionInfo(): Promise<string> {
  try {
    const { getSessionManager } = await import('../analytics/session-manager.js');
    const manager = getSessionManager();
    const session = await manager.getCurrentSession();

    if (!session) {
      return 'No active session';
    }

    const duration = Date.now() - new Date(session.startTime).getTime();
    const durationMinutes = Math.floor(duration / 60000);
    const tags = session.tags.join(',');

    return `Session: ${session.id.slice(-8)} | ${durationMinutes}m | Tags: ${tags}`;
  } catch (error) {
    return 'Session info unavailable';
  }
}

/**
 * Extract structured analytics data from SessionHealth
 */
export function getSessionHealthAnalyticsData(sessionHealth: SessionHealth): SessionHealthAnalyticsData {
  const costIndicator = getHealthIndicator(sessionHealth.health);

  const costPrefix = sessionHealth.isEstimated ? '~' : '';
  const cost = `${costPrefix}$${(sessionHealth.sessionCost ?? 0).toFixed(4)}`;
  const tokens = formatTokenCount(sessionHealth.totalTokens ?? 0);
  const cache = `${(sessionHealth.cacheHitRate ?? 0).toFixed(1)}%`;
  const costHour = sessionHealth.costPerHour ? `$${sessionHealth.costPerHour.toFixed(2)}/h` : '';

  return { costIndicator, cost, tokens, cache, costHour };
}

/**
 * Render analytics from SessionHealth (no longer calls TokenTracker directly)
 * @deprecated Use getSessionHealthAnalyticsData() and compose in render.ts for config-aware rendering
 */
export function renderSessionHealthAnalytics(sessionHealth: SessionHealth): string {
  const data = getSessionHealthAnalyticsData(sessionHealth);
  const parts = [data.costIndicator, data.cost, data.tokens, `Cache: ${data.cache}`];
  if (data.costHour) parts.push(data.costHour);
  return parts.join(' | ');
}

/**
 * Render budget warning if cost exceeds thresholds
 */
export function renderBudgetWarning(sessionHealth: SessionHealth): string {
  const cost = sessionHealth.sessionCost ?? 0;

  if (cost > 5.0) {
    return `⚠️  BUDGET ALERT: Session cost ${cost.toFixed(2)} exceeds $5.00`;
  } else if (cost > 2.0) {
    return `⚡ Budget notice: Session cost ${cost.toFixed(2)} approaching limit`;
  }

  return '';
}

/**
 * Render cache efficiency meter
 */
export function renderCacheEfficiency(sessionHealth: SessionHealth): string {
  const rate = sessionHealth.cacheHitRate ?? 0;

  const barLength = 20;
  const filled = Math.round((rate / 100) * barLength);
  const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

  return `Cache: ${bar} ${rate.toFixed(1)}%`;
}

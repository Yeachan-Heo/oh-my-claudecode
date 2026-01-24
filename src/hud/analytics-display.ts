/**
 * OMC HUD - Analytics Display
 *
 * Display components for token tracking and cost analytics in the HUD.
 */

export interface AnalyticsDisplay {
  sessionCost: string;
  sessionTokens: string;
  topAgents: string;
  cacheEfficiency: string;
  costColor: 'green' | 'yellow' | 'red';
}

/**
 * Get analytics display data for the current session.
 * Safe to call even if analytics modules are not initialized.
 *
 * @returns Analytics display data with safe defaults
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
    const totalInput = stats.totalInputTokens;
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
 * Render analytics as a single-line string for HUD display.
 */
export function renderAnalyticsLine(analytics: AnalyticsDisplay): string {
  const costIndicator = analytics.costColor === 'green' ? '●' :
                        analytics.costColor === 'yellow' ? '●' : '●';

  return `${costIndicator} Cost: ${analytics.sessionCost} | Tokens: ${analytics.sessionTokens} | Cache: ${analytics.cacheEfficiency} | Top: ${analytics.topAgents}`;
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

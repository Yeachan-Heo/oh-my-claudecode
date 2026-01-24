import { getTokenTracker } from '../../analytics/token-tracker.js';
import { getSessionManager } from '../../analytics/session-manager.js';
import { colors, formatCostWithColor, formatTokenCount, formatDuration } from '../utils/formatting.js';

export async function statsCommand(options: { json?: boolean }): Promise<void> {
  const tracker = getTokenTracker();
  const manager = getSessionManager();

  const stats = tracker.getSessionStats();
  const session = await manager.getCurrentSession();
  const topAgents = await tracker.getTopAgents(5);

  if (options.json) {
    console.log(JSON.stringify({ stats, session, topAgents }, null, 2));
    return;
  }

  // Display session info
  console.log(colors.bold('\n📊 Current Session Stats\n'));

  if (session) {
    const duration = Date.now() - new Date(session.startTime).getTime();
    console.log(`Session ID: ${colors.cyan(session.id)}`);
    console.log(`Duration: ${formatDuration(duration)}`);
    console.log(`Tags: ${session.tags.join(', ')}`);
    console.log(`Goals: ${session.goals.length}`);
  } else {
    console.log(colors.gray('No active session'));
  }

  // Display token stats
  console.log(colors.bold('\n💰 Token Usage & Cost\n'));

  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const totalCost = topAgents.reduce((sum, a) => sum + a.cost, 0);

  console.log(`Total Tokens: ${colors.blue(formatTokenCount(totalTokens))}`);
  console.log(`Input: ${formatTokenCount(stats.totalInputTokens)} | Output: ${formatTokenCount(stats.totalOutputTokens)}`);
  console.log(`Cache Read: ${formatTokenCount(stats.totalCacheRead)} | Cache Write: ${formatTokenCount(stats.totalCacheCreation)}`);
  console.log(`Total Cost: ${formatCostWithColor(totalCost)}`);

  // Display top agents
  if (topAgents.length > 0) {
    console.log(colors.bold('\n🤖 Top Agents by Cost\n'));
    for (const agent of topAgents) {
      console.log(`  ${agent.agent.padEnd(25)} ${formatTokenCount(agent.tokens).padStart(8)} tokens  ${formatCostWithColor(agent.cost)}`);
    }
  }

  console.log('');
}

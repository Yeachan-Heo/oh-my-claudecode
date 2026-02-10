import { getTokenTracker } from '../../analytics/token-tracker.js';
import { getSessionManager } from '../../analytics/session-manager.js';
import { colors, formatCostWithColor, formatTokenCount, formatDuration } from '../utils/formatting.js';
export async function statsCommand(options) {
    const tracker = getTokenTracker();
    const manager = getSessionManager();
    if (options.session) {
        // Show specific session stats (current behavior)
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
        }
        else {
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
    else {
        // Show aggregate stats across all sessions (NEW default)
        const aggregate = await tracker.getAllStats();
        const topAgents = await tracker.getTopAgentsAllSessions(5);
        if (options.json) {
            console.log(JSON.stringify({ aggregate, topAgents }, null, 2));
            return;
        }
        // Display aggregate info
        console.log(colors.bold('\n📊 All Sessions Stats\n'));
        console.log(`Sessions: ${colors.cyan(aggregate.sessionCount.toString())}`);
        console.log(`Entries: ${colors.cyan(aggregate.entryCount.toString())}`);
        if (aggregate.firstEntry && aggregate.lastEntry) {
            const firstDate = new Date(aggregate.firstEntry).toLocaleDateString();
            const lastDate = new Date(aggregate.lastEntry).toLocaleDateString();
            console.log(`Date Range: ${colors.gray(firstDate)} to ${colors.gray(lastDate)}`);
        }
        // Display token stats
        console.log(colors.bold('\n💰 Token Usage & Cost\n'));
        const totalTokens = aggregate.totalInputTokens + aggregate.totalOutputTokens;
        console.log(`Total Tokens: ${colors.blue(formatTokenCount(totalTokens))}`);
        console.log(`Input: ${formatTokenCount(aggregate.totalInputTokens)} | Output: ${formatTokenCount(aggregate.totalOutputTokens)}`);
        console.log(`Cache Read: ${formatTokenCount(aggregate.totalCacheRead)} | Cache Write: ${formatTokenCount(aggregate.totalCacheCreation)}`);
        console.log(`Total Cost: ${formatCostWithColor(aggregate.totalCost)}`);
        // Display top agents (only if data available - not tracked by tokscale)
        if (topAgents.length > 0) {
            console.log(colors.bold('\n🤖 Top Agents by Cost (All Sessions)\n'));
            for (const agent of topAgents) {
                console.log(`  ${agent.agent.padEnd(25)} ${formatTokenCount(agent.tokens).padStart(8)} tokens  ${formatCostWithColor(agent.cost)}`);
            }
        }
        else {
            // Agent tracking is not available when using tokscale
            console.log(colors.gray('\nNo agent data available. Run backfill to enable agent tracking:'));
            console.log(colors.cyan('  omc backfill'));
        }
        console.log('');
    }
}
//# sourceMappingURL=stats.js.map
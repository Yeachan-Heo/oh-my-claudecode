import { getTokenTracker } from '../../analytics/token-tracker.js';
import { colors, renderTable, formatCostWithColor, formatTokenCount } from '../utils/formatting.js';

export async function agentsCommand(options: { json?: boolean; limit?: number }): Promise<void> {
  const tracker = getTokenTracker();
  const stats = tracker.getSessionStats();
  const topAgents = await tracker.getTopAgents(options.limit || 10);

  if (options.json) {
    console.log(JSON.stringify({ topAgents, stats }, null, 2));
    return;
  }

  console.log(colors.bold('\n🤖 Agent Usage Breakdown\n'));

  if (topAgents.length === 0) {
    console.log(colors.gray('No agent usage recorded yet.\n'));
    return;
  }

  const agentData = topAgents.map(agent => ({
    agent: agent.agent,
    tokens: formatTokenCount(agent.tokens),
    cost: agent.cost
  }));

  const table = renderTable(agentData, [
    { header: 'Agent', field: 'agent', width: 35 },
    { header: 'Tokens', field: 'tokens', width: 12, align: 'right' },
    { header: 'Cost', field: 'cost', width: 12, align: 'right', format: (v: number) => formatCostWithColor(v) }
  ]);

  console.log(table);
  console.log('');
}

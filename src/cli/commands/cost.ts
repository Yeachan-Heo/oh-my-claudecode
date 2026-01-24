import { getQueryEngine } from '../../analytics/query-engine.js';
import { colors, renderTable, formatCostWithColor } from '../utils/formatting.js';

export async function costCommand(period: 'daily' | 'weekly' | 'monthly', options: { json?: boolean }): Promise<void> {
  const engine = getQueryEngine();
  const report = await engine.getCostReport(period);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(colors.bold(`\n💵 Cost Report (${period})\n`));
  console.log(`Period: ${report.range.start.split('T')[0]} to ${report.range.end.split('T')[0]}`);
  console.log(`Total Cost: ${formatCostWithColor(report.totalCost)}\n`);

  // By agent
  if (Object.keys(report.byAgent).length > 0) {
    console.log(colors.bold('By Agent:'));
    const agentData = Object.entries(report.byAgent)
      .map(([agent, cost]) => ({ agent, cost }))
      .sort((a, b) => b.cost - a.cost);

    const agentTable = renderTable(agentData, [
      { header: 'Agent', field: 'agent', width: 30 },
      { header: 'Cost', field: 'cost', width: 12, align: 'right', format: (v: number) => formatCostWithColor(v) }
    ]);

    console.log(agentTable);
    console.log('');
  }

  // By model
  if (Object.keys(report.byModel).length > 0) {
    console.log(colors.bold('By Model:'));
    const modelData = Object.entries(report.byModel)
      .map(([model, cost]) => ({ model, cost }))
      .sort((a, b) => b.cost - a.cost);

    const modelTable = renderTable(modelData, [
      { header: 'Model', field: 'model', width: 30 },
      { header: 'Cost', field: 'cost', width: 12, align: 'right', format: (v: number) => formatCostWithColor(v) }
    ]);

    console.log(modelTable);
    console.log('');
  }

  // By day (for weekly/monthly)
  if (report.byDay && Object.keys(report.byDay).length > 0 && period !== 'daily') {
    console.log(colors.bold('By Day:'));
    const dayData = Object.entries(report.byDay)
      .map(([day, cost]) => ({ day, cost }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const dayTable = renderTable(dayData, [
      { header: 'Date', field: 'day', width: 12 },
      { header: 'Cost', field: 'cost', width: 12, align: 'right', format: (v: number) => formatCostWithColor(v) }
    ]);

    console.log(dayTable);
    console.log('');
  }
}

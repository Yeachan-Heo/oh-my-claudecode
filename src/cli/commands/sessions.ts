import { getSessionManager } from '../../analytics/session-manager.js';
import { colors, renderTable, formatDuration } from '../utils/formatting.js';

export async function sessionsCommand(options: { json?: boolean; limit?: number }): Promise<void> {
  const manager = getSessionManager();
  const history = await manager.getHistory();

  if (options.json) {
    console.log(JSON.stringify(history, null, 2));
    return;
  }

  console.log(colors.bold('\n📚 Session History\n'));
  console.log(`Total Sessions: ${history.totalSessions}`);
  console.log(`Total Cost: ${colors.cyan(`$${history.totalCost.toFixed(4)}`)}`);
  console.log(`Success Rate: ${(history.successRate * 100).toFixed(1)}%\n`);

  const limit = options.limit || 10;
  const sessions = history.sessions.slice(-limit).reverse();

  if (sessions.length === 0) {
    console.log(colors.gray('No sessions recorded yet.\n'));
    return;
  }

  const sessionData = sessions.map(session => ({
    id: session.id.slice(-8),
    startTime: session.startTime.split('T')[0],
    duration: session.duration ? formatDuration(session.duration) : 'ongoing',
    status: session.status,
    tags: session.tags.join(',')
  }));

  const table = renderTable(sessionData, [
    { header: 'ID', field: 'id', width: 10 },
    { header: 'Date', field: 'startTime', width: 12 },
    { header: 'Duration', field: 'duration', width: 12 },
    { header: 'Status', field: 'status', width: 12 },
    { header: 'Tags', field: 'tags', width: 25 }
  ]);

  console.log(table);
  console.log('');
}

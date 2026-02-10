import { getSessionManager } from '../../analytics/session-manager.js';
import { getSessionCatalog } from '../../analytics/session-catalog.js';
import { colors, renderTable, formatDuration, formatTokenCount, formatCostWithColor } from '../utils/formatting.js';
/**
 * Get the top agent by token usage from a session's agent breakdown.
 */
function getTopAgent(agentBreakdown) {
    const entries = Object.entries(agentBreakdown);
    if (entries.length === 0)
        return '-';
    entries.sort((a, b) => b[1].tokens - a[1].tokens);
    return entries[0][0];
}
export async function sessionsCommand(options) {
    const limit = options.limit || 10;
    // Primary: use SessionCatalog (derives from token-tracking.jsonl)
    const catalog = getSessionCatalog();
    // Get all sessions first, then slice for display (avoids double file read)
    const allSessions = await catalog.getSessions();
    const catalogSessions = limit ? allSessions.slice(0, limit) : allSessions;
    if (catalogSessions.length > 0) {
        if (options.json) {
            console.log(JSON.stringify(catalogSessions, null, 2));
            return;
        }
        const totalCount = allSessions.length;
        const totalCost = catalogSessions.reduce((sum, s) => sum + s.totalCost, 0);
        console.log(colors.bold('\nSession History\n'));
        console.log(`Total Sessions: ${totalCount}`);
        console.log(`Showing: ${catalogSessions.length} most recent`);
        console.log(`Cost (shown): ${formatCostWithColor(totalCost)}\n`);
        const sessionData = catalogSessions.map(session => {
            const durationMs = new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
            return {
                id: session.sessionId.slice(-8),
                date: session.startTime.split('T')[0],
                duration: durationMs > 0 ? formatDuration(durationMs) : '<1s',
                tokens: formatTokenCount(session.totalTokens),
                cost: `$${session.totalCost.toFixed(4)}`,
                topAgent: getTopAgent(session.agentBreakdown),
            };
        });
        const table = renderTable(sessionData, [
            { header: 'ID', field: 'id', width: 10 },
            { header: 'Date', field: 'date', width: 12 },
            { header: 'Duration', field: 'duration', width: 10 },
            { header: 'Tokens', field: 'tokens', width: 10, align: 'right' },
            { header: 'Cost', field: 'cost', width: 10, align: 'right' },
            { header: 'Top Agent', field: 'topAgent', width: 20 },
        ]);
        console.log(table);
        console.log('');
        return;
    }
    // Fallback: use SessionManager history (legacy)
    const manager = getSessionManager();
    const history = await manager.getHistory();
    if (options.json) {
        console.log(JSON.stringify(history, null, 2));
        return;
    }
    console.log(colors.bold('\nSession History\n'));
    console.log(`Total Sessions: ${history.totalSessions}`);
    console.log(`Total Cost: ${colors.cyan(`$${history.totalCost.toFixed(4)}`)}`);
    console.log(`Success Rate: ${(history.successRate * 100).toFixed(1)}%\n`);
    const sessions = history.sessions.slice(-limit).reverse();
    if (sessions.length === 0) {
        console.log(colors.gray('No sessions recorded yet.'));
        console.log(colors.gray('Run "omc backfill" to populate session data from Claude Code transcripts.\n'));
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
//# sourceMappingURL=sessions.js.map
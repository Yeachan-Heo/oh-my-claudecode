import * as fs from 'fs/promises';
export async function exportCostReport(report, format, outputPath) {
    if (format === 'json') {
        await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');
    }
    else {
        const csv = costReportToCSV(report);
        await fs.writeFile(outputPath, csv, 'utf-8');
    }
}
export async function exportSessionHistory(history, format, outputPath) {
    if (format === 'json') {
        await fs.writeFile(outputPath, JSON.stringify(history, null, 2), 'utf-8');
    }
    else {
        const csv = sessionHistoryToCSV(history);
        await fs.writeFile(outputPath, csv, 'utf-8');
    }
}
export async function exportUsagePatterns(patterns, format, outputPath) {
    if (format === 'json') {
        await fs.writeFile(outputPath, JSON.stringify(patterns, null, 2), 'utf-8');
    }
    else {
        const csv = usagePatternsToCSV(patterns);
        await fs.writeFile(outputPath, csv, 'utf-8');
    }
}
function costReportToCSV(report) {
    const lines = [];
    // Header
    lines.push('Type,Name,Cost');
    // By agent
    for (const [agent, cost] of Object.entries(report.byAgent)) {
        lines.push(`Agent,${agent},${cost.toFixed(4)}`);
    }
    // By model
    for (const [model, cost] of Object.entries(report.byModel)) {
        lines.push(`Model,${model},${cost.toFixed(4)}`);
    }
    // By day
    if (report.byDay) {
        for (const [day, cost] of Object.entries(report.byDay)) {
            lines.push(`Day,${day},${cost.toFixed(4)}`);
        }
    }
    // Total
    lines.push(`Total,,${report.totalCost.toFixed(4)}`);
    return lines.join('\n');
}
function sessionHistoryToCSV(history) {
    const lines = [];
    // Header
    lines.push('SessionID,ProjectPath,StartTime,EndTime,Duration,Status,Tags,Goals,Outcomes');
    // Sessions
    for (const session of history.sessions) {
        const row = [
            session.id,
            session.projectPath,
            session.startTime,
            session.endTime || '',
            session.duration?.toString() || '',
            session.status,
            session.tags.join(';'),
            session.goals.join(';'),
            session.outcomes.join(';')
        ];
        lines.push(row.map(escapeCSV).join(','));
    }
    return lines.join('\n');
}
function usagePatternsToCSV(patterns) {
    const lines = [];
    // Header
    lines.push('Type,Value,Cost');
    // Peak hours
    lines.push(`PeakHours,${patterns.peakHours.join(';')},`);
    // Most expensive operations
    for (const op of patterns.mostExpensiveOperations) {
        lines.push(`Operation,${op.operation},${op.cost.toFixed(4)}`);
    }
    // Summary stats
    lines.push(`AverageCostPerSession,,${patterns.averageCostPerSession.toFixed(4)}`);
    lines.push(`TotalSessions,${patterns.totalSessions},`);
    return lines.join('\n');
}
function escapeCSV(value) {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}
//# sourceMappingURL=export.js.map
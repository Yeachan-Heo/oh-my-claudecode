import chalk from 'chalk';
import { generateSessionFrictionReport, } from '../../features/session-friction-report/index.js';
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function formatTimestamp(timestamp) {
    if (!timestamp)
        return 'unknown time';
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}
function topSignal(session) {
    const signal = session.signals.find((candidate) => candidate.severity !== 'info') ?? session.signals[0];
    return signal ? `${signal.code}: ${signal.message}` : 'no-obvious-friction';
}
export function formatSessionFrictionReport(report) {
    const lines = [
        chalk.blue('Local session friction report'),
        chalk.gray(`Scope: ${report.scope.mode}${report.scope.since ? ` since ${report.scope.since}` : ''}`),
        chalk.gray(report.privacy.summary),
        '',
        `Sessions: ${report.totals.sessions}`,
        `Transcript volume: ${formatBytes(report.totals.transcriptBytes)} across ${report.totals.transcriptLines} local JSON/JSONL entries`,
        `Tool/error signals: ${report.totals.toolCalls} tool events, ${report.totals.errorResults} error/failure markers`,
        `Warnings: ${report.totals.warningSignals}, Critical: ${report.totals.criticalSignals}`,
    ];
    if (report.sessions.length === 0) {
        lines.push('', chalk.yellow('No local session artifacts found for this scope.'));
        return lines.join('\n');
    }
    lines.push('', chalk.bold('Highest-friction sessions:'));
    report.sessions.forEach((session, index) => {
        const context = session.estimatedContextPercent === null ? 'unknown' : `${session.estimatedContextPercent}%`;
        lines.push(`${index + 1}. ${chalk.bold(session.sessionId)} — score ${session.frictionScore}/100`);
        lines.push(`   Last activity: ${formatTimestamp(session.lastTimestamp)}`);
        if (session.projectPath)
            lines.push(`   Project: ${session.projectPath}`);
        lines.push(`   Size/turns: ${formatBytes(session.transcriptBytes)}, ${session.userTurns} user turns, ${session.assistantTurns} assistant turns`);
        lines.push(`   Tools/errors: ${session.toolCalls + session.replayToolCalls} tool events, ${session.errorResults + session.replayAgentsFailed} error/failure markers`);
        lines.push(`   Context estimate: ${context}; largest message: ${formatBytes(session.largestMessageBytes)}`);
        lines.push(`   Main signal: ${topSignal(session)}`);
    });
    return lines.join('\n');
}
export async function sessionFrictionReportCommand(options, logger = console) {
    const report = await generateSessionFrictionReport({
        limit: options.limit,
        sessionId: options.session,
        since: options.since,
        project: options.project,
        workingDirectory: options.workingDirectory,
    });
    logger.log(options.json ? JSON.stringify(report, null, 2) : formatSessionFrictionReport(report));
    return report;
}
//# sourceMappingURL=session-friction-report.js.map
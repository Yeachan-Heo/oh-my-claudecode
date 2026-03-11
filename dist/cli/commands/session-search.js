import chalk from 'chalk';
import { searchSessionHistory, } from '../../features/session-history-search/index.js';
function formatTimestamp(timestamp) {
    if (!timestamp)
        return 'unknown time';
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}
export function formatSessionSearchReport(report) {
    if (report.totalMatches === 0) {
        return [
            `No session history matches found for ${chalk.cyan(JSON.stringify(report.query))}.`,
            chalk.gray(`Searched ${report.searchedFiles} files in ${report.scope.mode} scope.`),
        ].join('\n');
    }
    const lines = [
        chalk.blue(`Session history matches for ${JSON.stringify(report.query)}`),
        chalk.gray(`Showing ${report.results.length} of ${report.totalMatches} matches across ${report.searchedFiles} files (${report.scope.mode} scope)`),
        '',
    ];
    report.results.forEach((result, index) => {
        lines.push(`${chalk.bold(`${index + 1}.`)} ${result.sessionId}${result.agentId ? chalk.gray(` [agent:${result.agentId}]`) : ''}`);
        lines.push(`   ${chalk.gray(formatTimestamp(result.timestamp))}`);
        if (result.projectPath) {
            lines.push(`   ${chalk.gray(result.projectPath)}`);
        }
        lines.push(`   ${result.excerpt}`);
        lines.push(`   ${chalk.gray(`${result.sourcePath}:${result.line}`)}`);
        lines.push('');
    });
    return lines.join('\n').trimEnd();
}
export async function sessionSearchCommand(query, options, logger = console) {
    const report = await searchSessionHistory({
        query,
        limit: options.limit,
        sessionId: options.session,
        since: options.since,
        project: options.project,
        caseSensitive: options.caseSensitive,
        contextChars: options.context,
        workingDirectory: options.workingDirectory,
    });
    logger.log(options.json ? JSON.stringify(report, null, 2) : formatSessionSearchReport(report));
    return report;
}
//# sourceMappingURL=session-search.js.map
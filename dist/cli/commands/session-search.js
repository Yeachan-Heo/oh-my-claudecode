import chalk from 'chalk';
import { searchSessionHistory, } from '../../features/session-history-search/index.js';
function terminalText(value) {
    return value.replace(/[\x00-\x1f\x7f-\x9f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
function formatTimestamp(timestamp) {
    if (!timestamp)
        return 'unknown time';
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}
export function formatSessionSearchReport(report) {
    if (report.totalMatches === 0) {
        return [
            `No session history matches found for ${chalk.cyan(terminalText(JSON.stringify(report.query)))}.`,
            chalk.gray(`Searched ${report.searchedFiles} files in ${report.scope.mode} scope.`),
        ].join('\n');
    }
    const lines = [
        chalk.blue(`Session history matches for ${terminalText(JSON.stringify(report.query))}`),
        chalk.gray(`Showing ${report.results.length} of ${report.totalMatches} matches across ${report.searchedFiles} files (${report.scope.mode} scope)`),
        '',
    ];
    report.results.forEach((result, index) => {
        lines.push(`${chalk.bold(`${index + 1}.`)} ${terminalText(result.sessionId)}${result.agentId ? chalk.gray(` [agent:${terminalText(result.agentId)}]`) : ''}`);
        lines.push(`   ${chalk.gray(terminalText(formatTimestamp(result.timestamp)))}`);
        if (result.projectPath) {
            lines.push(`   ${chalk.gray(terminalText(result.projectPath))}`);
        }
        lines.push(`   ${terminalText(result.excerpt)}`);
        lines.push(`   ${chalk.gray(`${terminalText(result.sourcePath)}:${result.line}`)}`);
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
    // JSON.stringify already escapes C0 inside strings, but leaves DEL/C1 raw.
    // Unicode escapes keep terminal output inert without changing parsed data.
    const serialized = options.json
        ? JSON.stringify(report, null, 2).replace(/[\x7f-\x9f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
        : formatSessionSearchReport(report);
    logger.log(serialized);
    return report;
}
//# sourceMappingURL=session-search.js.map
/**
 * lookout command - pre-flight danger scan for autonomous runs.
 *
 * Thin CLI adapter only: all scanning logic lives in
 * src/features/lookout/index.ts. lookout is advisory by design: a scan
 * never blocks anything. Exit code contract (machine-readable, mirrors the
 * drydock follow-up wording):
 *   0 = scan ran, no high-severity findings (with or without --strict)
 *   1 = --strict and the verdict is review-recommended
 *   2 = usage or scan error
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { LookoutError, resolveBriefArg, scanLookout, } from '../features/lookout/index.js';
const VERDICT_LABEL = {
    clear: 'clear — no danger signals',
    advisory: 'advisory — review the notes below when convenient',
    'review-recommended': 'review recommended — high-risk signals present',
};
const SEVERITY_BADGE = {
    high: chalk.red('HIGH'),
    medium: chalk.yellow('MED '),
    low: chalk.cyan('LOW '),
    info: chalk.gray('INFO'),
};
function errorMessage(error) {
    if (error instanceof LookoutError)
        return error.message;
    return error instanceof Error ? error.message : String(error);
}
function fail(message, code) {
    console.error(chalk.red(`Error: ${message}`));
    process.exitCode = code;
}
function safeEvidence(value) {
    return JSON.stringify(value).slice(1, -1);
}
function printHuman(report) {
    console.log(chalk.bold('🚨 lookout report'));
    console.log(`verdict: ${chalk.bold(VERDICT_LABEL[report.summary.verdict])}` +
        ` (high: ${report.summary.counts.high}, medium: ${report.summary.counts.medium},` +
        ` low: ${report.summary.counts.low})`);
    if (report.findings.length === 0) {
        console.log('No danger signals found. lookout is advisory — it never blocks a run.');
        return;
    }
    for (const finding of report.findings) {
        console.log('');
        console.log(`${SEVERITY_BADGE[finding.severity]}  ${chalk.bold(finding.title)}  ${chalk.dim(finding.id)}`);
        for (const item of finding.evidence) {
            const safe = safeEvidence(item);
            console.log(`    evidence: ${chalk.italic(safe.length > 120 ? `${safe.slice(0, 117)}...` : safe)}`);
        }
        console.log(`    advice: ${finding.advice}`);
    }
    console.log('');
}
/**
 * Returns the `lookout` command:
 *
 *   omc lookout scan [--brief <text|@file>] [--json] [--strict] [--repo <dir>]
 */
export function lookoutCommand() {
    const command = new Command('lookout');
    command.description('Pre-flight danger scan for autonomous runs (advisory only, never blocks)');
    // Remap Commander usage failures (e.g. a value-taking option given without
    // its value) to the documented scan-error exit code 2, so scripts can
    // distinguish malformed input from findings-driven --strict exits.
    // Help/version output stays exit 0. The rethrown CommanderError is caught
    // by the program parse wrapper in cli/index.ts.
    command.exitOverride((err) => {
        err.exitCode =
            err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help'
                ? 0
                : 2;
        throw err;
    });
    command
        .command('scan')
        .description('Scan a task briefing and/or the workspace for danger signals')
        .option('--brief <text|@file>', 'Task briefing text, or @path to a briefing file')
        .option('--repo <dir>', 'Repository to scan (defaults to cwd)', process.cwd())
        .option('--json', 'Emit the machine-readable report (findings/severity/confidence contract)')
        .option('--strict', 'Exit 1 when the verdict is review-recommended (for scripts that want to pause)')
        .action((options) => {
        try {
            let brief;
            let briefSource = 'none';
            if (options.brief !== undefined) {
                const resolved = resolveBriefArg(options.brief);
                brief = resolved.text;
                briefSource = resolved.source;
            }
            const report = scanLookout({ repo: options.repo, brief, briefSource });
            if (options.json) {
                console.log(JSON.stringify(report, null, 2));
            }
            else {
                printHuman(report);
            }
            if (options.strict && report.summary.verdict === 'review-recommended') {
                process.exitCode = 1;
            }
        }
        catch (error) {
            fail(errorMessage(error), error instanceof LookoutError ? error.exitCode : 2);
        }
    });
    return command;
}
//# sourceMappingURL=lookout.js.map
#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import { statsCommand } from './commands/stats.js';
import { costCommand } from './commands/cost.js';
import { sessionsCommand } from './commands/sessions.js';
import { agentsCommand } from './commands/agents.js';
import { exportCommand } from './commands/export.js';
import { cleanupCommand } from './commands/cleanup.js';
import { launchTokscaleTUI, isTokscaleCLIAvailable, getInstallInstructions } from './utils/tokscale-launcher.js';
program
    .name('omc-analytics')
    .description('OMC Analytics CLI - Token tracking, cost reports, and session management')
    .version('1.0.0');
// Stats command
program
    .command('stats')
    .description('Show current session statistics')
    .option('--json', 'Output as JSON')
    .action(statsCommand);
// Cost command
program
    .command('cost [period]')
    .description('Generate cost report (period: daily, weekly, monthly)')
    .option('--json', 'Output as JSON')
    .action((period = 'monthly', options) => {
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
        console.error('Invalid period. Use: daily, weekly, or monthly');
        process.exit(1);
    }
    costCommand(period, options);
});
// Sessions command
program
    .command('sessions')
    .description('View session history')
    .option('--json', 'Output as JSON')
    .option('--limit <number>', 'Limit number of sessions', '10')
    .action(options => {
    sessionsCommand({ ...options, limit: parseInt(options.limit) });
});
// Agents command
program
    .command('agents')
    .description('Show agent usage breakdown')
    .option('--json', 'Output as JSON')
    .option('--limit <number>', 'Limit number of agents', '10')
    .action(options => {
    agentsCommand({ ...options, limit: parseInt(options.limit) });
});
// Export command
program
    .command('export <type> <format> <output>')
    .description('Export data (type: cost, sessions, patterns; format: json, csv)')
    .option('--period <period>', 'Period for cost report (daily, weekly, monthly)', 'monthly')
    .action((type, format, output, options) => {
    if (!['cost', 'sessions', 'patterns'].includes(type)) {
        console.error('Invalid type. Use: cost, sessions, or patterns');
        process.exit(1);
    }
    if (!['json', 'csv'].includes(format)) {
        console.error('Invalid format. Use: json or csv');
        process.exit(1);
    }
    exportCommand(type, format, output, options);
});
// Cleanup command
program
    .command('cleanup')
    .description('Clean up old logs and orphaned background tasks')
    .option('--retention <days>', 'Retention period in days', '30')
    .action(options => {
    cleanupCommand({ ...options, retention: parseInt(options.retention) });
});
// TUI command
program
    .command('tui')
    .description('Launch tokscale interactive TUI for token visualization')
    .option('--models', 'Show models view')
    .option('--daily', 'Show daily/monthly view')
    .option('--no-claude', 'Show all providers (not just Claude)')
    .action(async (options) => {
    const available = await isTokscaleCLIAvailable();
    if (!available) {
        console.log(chalk.yellow('tokscale is not installed.'));
        console.log(getInstallInstructions());
        process.exit(1);
    }
    const view = options.models ? 'models'
        : options.daily ? 'daily'
            : 'overview';
    try {
        await launchTokscaleTUI({
            view,
            claude: options.claude
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Failed to launch TUI: ${message}`));
        process.exit(1);
    }
});
program.parse();
//# sourceMappingURL=analytics.js.map
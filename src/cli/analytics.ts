#!/usr/bin/env node

import { program } from 'commander';
import { statsCommand } from './commands/stats.js';
import { costCommand } from './commands/cost.js';
import { sessionsCommand } from './commands/sessions.js';
import { agentsCommand } from './commands/agents.js';
import { exportCommand } from './commands/export.js';
import { cleanupCommand } from './commands/cleanup.js';

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
    costCommand(period as 'daily' | 'weekly' | 'monthly', options);
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
    exportCommand(type as any, format as any, output, options);
  });

// Cleanup command
program
  .command('cleanup')
  .description('Clean up old logs and orphaned background tasks')
  .option('--retention <days>', 'Retention period in days', '30')
  .action(options => {
    cleanupCommand({ ...options, retention: parseInt(options.retention) });
  });

program.parse();

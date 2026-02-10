#!/usr/bin/env node
/**
 * Oh-My-Claude-Sisyphus CLI
 *
 * Command-line interface for the Sisyphus multi-agent system.
 *
 * Commands:
 * - run: Start an interactive session
 * - init: Initialize configuration in current directory
 * - config: Show or edit configuration
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import * as fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { loadConfig, getConfigPaths, generateConfigSchema } from '../config/loader.js';
import { createSisyphusSession } from '../index.js';
import { checkForUpdates, performUpdate, formatUpdateNotification, getInstalledVersion, getSisyphusConfig, CONFIG_FILE, } from '../features/auto-update.js';
import { install as installSisyphus, isInstalled, getInstallInfo } from '../installer/index.js';
import { statsCommand } from './commands/stats.js';
import { costCommand } from './commands/cost.js';
import { sessionsCommand } from './commands/sessions.js';
import { agentsCommand } from './commands/agents.js';
import { exportCommand } from './commands/export.js';
import { cleanupCommand } from './commands/cleanup.js';
import { backfillCommand } from './commands/backfill.js';
import { launchTokscaleTUI, isTokscaleCLIAvailable, getInstallInstructions } from './utils/tokscale-launcher.js';
import { waitCommand, waitStatusCommand, waitDaemonCommand, waitDetectCommand } from './commands/wait.js';
import { doctorConflictsCommand } from './commands/doctor-conflicts.js';
import { teleportCommand, teleportListCommand, teleportRemoveCommand } from './commands/teleport.js';
import { getRuntimePackageVersion } from '../lib/version.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const version = getRuntimePackageVersion();
const program = new Command();
// Helper functions for auto-backfill
async function checkIfBackfillNeeded() {
    const tokenLogPath = join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
    try {
        await fs.access(tokenLogPath);
        const stats = await fs.stat(tokenLogPath);
        // Backfill if file is older than 1 hour or very small
        const ageMs = Date.now() - stats.mtimeMs;
        return stats.size < 100 || ageMs > 3600000;
    }
    catch {
        return true; // File doesn't exist
    }
}
async function runQuickBackfill(silent = false) {
    const { BackfillEngine } = await import('../analytics/backfill-engine.js');
    const engine = new BackfillEngine();
    const result = await engine.run({ verbose: false });
    if (result.entriesAdded > 0 && !silent) {
        console.log(chalk.green(`Backfilled ${result.entriesAdded} entries in ${result.timeElapsed}ms`));
    }
}
// Auto-backfill before analytics commands
async function ensureBackfillDone() {
    const shouldBackfill = await checkIfBackfillNeeded();
    if (shouldBackfill) {
        await runQuickBackfill(true); // Silent backfill for subcommands
    }
}
// Display enhanced banner using gradient-string (loaded dynamically)
async function displayAnalyticsBanner() {
    try {
        // @ts-expect-error - gradient-string will be installed during setup
        const gradient = await import('gradient-string');
        const banner = gradient.default.pastel.multiline([
            '╔═══════════════════════════════════════╗',
            '║   Oh-My-ClaudeCode - Analytics Dashboard   ║',
            '╚═══════════════════════════════════════╝'
        ].join('\n'));
        console.log(banner);
        console.log('');
    }
    catch (error) {
        // Fallback if gradient-string not installed
        console.log('╔═══════════════════════════════════════╗');
        console.log('║   Oh-My-ClaudeCode - Analytics Dashboard   ║');
        console.log('╚═══════════════════════════════════════╝');
        console.log('');
    }
}
// Default action when running 'omc' with no args - show everything
async function defaultAction() {
    await displayAnalyticsBanner();
    // Check if we need to backfill for agent data
    const shouldAutoBackfill = await checkIfBackfillNeeded();
    if (shouldAutoBackfill) {
        console.log(chalk.yellow('First run detected - backfilling agent data...'));
        await runQuickBackfill();
    }
    // Show aggregate session stats
    console.log(chalk.bold('📊 Aggregate Session Statistics'));
    console.log(chalk.gray('─'.repeat(50)));
    await statsCommand({ json: false });
    console.log('\n');
    // Show cost breakdown
    console.log(chalk.bold('💰 Cost Analysis (Monthly)'));
    console.log(chalk.gray('─'.repeat(50)));
    await costCommand('monthly', { json: false });
    console.log('\n');
    // Show top agents
    console.log(chalk.bold('🤖 Top Agents'));
    console.log(chalk.gray('─'.repeat(50)));
    await agentsCommand({ json: false, limit: 10 });
    console.log('\n');
    console.log(chalk.dim('Run with --help to see all available commands'));
    // Show tokscale hint if available
    const tuiAvailable = await isTokscaleCLIAvailable();
    if (tuiAvailable) {
        console.log('');
        console.log(chalk.dim('Tip: Run `omc tui` for an interactive token visualization dashboard'));
    }
}
program
    .name('omc')
    .description('Multi-agent orchestration system for Claude Agent SDK with analytics')
    .version(version)
    .action(defaultAction);
/**
 * Analytics Commands
 */
// Stats command
program
    .command('stats')
    .description('Show aggregate statistics (or specific session with --session)')
    .option('--json', 'Output as JSON')
    .option('--session <id>', 'Show stats for specific session (defaults to aggregate)')
    .addHelpText('after', `
Examples:
  $ omc stats                    Show aggregate statistics
  $ omc stats --session abc123   Show stats for a specific session
  $ omc stats --json             Output as JSON for scripting`)
    .action(async (options) => {
    await ensureBackfillDone();
    await statsCommand(options);
});
// Cost command
program
    .command('cost [period]')
    .description('Generate cost report (period: daily, weekly, monthly)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  $ omc cost                     Show monthly cost report
  $ omc cost daily               Show daily cost breakdown
  $ omc cost weekly --json       Export weekly costs as JSON`)
    .action(async (period = 'monthly', options) => {
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
        console.error(chalk.red(`Invalid period "${period}". Valid options: daily, weekly, monthly`));
        console.error(chalk.gray('Example: omc cost weekly'));
        process.exit(1);
    }
    await ensureBackfillDone();
    await costCommand(period, options);
});
// Sessions command
program
    .command('sessions')
    .description('View session history')
    .option('--json', 'Output as JSON')
    .option('-n, --limit <number>', 'Limit number of sessions', '10')
    .addHelpText('after', `
Examples:
  $ omc sessions                 Show last 10 sessions
  $ omc sessions --limit 50      Show last 50 sessions
  $ omc sessions --json          Export session history as JSON`)
    .action(async (options) => {
    await ensureBackfillDone();
    await sessionsCommand({ ...options, limit: parseInt(options.limit) });
});
// Agents command
program
    .command('agents')
    .description('Show agent usage breakdown')
    .option('--json', 'Output as JSON')
    .option('-n, --limit <number>', 'Limit number of agents', '10')
    .addHelpText('after', `
Examples:
  $ omc agents                   Show top 10 agents by usage
  $ omc agents --limit 20        Show top 20 agents
  $ omc agents --json            Export agent data as JSON`)
    .action(async (options) => {
    await ensureBackfillDone();
    await agentsCommand({ ...options, limit: parseInt(options.limit) });
});
// Export command
program
    .command('export <type> <format> <output>')
    .description('Export data (type: cost, sessions, patterns; format: json, csv)')
    .option('--period <period>', 'Period for cost report (daily, weekly, monthly)', 'monthly')
    .addHelpText('after', `
Examples:
  $ omc export cost json costs.json           Export monthly costs to JSON
  $ omc export sessions csv sessions.csv      Export sessions to CSV
  $ omc export cost csv data.csv --period weekly   Export weekly costs`)
    .action((type, format, output, options) => {
    if (!['cost', 'sessions', 'patterns'].includes(type)) {
        console.error(chalk.red(`Invalid type "${type}". Valid options: cost, sessions, patterns`));
        console.error(chalk.gray('Example: omc export cost json output.json'));
        process.exit(1);
    }
    if (!['json', 'csv'].includes(format)) {
        console.error(chalk.red(`Invalid format "${format}". Valid options: json, csv`));
        console.error(chalk.gray('Example: omc export sessions csv sessions.csv'));
        process.exit(1);
    }
    exportCommand(type, format, output, options);
});
// Cleanup command
program
    .command('cleanup')
    .description('Clean up old logs and orphaned background tasks')
    .option('-r, --retention <days>', 'Retention period in days', '30')
    .addHelpText('after', `
Examples:
  $ omc cleanup                  Clean up logs older than 30 days
  $ omc cleanup --retention 7    Clean up logs older than 7 days`)
    .action(options => {
    cleanupCommand({ ...options, retention: parseInt(options.retention) });
});
// Backfill command (deprecated - auto-backfill runs on every command)
program
    .command('backfill')
    .description('[DEPRECATED] Backfill now runs automatically. Use for manual re-sync only.')
    .option('--project <path>', 'Filter to specific project path')
    .option('--from <date>', 'Start date (ISO format: YYYY-MM-DD)')
    .option('--to <date>', 'End date (ISO format: YYYY-MM-DD)')
    .option('--dry-run', 'Preview without writing data')
    .option('--reset', 'Clear deduplication index and re-process all transcripts')
    .option('-v, --verbose', 'Show detailed progress')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  $ omc backfill --reset                       Force full re-sync
  $ omc backfill --project ~/myproject         Backfill specific project
  $ omc backfill --from 2024-01-01 --verbose   Backfill from date with progress`)
    .action(async (options) => {
    if (!options.reset && !options.project && !options.from && !options.to) {
        console.log(chalk.yellow('Note: Backfill now runs automatically with every omc command.'));
        console.log(chalk.gray('Use --reset to force full re-sync, or --project/--from/--to for filtered backfill.\n'));
    }
    await backfillCommand(options);
});
// TUI command
program
    .command('tui')
    .description('Launch tokscale interactive TUI for token visualization')
    .option('--models', 'Show models view')
    .option('--daily', 'Show daily/monthly view')
    .option('--no-claude', 'Show all providers (not just Claude)')
    .addHelpText('after', `
Examples:
  $ omc tui                      Launch interactive dashboard
  $ omc tui --light              Use light theme
  $ omc tui --daily              Start with daily view`)
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
        console.error(chalk.gray('Try running "omc tui" again, or check if tokscale is properly installed.'));
        process.exit(1);
    }
});
/**
 * Init command - Initialize configuration
 */
program
    .command('init')
    .description('Initialize Sisyphus configuration in the current directory')
    .option('-g, --global', 'Initialize global user configuration')
    .option('-f, --force', 'Overwrite existing configuration')
    .addHelpText('after', `
Examples:
  $ omc init                     Initialize in current directory
  $ omc init --global            Initialize global configuration
  $ omc init --force             Overwrite existing config`)
    .action(async (options) => {
    console.log(chalk.yellow('⚠️  DEPRECATED: The init command is deprecated.'));
    console.log(chalk.gray('Configuration is now managed automatically. Use /oh-my-claudecode:omc-setup instead.\n'));
    const paths = getConfigPaths();
    const targetPath = options.global ? paths.user : paths.project;
    const targetDir = dirname(targetPath);
    console.log(chalk.blue('Oh-My-ClaudeCode Configuration Setup\n'));
    // Check if config already exists
    if (existsSync(targetPath) && !options.force) {
        console.log(chalk.yellow(`Configuration already exists at ${targetPath}`));
        console.log(chalk.gray('Use --force to overwrite'));
        return;
    }
    // Create directory if needed
    if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
        console.log(chalk.green(`Created directory: ${targetDir}`));
    }
    // Generate config content
    const configContent = `// Oh-My-ClaudeCode Configuration
// See: https://github.com/Yeachan-Heo/oh-my-claudecode for documentation
{
  "$schema": "./sisyphus-schema.json",

  // Agent model configurations
  "agents": {
    "sisyphus": {
      // Main orchestrator - uses the most capable model
      "model": "claude-opus-4-6-20260205"
    },
    "architect": {
      // Architecture and debugging expert
      "model": "claude-opus-4-6-20260205",
      "enabled": true
    },
    "researcher": {
      // Documentation and codebase analysis
      "model": "claude-sonnet-4-5-20250514"
    },
    "explore": {
      // Fast pattern matching - uses fastest model
      "model": "claude-3-5-haiku-20241022"
    },
    "frontendEngineer": {
      "model": "claude-sonnet-4-5-20250514",
      "enabled": true
    },
    "documentWriter": {
      "model": "claude-3-5-haiku-20241022",
      "enabled": true
    },
    "multimodalLooker": {
      "model": "claude-sonnet-4-5-20250514",
      "enabled": true
    }
  },

  // Feature toggles
  "features": {
    "parallelExecution": true,
    "lspTools": true,
    "astTools": true,
    "continuationEnforcement": true,
    "autoContextInjection": true
  },

  // MCP server integrations
  "mcpServers": {
    "exa": {
      "enabled": true
      // Set EXA_API_KEY environment variable for API key
    },
    "context7": {
      "enabled": true
    }
  },

  // Permission settings
  "permissions": {
    "allowBash": true,
    "allowEdit": true,
    "allowWrite": true,
    "maxBackgroundTasks": 5
  },

  // Magic keyword triggers (customize if desired)
  "magicKeywords": {
    "ultrawork": ["ultrawork", "ulw", "uw"],
    "search": ["search", "find", "locate"],
    "analyze": ["analyze", "investigate", "examine"]
  }
}
`;
    writeFileSync(targetPath, configContent);
    console.log(chalk.green(`Created configuration: ${targetPath}`));
    // Also create the JSON schema for editor support
    const schemaPath = join(targetDir, 'sisyphus-schema.json');
    writeFileSync(schemaPath, JSON.stringify(generateConfigSchema(), null, 2));
    console.log(chalk.green(`Created JSON schema: ${schemaPath}`));
    console.log(chalk.blue('\nSetup complete!'));
    console.log(chalk.gray('Edit the configuration file to customize your setup.'));
    // Create AGENTS.md template if it doesn't exist
    const agentsMdPath = join(process.cwd(), 'AGENTS.md');
    if (!existsSync(agentsMdPath) && !options.global) {
        const agentsMdContent = `# Project Agents Configuration

This file provides context and instructions to AI agents working on this project.

## Project Overview

<!-- Describe your project here -->

## Architecture

<!-- Describe the architecture and key components -->

## Conventions

<!-- List coding conventions, naming patterns, etc. -->

## Important Files

<!-- List key files agents should know about -->

## Common Tasks

<!-- Describe common development tasks and how to perform them -->
`;
        writeFileSync(agentsMdPath, agentsMdContent);
        console.log(chalk.green(`Created AGENTS.md template`));
    }
});
/**
 * Config command - Show or validate configuration
 */
program
    .command('config')
    .description('Show current configuration')
    .option('-v, --validate', 'Validate configuration')
    .option('-p, --paths', 'Show configuration file paths')
    .addHelpText('after', `
Examples:
  $ omc config                   Show current configuration
  $ omc config --validate        Validate configuration files
  $ omc config --paths           Show config file locations`)
    .action(async (options) => {
    if (options.paths) {
        const paths = getConfigPaths();
        console.log(chalk.blue('Configuration file paths:'));
        console.log(`  User:    ${paths.user}`);
        console.log(`  Project: ${paths.project}`);
        console.log(chalk.blue('\nFile status:'));
        console.log(`  User:    ${existsSync(paths.user) ? chalk.green('exists') : chalk.gray('not found')}`);
        console.log(`  Project: ${existsSync(paths.project) ? chalk.green('exists') : chalk.gray('not found')}`);
        return;
    }
    const config = loadConfig();
    if (options.validate) {
        console.log(chalk.blue('Validating configuration...\n'));
        // Check for required fields
        const warnings = [];
        const errors = [];
        if (!process.env.ANTHROPIC_API_KEY) {
            warnings.push('ANTHROPIC_API_KEY environment variable not set');
        }
        if (config.mcpServers?.exa?.enabled && !process.env.EXA_API_KEY && !config.mcpServers.exa.apiKey) {
            warnings.push('Exa is enabled but EXA_API_KEY is not set');
        }
        if (errors.length > 0) {
            console.log(chalk.red('Errors:'));
            errors.forEach(e => console.log(chalk.red(`  - ${e}`)));
        }
        if (warnings.length > 0) {
            console.log(chalk.yellow('Warnings:'));
            warnings.forEach(w => console.log(chalk.yellow(`  - ${w}`)));
        }
        if (errors.length === 0 && warnings.length === 0) {
            console.log(chalk.green('Configuration is valid!'));
        }
        return;
    }
    console.log(chalk.blue('Current configuration:\n'));
    console.log(JSON.stringify(config, null, 2));
});
/**
 * Config stop-callback subcommand - Configure stop hook callbacks
 */
const configStopCallback = program
    .command('config-stop-callback <type>')
    .description('Configure stop hook callbacks (file/telegram/discord)')
    .option('--enable', 'Enable callback')
    .option('--disable', 'Disable callback')
    .option('--path <path>', 'File path (supports {session_id}, {date}, {time})')
    .option('--format <format>', 'File format: markdown | json')
    .option('--token <token>', 'Telegram bot token')
    .option('--chat <id>', 'Telegram chat ID')
    .option('--webhook <url>', 'Discord webhook URL')
    .option('--show', 'Show current configuration')
    .addHelpText('after', `
Types:
  file       File system callback (saves session summary to disk)
  telegram   Telegram bot notification
  discord    Discord webhook notification

Examples:
  $ omc config-stop-callback file --enable --path ~/.claude/logs/{date}.md
  $ omc config-stop-callback telegram --enable --token <token> --chat <id>
  $ omc config-stop-callback discord --enable --webhook <url>
  $ omc config-stop-callback file --disable
  $ omc config-stop-callback file --show`)
    .action(async (type, options) => {
    const validTypes = ['file', 'telegram', 'discord'];
    if (!validTypes.includes(type)) {
        console.error(chalk.red(`Invalid callback type: ${type}`));
        console.error(chalk.gray(`Valid types: ${validTypes.join(', ')}`));
        process.exit(1);
    }
    const config = getSisyphusConfig();
    config.stopHookCallbacks = config.stopHookCallbacks || {};
    // Show current config
    if (options.show) {
        const current = config.stopHookCallbacks[type];
        if (current) {
            console.log(chalk.blue(`Current ${type} callback configuration:`));
            console.log(JSON.stringify(current, null, 2));
        }
        else {
            console.log(chalk.yellow(`No ${type} callback configured.`));
        }
        return;
    }
    // Determine enabled state
    let enabled;
    if (options.enable) {
        enabled = true;
    }
    else if (options.disable) {
        enabled = false;
    }
    // Update config based on type
    switch (type) {
        case 'file': {
            const current = config.stopHookCallbacks.file;
            config.stopHookCallbacks.file = {
                enabled: enabled ?? current?.enabled ?? false,
                path: options.path ?? current?.path ?? '~/.claude/session-logs/{session_id}.md',
                format: options.format ?? current?.format ?? 'markdown',
            };
            break;
        }
        case 'telegram': {
            const current = config.stopHookCallbacks.telegram;
            if (enabled === true && (!options.token && !current?.botToken)) {
                console.error(chalk.red('Telegram requires --token <bot_token>'));
                process.exit(1);
            }
            if (enabled === true && (!options.chat && !current?.chatId)) {
                console.error(chalk.red('Telegram requires --chat <chat_id>'));
                process.exit(1);
            }
            config.stopHookCallbacks.telegram = {
                enabled: enabled ?? current?.enabled ?? false,
                botToken: options.token ?? current?.botToken,
                chatId: options.chat ?? current?.chatId,
            };
            break;
        }
        case 'discord': {
            const current = config.stopHookCallbacks.discord;
            if (enabled === true && (!options.webhook && !current?.webhookUrl)) {
                console.error(chalk.red('Discord requires --webhook <webhook_url>'));
                process.exit(1);
            }
            config.stopHookCallbacks.discord = {
                enabled: enabled ?? current?.enabled ?? false,
                webhookUrl: options.webhook ?? current?.webhookUrl,
            };
            break;
        }
    }
    // Write config
    try {
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        console.log(chalk.green(`\u2713 Stop callback '${type}' configured`));
        console.log(JSON.stringify(config.stopHookCallbacks[type], null, 2));
    }
    catch (error) {
        console.error(chalk.red('Failed to write configuration:'), error);
        process.exit(1);
    }
});
/**
 * Info command - Show system information
 */
program
    .command('info')
    .description('Show system and agent information')
    .addHelpText('after', `
Examples:
  $ omc info                     Show agents, features, and MCP servers`)
    .action(async () => {
    const session = createSisyphusSession();
    console.log(chalk.blue.bold('\nOh-My-ClaudeCode System Information\n'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(chalk.blue('\nAvailable Agents:'));
    const agents = session.queryOptions.options.agents;
    for (const [name, agent] of Object.entries(agents)) {
        console.log(`  ${chalk.green(name)}`);
        console.log(`    ${chalk.gray(agent.description.split('\n')[0])}`);
    }
    console.log(chalk.blue('\nEnabled Features:'));
    const features = session.config.features;
    if (features) {
        console.log(`  Parallel Execution:      ${features.parallelExecution ? chalk.green('enabled') : chalk.gray('disabled')}`);
        console.log(`  LSP Tools:               ${features.lspTools ? chalk.green('enabled') : chalk.gray('disabled')}`);
        console.log(`  AST Tools:               ${features.astTools ? chalk.green('enabled') : chalk.gray('disabled')}`);
        console.log(`  Continuation Enforcement:${features.continuationEnforcement ? chalk.green('enabled') : chalk.gray('disabled')}`);
        console.log(`  Auto Context Injection:  ${features.autoContextInjection ? chalk.green('enabled') : chalk.gray('disabled')}`);
    }
    console.log(chalk.blue('\nMCP Servers:'));
    const mcpServers = session.queryOptions.options.mcpServers;
    for (const name of Object.keys(mcpServers)) {
        console.log(`  ${chalk.green(name)}`);
    }
    console.log(chalk.blue('\nMagic Keywords:'));
    console.log(`  Ultrawork: ${chalk.cyan(session.config.magicKeywords?.ultrawork?.join(', ') ?? 'ultrawork, ulw, uw')}`);
    console.log(`  Search:    ${chalk.cyan(session.config.magicKeywords?.search?.join(', ') ?? 'search, find, locate')}`);
    console.log(`  Analyze:   ${chalk.cyan(session.config.magicKeywords?.analyze?.join(', ') ?? 'analyze, investigate, examine')}`);
    console.log(chalk.gray('\n━'.repeat(50)));
    console.log(chalk.gray(`Version: ${version}`));
});
/**
 * Test command - Test prompt enhancement
 */
program
    .command('test-prompt <prompt>')
    .description('Test how a prompt would be enhanced')
    .addHelpText('after', `
Examples:
  $ omc test-prompt "ultrawork fix bugs"    See how magic keywords are detected
  $ omc test-prompt "analyze this code"     Test prompt enhancement`)
    .action(async (prompt) => {
    const session = createSisyphusSession();
    console.log(chalk.blue('Original prompt:'));
    console.log(chalk.gray(prompt));
    const keywords = session.detectKeywords(prompt);
    if (keywords.length > 0) {
        console.log(chalk.blue('\nDetected magic keywords:'));
        console.log(chalk.yellow(keywords.join(', ')));
    }
    console.log(chalk.blue('\nEnhanced prompt:'));
    console.log(chalk.green(session.processPrompt(prompt)));
});
/**
 * Update command - Check for and install updates
 */
program
    .command('update')
    .description('Check for and install updates')
    .option('-c, --check', 'Only check for updates, do not install')
    .option('-f, --force', 'Force reinstall even if up to date')
    .option('-q, --quiet', 'Suppress output except for errors')
    .option('--standalone', 'Force npm update even in plugin context')
    .addHelpText('after', `
Examples:
  $ omc update                   Check and install updates
  $ omc update --check           Only check, don't install
  $ omc update --force           Force reinstall
  $ omc update --standalone      Force npm update in plugin context`)
    .action(async (options) => {
    if (!options.quiet) {
        console.log(chalk.blue('Oh-My-ClaudeCode Update\n'));
    }
    try {
        // Show current version
        const installed = getInstalledVersion();
        if (!options.quiet) {
            console.log(chalk.gray(`Current version: ${installed?.version ?? 'unknown'}`));
            console.log(chalk.gray(`Install method: ${installed?.installMethod ?? 'unknown'}`));
            console.log('');
        }
        // Check for updates
        if (!options.quiet) {
            console.log('Checking for updates...');
        }
        const checkResult = await checkForUpdates();
        if (!checkResult.updateAvailable && !options.force) {
            if (!options.quiet) {
                console.log(chalk.green(`\n✓ You are running the latest version (${checkResult.currentVersion})`));
            }
            return;
        }
        if (!options.quiet) {
            console.log(formatUpdateNotification(checkResult));
        }
        // If check-only mode, stop here
        if (options.check) {
            if (checkResult.updateAvailable) {
                console.log(chalk.yellow('\nRun without --check to install the update.'));
            }
            return;
        }
        // Perform the update
        if (!options.quiet) {
            console.log(chalk.blue('\nStarting update...\n'));
        }
        const result = await performUpdate({ verbose: !options.quiet, standalone: options.standalone });
        if (result.success) {
            if (!options.quiet) {
                console.log(chalk.green(`\n✓ ${result.message}`));
                console.log(chalk.gray('\nPlease restart your Claude Code session to use the new version.'));
            }
        }
        else {
            console.error(chalk.red(`\n✗ ${result.message}`));
            if (result.errors) {
                result.errors.forEach(err => console.error(chalk.red(`  - ${err}`)));
            }
            process.exit(1);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Update failed: ${message}`));
        console.error(chalk.gray('Try again with "omc update --force", or reinstall with "omc install --force".'));
        process.exit(1);
    }
});
/**
 * Version command - Show version information
 */
program
    .command('version')
    .description('Show detailed version information')
    .addHelpText('after', `
Examples:
  $ omc version                  Show version, install method, and commit hash`)
    .action(async () => {
    const installed = getInstalledVersion();
    console.log(chalk.blue.bold('\nOh-My-ClaudeCode Version Information\n'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(`\n  Package version:   ${chalk.green(version)}`);
    if (installed) {
        console.log(`  Installed version: ${chalk.green(installed.version)}`);
        console.log(`  Install method:    ${chalk.cyan(installed.installMethod)}`);
        console.log(`  Installed at:      ${chalk.gray(installed.installedAt)}`);
        if (installed.lastCheckAt) {
            console.log(`  Last update check: ${chalk.gray(installed.lastCheckAt)}`);
        }
        if (installed.commitHash) {
            console.log(`  Commit hash:       ${chalk.gray(installed.commitHash)}`);
        }
    }
    else {
        console.log(chalk.yellow('  No installation metadata found'));
        console.log(chalk.gray('  (Run the install script to create version metadata)'));
    }
    console.log(chalk.gray('\n━'.repeat(50)));
    console.log(chalk.gray('\nTo check for updates, run: oh-my-claudecode update --check'));
});
/**
 * Install command - Install agents and commands to ~/.claude/
 */
program
    .command('install')
    .description('Install Sisyphus agents and commands to Claude Code config (~/.claude/)')
    .option('-f, --force', 'Overwrite existing files')
    .option('-q, --quiet', 'Suppress output except for errors')
    .option('--skip-claude-check', 'Skip checking if Claude Code is installed')
    .addHelpText('after', `
Examples:
  $ omc install                  Install to ~/.claude/
  $ omc install --force          Reinstall, overwriting existing files
  $ omc install --quiet          Silent install for scripts`)
    .action(async (options) => {
    if (!options.quiet) {
        console.log(chalk.blue('╔═══════════════════════════════════════════════════════════╗'));
        console.log(chalk.blue('║         Oh-My-ClaudeCode Installer                        ║'));
        console.log(chalk.blue('║   Multi-Agent Orchestration for Claude Code               ║'));
        console.log(chalk.blue('╚═══════════════════════════════════════════════════════════╝'));
        console.log('');
    }
    // Check if already installed
    if (isInstalled() && !options.force) {
        const info = getInstallInfo();
        if (!options.quiet) {
            console.log(chalk.yellow('Sisyphus is already installed.'));
            if (info) {
                console.log(chalk.gray(`  Version: ${info.version}`));
                console.log(chalk.gray(`  Installed: ${info.installedAt}`));
            }
            console.log(chalk.gray('\nUse --force to reinstall.'));
        }
        return;
    }
    // Run installation
    const result = installSisyphus({
        force: options.force,
        verbose: !options.quiet,
        skipClaudeCheck: options.skipClaudeCheck
    });
    if (result.success) {
        if (!options.quiet) {
            console.log('');
            console.log(chalk.green('╔═══════════════════════════════════════════════════════════╗'));
            console.log(chalk.green('║         Installation Complete!                            ║'));
            console.log(chalk.green('╚═══════════════════════════════════════════════════════════╝'));
            console.log('');
            console.log(chalk.gray(`Installed to: ~/.claude/`));
            console.log('');
            console.log(chalk.yellow('Usage:'));
            console.log('  claude                        # Start Claude Code normally');
            console.log('');
            console.log(chalk.yellow('Slash Commands:'));
            console.log('  /sisyphus <task>              # Activate Sisyphus orchestration mode');
            console.log('  /sisyphus-default             # Configure for current project');
            console.log('  /sisyphus-default-global      # Configure globally');
            console.log('  /ultrawork <task>             # Maximum performance mode');
            console.log('  /deepsearch <query>           # Thorough codebase search');
            console.log('  /analyze <target>             # Deep analysis mode');
            console.log('  /plan <description>           # Start planning with Planner');
            console.log('  /review [plan-path]           # Review plan with Critic');
            console.log('');
            console.log(chalk.yellow('Available Agents (via Task tool):'));
            console.log(chalk.gray('  Base Agents:'));
            console.log('    architect              - Architecture & debugging (Opus)');
            console.log('    researcher           - Documentation & research (Sonnet)');
            console.log('    explore             - Fast pattern matching (Haiku)');
            console.log('    designer            - UI/UX specialist (Sonnet)');
            console.log('    writer              - Technical writing (Haiku)');
            console.log('    vision              - Visual analysis (Sonnet)');
            console.log('    critic               - Plan review (Opus)');
            console.log('    analyst               - Pre-planning analysis (Opus)');
            console.log('    orchestrator-sisyphus - Todo coordination (Opus)');
            console.log('    executor            - Focused execution (Sonnet)');
            console.log('    planner          - Strategic planning (Opus)');
            console.log('    qa-tester           - Interactive CLI testing (Sonnet)');
            console.log(chalk.gray('  Tiered Variants (for smart routing):'));
            console.log('    architect-medium       - Simpler analysis (Sonnet)');
            console.log('    architect-low          - Quick questions (Haiku)');
            console.log('    executor-high       - Complex tasks (Opus)');
            console.log('    executor-low        - Trivial tasks (Haiku)');
            console.log('    designer-high       - Design systems (Opus)');
            console.log('    designer-low        - Simple styling (Haiku)');
            console.log('');
            console.log(chalk.yellow('After Updates:'));
            console.log('  Run \'/sisyphus-default\' (project) or \'/sisyphus-default-global\' (global)');
            console.log('  to download the latest CLAUDE.md configuration.');
            console.log('  This ensures you get the newest features and agent behaviors.');
            console.log('');
            console.log(chalk.blue('Quick Start:'));
            console.log('  1. Run \'claude\' to start Claude Code');
            console.log('  2. Type \'/sisyphus-default\' for project or \'/sisyphus-default-global\' for global');
            console.log('  3. Or use \'/sisyphus <task>\' for one-time activation');
        }
    }
    else {
        console.error(chalk.red(`Installation failed: ${result.message}`));
        if (result.errors.length > 0) {
            result.errors.forEach(err => console.error(chalk.red(`  - ${err}`)));
        }
        console.error(chalk.gray('\nTry "omc install --force" to overwrite existing files.'));
        console.error(chalk.gray('For more diagnostics, run "omc doctor conflicts".'));
        process.exit(1);
    }
});
/**
 * Wait command - Rate limit wait and auto-resume
 *
 * Zero learning curve design:
 * - `omc wait` alone shows status and suggests next action
 * - `omc wait --start` starts the daemon (shortcut)
 * - `omc wait --stop` stops the daemon (shortcut)
 * - Subcommands available for power users
 */
const waitCmd = program
    .command('wait')
    .description('Rate limit wait and auto-resume (just run "omc wait" to get started)')
    .option('--json', 'Output as JSON')
    .option('--start', 'Start the auto-resume daemon')
    .option('--stop', 'Stop the auto-resume daemon')
    .addHelpText('after', `
Examples:
  $ omc wait                     Show status and suggestions
  $ omc wait --start             Start auto-resume daemon
  $ omc wait --stop              Stop auto-resume daemon
  $ omc wait status              Show detailed rate limit status
  $ omc wait detect              Scan for blocked tmux sessions`)
    .action(async (options) => {
    await waitCommand(options);
});
waitCmd
    .command('status')
    .description('Show detailed rate limit and daemon status')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
    await waitStatusCommand(options);
});
waitCmd
    .command('daemon <action>')
    .description('Start or stop the auto-resume daemon')
    .option('-v, --verbose', 'Enable verbose logging')
    .option('-f, --foreground', 'Run in foreground (blocking)')
    .option('-i, --interval <seconds>', 'Poll interval in seconds', '60')
    .addHelpText('after', `
Examples:
  $ omc wait daemon start            Start background daemon
  $ omc wait daemon stop             Stop the daemon
  $ omc wait daemon start -f         Run in foreground`)
    .action(async (action, options) => {
    if (action !== 'start' && action !== 'stop') {
        console.error(chalk.red(`Invalid action "${action}". Valid options: start, stop`));
        console.error(chalk.gray('Example: omc wait daemon start'));
        process.exit(1);
    }
    await waitDaemonCommand(action, {
        verbose: options.verbose,
        foreground: options.foreground,
        interval: parseInt(options.interval),
    });
});
waitCmd
    .command('detect')
    .description('Scan for blocked Claude Code sessions in tmux')
    .option('--json', 'Output as JSON')
    .option('-l, --lines <number>', 'Number of pane lines to analyze', '15')
    .action(async (options) => {
    await waitDetectCommand({
        json: options.json,
        lines: parseInt(options.lines),
    });
});
/**
 * Teleport command - Quick worktree creation
 *
 * Usage:
 * - `omc teleport #123` - Create worktree for issue/PR #123
 * - `omc teleport my-feature` - Create worktree for feature branch
 * - `omc teleport list` - List existing worktrees
 * - `omc teleport remove <path>` - Remove a worktree
 */
const teleportCmd = program
    .command('teleport [ref]')
    .description('Create git worktree for isolated development (e.g., omc teleport #123)')
    .option('--worktree', 'Create worktree (default behavior, flag kept for compatibility)')
    .option('-p, --path <path>', 'Custom worktree path (default: ~/Workspace/omc-worktrees/)')
    .option('-b, --base <branch>', 'Base branch to create from (default: main)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  $ omc teleport #42             Create worktree for issue/PR #42
  $ omc teleport add-auth        Create worktree for a feature branch
  $ omc teleport list            List existing worktrees
  $ omc teleport remove ./path   Remove a worktree`)
    .action(async (ref, options) => {
    if (!ref) {
        // No ref provided, show help
        console.log(chalk.blue('Teleport - Quick worktree creation\n'));
        console.log('Usage:');
        console.log('  omc teleport <ref>           Create worktree for issue/PR/feature');
        console.log('  omc teleport list            List existing worktrees');
        console.log('  omc teleport remove <path>   Remove a worktree');
        console.log('');
        console.log('Reference formats:');
        console.log('  #123                         Issue/PR in current repo');
        console.log('  owner/repo#123               Issue/PR in specific repo');
        console.log('  my-feature                   Feature branch name');
        console.log('  https://github.com/...       GitHub URL');
        console.log('');
        console.log('Examples:');
        console.log('  omc teleport #42             Create worktree for issue #42');
        console.log('  omc teleport add-auth        Create worktree for feature "add-auth"');
        console.log('');
        return;
    }
    await teleportCommand(ref, {
        worktree: true, // Always create worktree
        worktreePath: options.path,
        base: options.base,
        json: options.json,
    });
});
teleportCmd
    .command('list')
    .description('List existing worktrees in ~/Workspace/omc-worktrees/')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
    await teleportListCommand(options);
});
teleportCmd
    .command('remove <path>')
    .alias('rm')
    .description('Remove a worktree')
    .option('-f, --force', 'Force removal even with uncommitted changes')
    .option('--json', 'Output as JSON')
    .action(async (path, options) => {
    await teleportRemoveCommand(path, options);
});
/**
 * Doctor command - Diagnostic tools
 */
const doctorCmd = program
    .command('doctor')
    .description('Diagnostic tools for troubleshooting OMC installation')
    .addHelpText('after', `
Examples:
  $ omc doctor conflicts         Check for plugin conflicts`);
doctorCmd
    .command('conflicts')
    .description('Check for plugin coexistence issues and configuration conflicts')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  $ omc doctor conflicts         Check for configuration issues
  $ omc doctor conflicts --json  Output results as JSON`)
    .action(async (options) => {
    const exitCode = await doctorConflictsCommand(options);
    process.exit(exitCode);
});
/**
 * Postinstall command - Silent install for npm postinstall hook
 */
program
    .command('postinstall', { hidden: true })
    .description('Run post-install setup (called automatically by npm)')
    .action(async () => {
    // Silent install - only show errors
    const result = installSisyphus({
        force: false,
        verbose: false,
        skipClaudeCheck: true
    });
    if (result.success) {
        console.log(chalk.green('✓ Oh-My-ClaudeCode installed successfully!'));
        console.log(chalk.gray('  Run "oh-my-claudecode info" to see available agents.'));
        console.log(chalk.yellow('  Run "/sisyphus-default" (project) or "/sisyphus-default-global" (global) in Claude Code.'));
    }
    else {
        // Don't fail the npm install, just warn
        console.warn(chalk.yellow('⚠ Could not complete Sisyphus setup:'), result.message);
        console.warn(chalk.gray('  Run "oh-my-claudecode install" manually to complete setup.'));
    }
});
// Parse arguments
program.parse();
//# sourceMappingURL=index.js.map
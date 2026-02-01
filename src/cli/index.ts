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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import * as fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
  loadConfig,
  getConfigPaths,
  generateConfigSchema
} from '../config/loader.js';
import { createSisyphusSession } from '../index.js';
import {
  checkForUpdates,
  performUpdate,
  formatUpdateNotification,
  getInstalledVersion
} from '../features/auto-update.js';
import {
  install as installSisyphus,
  isInstalled,
  getInstallInfo
} from '../installer/index.js';
import { statsCommand } from './commands/stats.js';
import { costCommand } from './commands/cost.js';
import { sessionsCommand } from './commands/sessions.js';
import { agentsCommand } from './commands/agents.js';
import { exportCommand } from './commands/export.js';
import { cleanupCommand } from './commands/cleanup.js';
import { backfillCommand } from './commands/backfill.js';
import {
  launchTokscaleTUI,
  isTokscaleCLIAvailable,
  getInstallInstructions
} from './utils/tokscale-launcher.js';
import {
  waitCommand,
  waitStatusCommand,
  waitDaemonCommand,
  waitDetectCommand
} from './commands/wait.js';
import { doctorConflictsCommand } from './commands/doctor-conflicts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try to load package.json for version
let version = '1.0.0';
try {
  const pkgPath = join(__dirname, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  version = pkg.version;
} catch {
  // Use default version
}

const program = new Command();

// Helper functions for auto-backfill
async function checkIfBackfillNeeded(): Promise<boolean> {
  const tokenLogPath = join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
  try {
    await fs.access(tokenLogPath);
    const stats = await fs.stat(tokenLogPath);
    // Backfill if file is older than 1 hour or very small
    const ageMs = Date.now() - stats.mtimeMs;
    return stats.size < 100 || ageMs > 3600000;
  } catch {
    return true; // File doesn't exist
  }
}

async function runQuickBackfill(silent: boolean = false): Promise<void> {
  const { BackfillEngine } = await import('../analytics/backfill-engine.js');
  const engine = new BackfillEngine();
  const result = await engine.run({ verbose: false });
  if (result.entriesAdded > 0 && !silent) {
    console.log(chalk.green(`Backfilled ${result.entriesAdded} entries in ${result.timeElapsed}ms`));
  }
}

// Auto-backfill before analytics commands
async function ensureBackfillDone(): Promise<void> {
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
  } catch (error) {
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
  .action(async (options) => {
    await ensureBackfillDone();
    await statsCommand(options);
  });

// Cost command
program
  .command('cost [period]')
  .description('Generate cost report (period: daily, weekly, monthly)')
  .option('--json', 'Output as JSON')
  .action(async (period = 'monthly', options) => {
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      console.error('Invalid period. Use: daily, weekly, or monthly');
      process.exit(1);
    }
    await ensureBackfillDone();
    await costCommand(period as 'daily' | 'weekly' | 'monthly', options);
  });

// Sessions command
program
  .command('sessions')
  .description('View session history')
  .option('--json', 'Output as JSON')
  .option('--limit <number>', 'Limit number of sessions', '10')
  .action(async (options) => {
    await ensureBackfillDone();
    await sessionsCommand({ ...options, limit: parseInt(options.limit) });
  });

// Agents command
program
  .command('agents')
  .description('Show agent usage breakdown')
  .option('--json', 'Output as JSON')
  .option('--limit <number>', 'Limit number of agents', '10')
  .action(async (options) => {
    await ensureBackfillDone();
    await agentsCommand({ ...options, limit: parseInt(options.limit) });
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

// Backfill command (deprecated - auto-backfill runs on every command)
program
  .command('backfill')
  .description('[DEPRECATED] Backfill now runs automatically. Use for manual re-sync only.')
  .option('--project <path>', 'Filter to specific project path')
  .option('--from <date>', 'Start date (ISO format: YYYY-MM-DD)')
  .option('--to <date>', 'End date (ISO format: YYYY-MM-DD)')
  .option('--dry-run', 'Preview without writing data')
  .option('--reset', 'Clear deduplication index and re-process all transcripts')
  .option('--verbose', 'Show detailed progress')
  .option('--json', 'Output as JSON')
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
  .option('--light', 'Use light theme')
  .option('--models', 'Show models view')
  .option('--daily', 'Show daily view')
  .option('--stats', 'Show stats view')
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
               : options.stats ? 'stats'
               : 'overview';

    try {
      await launchTokscaleTUI({
        light: options.light,
        view,
        claude: options.claude
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Failed to launch TUI: ${message}`));
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
// See: https://github.com/your-repo/oh-my-claudecode for documentation
{
  "$schema": "./sisyphus-schema.json",

  // Agent model configurations
  "agents": {
    "sisyphus": {
      // Main orchestrator - uses the most capable model
      "model": "claude-opus-4-5-20251101"
    },
    "architect": {
      // Architecture and debugging expert
      "model": "claude-opus-4-5-20251101",
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
      const warnings: string[] = [];
      const errors: string[] = [];

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
 * Info command - Show system information
 */
program
  .command('info')
  .description('Show system and agent information')
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
  .action(async (prompt: string) => {
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

      const result = await performUpdate({ verbose: !options.quiet });

      if (result.success) {
        if (!options.quiet) {
          console.log(chalk.green(`\n✓ ${result.message}`));
          console.log(chalk.gray('\nPlease restart your Claude Code session to use the new version.'));
        }
      } else {
        console.error(chalk.red(`\n✗ ${result.message}`));
        if (result.errors) {
          result.errors.forEach(err => console.error(chalk.red(`  - ${err}`)));
        }
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Update failed: ${message}`));
      process.exit(1);
    }
  });

/**
 * Version command - Show version information
 */
program
  .command('version')
  .description('Show detailed version information')
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
    } else {
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
        console.log('    researcher-low       - Quick lookups (Haiku)');
        console.log('    explore-medium      - Thorough search (Sonnet)');
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
    } else {
      console.error(chalk.red(`Installation failed: ${result.message}`));
      if (result.errors.length > 0) {
        result.errors.forEach(err => console.error(chalk.red(`  - ${err}`)));
      }
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
  .action(async (action: string, options) => {
    if (action !== 'start' && action !== 'stop') {
      console.error('Invalid action. Use: start or stop');
      process.exit(1);
    }
    await waitDaemonCommand(action as 'start' | 'stop', {
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
 * Doctor command - Diagnostic tools
 */
const doctorCmd = program
  .command('doctor')
  .description('Diagnostic tools for troubleshooting OMC installation');

doctorCmd
  .command('conflicts')
  .description('Check for plugin coexistence issues and configuration conflicts')
  .option('--json', 'Output as JSON')
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
    } else {
      // Don't fail the npm install, just warn
      console.warn(chalk.yellow('⚠ Could not complete Sisyphus setup:'), result.message);
      console.warn(chalk.gray('  Run "oh-my-claudecode install" manually to complete setup.'));
    }
  });

// Parse arguments
program.parse();

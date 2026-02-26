#!/usr/bin/env node

/**
 * Oh-My-ClaudeCode CLI
 *
 * Command-line interface for the OMC multi-agent system.
 *
 * Commands:
 * - run: Start an interactive session
 * - init: Initialize configuration in current directory
 * - config: Show or edit configuration
 * - setup: Sync all OMC components (hooks, agents, skills)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadConfig,
  getConfigPaths,
  generateConfigSchema
} from '../config/loader.js';
import {
  getDefaultModelHigh,
  getDefaultModelMedium,
  getDefaultModelLow,
} from '../config/models.js';
import { createOmcSession } from '../index.js';
import {
  checkForUpdates,
  performUpdate,
  formatUpdateNotification,
  getInstalledVersion,
  getOMCConfig,
  reconcileUpdateRuntime,
  CONFIG_FILE,
  type OMCConfig,
} from '../features/auto-update.js';
import {
  install as installOmc,
  isInstalled,
  getInstallInfo
} from '../installer/index.js';
import {
  waitCommand,
  waitStatusCommand,
  waitDaemonCommand,
  waitDetectCommand
} from './commands/wait.js';
import { doctorConflictsCommand } from './commands/doctor-conflicts.js';
import {
  teleportCommand,
  teleportListCommand,
  teleportRemoveCommand
} from './commands/teleport.js';

import { getRuntimePackageVersion } from '../lib/version.js';
import { launchCommand } from './launch.js';
import { interopCommand } from './interop.js';
import { warnIfWin32 } from './win32-warning.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const version = getRuntimePackageVersion();

const program = new Command();

// Win32 platform warning - OMC requires tmux which is not available on native Windows
warnIfWin32();

// Default action when running 'omc' with no subcommand
// Forwards all args to launchCommand so 'omc --notify false --madmax' etc. work directly
async function defaultAction() {
  // Pass all CLI args through to launch (strip node + script path)
  const args = process.argv.slice(2);
  await launchCommand(args);
}

program
  .name('omc')
  .description('Multi-agent orchestration system for Claude Agent SDK')
  .version(version)
  .allowUnknownOption()
  .action(defaultAction);

/**
 * Launch command - Native tmux shell launch for Claude Code
 */
program
  .command('launch [args...]')
  .description('Launch Claude Code with native tmux shell integration')
  .allowUnknownOption()
  .addHelpText('after', `
Examples:
  $ omc                                Launch Claude Code
  $ omc --madmax                       Launch with permissions bypass
  $ omc --yolo                         Launch with permissions bypass (alias)
  $ omc --notify false                 Launch without CCNotifier events
  $ omc launch                         Explicit launch subcommand (same as bare omc)
  $ omc launch --madmax                Explicit launch with flags

Options:
  --notify <bool>   Enable/disable CCNotifier events. false sets OMC_NOTIFY=0
                    and suppresses all stop/session-start/session-idle notifications.
                    Default: true

Environment:
  OMC_NOTIFY=0              Suppress all notifications (set by --notify false)
`)
  .action(async (args: string[]) => {
    await launchCommand(args);
  });

/**
 * Interop command - Split-pane tmux session with OMC and OMX
 */
program
  .command('interop')
  .description('Launch split-pane tmux session with Claude Code (OMC) and Codex (OMX)')
  .addHelpText('after', `
Requirements:
  - Must be running inside a tmux session
  - Claude CLI must be installed
  - Codex CLI recommended (graceful fallback if missing)`)
  .action(() => {
    interopCommand();
  });

/**
 * Init command - Initialize configuration
 */
program
  .command('init')
  .description('Initialize OMC configuration in the current directory')
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

    // Resolve current default model IDs (respects OMC_MODEL_* env vars)
    const modelHigh = getDefaultModelHigh();
    const modelMedium = getDefaultModelMedium();
    const modelLow = getDefaultModelLow();

    // Generate config content
    const configContent = `// Oh-My-ClaudeCode Configuration
// See: https://github.com/Yeachan-Heo/oh-my-claudecode for documentation
//
// Model IDs can be overridden via environment variables:
//   OMC_MODEL_HIGH   (opus-class)
//   OMC_MODEL_MEDIUM (sonnet-class)
//   OMC_MODEL_LOW    (haiku-class)
{
  "$schema": "./omc-schema.json",

  // Agent model configurations
  "agents": {
    "omc": {
      // Main orchestrator - uses the most capable model
      "model": "${modelHigh}"
    },
    "architect": {
      // Architecture and debugging expert
      "model": "${modelHigh}",
      "enabled": true
    },
    "researcher": {
      // Documentation and codebase analysis
      "model": "${modelMedium}"
    },
    "explore": {
      // Fast pattern matching - uses fastest model
      "model": "${modelLow}"
    },
    "frontendEngineer": {
      "model": "${modelMedium}",
      "enabled": true
    },
    "documentWriter": {
      "model": "${modelLow}",
      "enabled": true
    },
    "multimodalLooker": {
      "model": "${modelMedium}",
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
    const schemaPath = join(targetDir, 'omc-schema.json');
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
  $ omc config --paths           Show config file locations

  }`)
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
 * Config stop-callback subcommand - Configure stop hook callbacks
 */
const _configStopCallback = program
  .command('config-stop-callback <type>')
  .description('Configure stop hook callbacks (file/telegram/discord/slack)')
  .option('--enable', 'Enable callback')
  .option('--disable', 'Disable callback')
  .option('--path <path>', 'File path (supports {session_id}, {date}, {time})')
  .option('--format <format>', 'File format: markdown | json')
  .option('--token <token>', 'Bot token (telegram or discord-bot)')
  .option('--chat <id>', 'Telegram chat ID')
  .option('--webhook <url>', 'Discord webhook URL')
  .option('--channel-id <id>', 'Discord bot channel ID (used with --profile)')
  .option('--tag-list <csv>', 'Replace tag list (comma-separated, telegram/discord only)')
  .option('--add-tag <tag>', 'Append one tag (telegram/discord only)')
  .option('--remove-tag <tag>', 'Remove one tag (telegram/discord only)')
  .option('--clear-tags', 'Clear all tags (telegram/discord only)')
  .option('--profile <name>', 'Named notification profile to configure')
  .option('--show', 'Show current configuration')
  .addHelpText('after', `
Types:
  file       File system callback (saves session summary to disk)
  telegram   Telegram bot notification
  discord    Discord webhook notification
  slack      Slack incoming webhook notification

Profile types (use with --profile):
  discord-bot  Discord Bot API (token + channel ID)
  slack        Slack incoming webhook
  webhook      Generic webhook (POST with JSON body)

Examples:
  $ omc config-stop-callback file --enable --path ~/.claude/logs/{date}.md
  $ omc config-stop-callback telegram --enable --token <token> --chat <id>
  $ omc config-stop-callback discord --enable --webhook <url>
  $ omc config-stop-callback file --disable
  $ omc config-stop-callback file --show

  # Named profiles (stored in notificationProfiles):
  $ omc config-stop-callback discord --profile work --enable --webhook <url>
  $ omc config-stop-callback telegram --profile work --enable --token <tk> --chat <id>
  $ omc config-stop-callback discord-bot --profile ops --enable --token <tk> --channel-id <id>

  # Select profile at launch:
  $ OMC_NOTIFY_PROFILE=work claude`)
  .action(async (type: string, options) => {
    // When --profile is used, route to profile-based config
    if (options.profile) {
      const profileValidTypes = ['file', 'telegram', 'discord', 'discord-bot', 'slack', 'webhook'];
      if (!profileValidTypes.includes(type)) {
        console.error(chalk.red(`Invalid type for profile: ${type}`));
        console.error(chalk.gray(`Valid types: ${profileValidTypes.join(', ')}`));
        process.exit(1);
      }

      const config = getOMCConfig() as OMCConfig & { notificationProfiles?: Record<string, any> };
      config.notificationProfiles = config.notificationProfiles || {};
      const profileName = options.profile as string;
      const profile = config.notificationProfiles[profileName] || { enabled: true };

      // Show current profile config
      if (options.show) {
        if (config.notificationProfiles[profileName]) {
          console.log(chalk.blue(`Profile "${profileName}" — ${type} configuration:`));
          const platformConfig = profile[type];
          if (platformConfig) {
            console.log(JSON.stringify(platformConfig, null, 2));
          } else {
            console.log(chalk.yellow(`No ${type} platform configured in profile "${profileName}".`));
          }
        } else {
          console.log(chalk.yellow(`Profile "${profileName}" not found.`));
        }
        return;
      }

      let enabled: boolean | undefined;
      if (options.enable) enabled = true;
      else if (options.disable) enabled = false;

      switch (type) {
        case 'discord': {
          const current = profile.discord;
          if (enabled === true && (!options.webhook && !current?.webhookUrl)) {
            console.error(chalk.red('Discord requires --webhook <webhook_url>'));
            process.exit(1);
          }
          profile.discord = {
            ...current,
            enabled: enabled ?? current?.enabled ?? false,
            webhookUrl: options.webhook ?? current?.webhookUrl,
          };
          break;
        }
        case 'discord-bot': {
          const current = profile['discord-bot'];
          if (enabled === true && (!options.token && !current?.botToken)) {
            console.error(chalk.red('Discord bot requires --token <bot_token>'));
            process.exit(1);
          }
          if (enabled === true && (!options.channelId && !current?.channelId)) {
            console.error(chalk.red('Discord bot requires --channel-id <channel_id>'));
            process.exit(1);
          }
          profile['discord-bot'] = {
            ...current,
            enabled: enabled ?? current?.enabled ?? false,
            botToken: options.token ?? current?.botToken,
            channelId: options.channelId ?? current?.channelId,
          };
          break;
        }
        case 'telegram': {
          const current = profile.telegram;
          if (enabled === true && (!options.token && !current?.botToken)) {
            console.error(chalk.red('Telegram requires --token <bot_token>'));
            process.exit(1);
          }
          if (enabled === true && (!options.chat && !current?.chatId)) {
            console.error(chalk.red('Telegram requires --chat <chat_id>'));
            process.exit(1);
          }
          profile.telegram = {
            ...current,
            enabled: enabled ?? current?.enabled ?? false,
            botToken: options.token ?? current?.botToken,
            chatId: options.chat ?? current?.chatId,
          };
          break;
        }
        case 'slack': {
          const current = profile.slack;
          if (enabled === true && (!options.webhook && !current?.webhookUrl)) {
            console.error(chalk.red('Slack requires --webhook <webhook_url>'));
            process.exit(1);
          }
          profile.slack = {
            ...current,
            enabled: enabled ?? current?.enabled ?? false,
            webhookUrl: options.webhook ?? current?.webhookUrl,
          };
          break;
        }
        case 'webhook': {
          const current = profile.webhook;
          if (enabled === true && (!options.webhook && !current?.url)) {
            console.error(chalk.red('Webhook requires --webhook <url>'));
            process.exit(1);
          }
          profile.webhook = {
            ...current,
            enabled: enabled ?? current?.enabled ?? false,
            url: options.webhook ?? current?.url,
          };
          break;
        }
        case 'file': {
          console.error(chalk.yellow('File callbacks are not supported in notification profiles.'));
          console.error(chalk.gray('Use without --profile for file callbacks.'));
          process.exit(1);
          break;
        }
      }

      config.notificationProfiles[profileName] = profile;

      try {
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        console.log(chalk.green(`\u2713 Profile "${profileName}" — ${type} configured`));
        console.log(JSON.stringify(profile[type], null, 2));
      } catch (error) {
        console.error(chalk.red('Failed to write configuration:'), error);
        process.exit(1);
      }
      return;
    }

    // Legacy (non-profile) path
    const validTypes = ['file', 'telegram', 'discord', 'slack'];
    if (!validTypes.includes(type)) {
      console.error(chalk.red(`Invalid callback type: ${type}`));
      console.error(chalk.gray(`Valid types: ${validTypes.join(', ')}`));
      process.exit(1);
    }

    const config = getOMCConfig();
    config.stopHookCallbacks = config.stopHookCallbacks || {};

    // Show current config
    if (options.show) {
      const current = config.stopHookCallbacks[type as keyof typeof config.stopHookCallbacks];
      if (current) {
        console.log(chalk.blue(`Current ${type} callback configuration:`));
        console.log(JSON.stringify(current, null, 2));
      } else {
        console.log(chalk.yellow(`No ${type} callback configured.`));
      }
      return;
    }

    // Determine enabled state
    let enabled: boolean | undefined;
    if (options.enable) {
      enabled = true;
    } else if (options.disable) {
      enabled = false;
    }

    const hasTagListChanges = options.tagList !== undefined
      || options.addTag !== undefined
      || options.removeTag !== undefined
      || options.clearTags;

    const parseTagList = (value: string): string[] => value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    const resolveTagList = (currentTagList?: string[]): string[] => {
      let next = options.tagList !== undefined
        ? parseTagList(options.tagList)
        : [...(currentTagList ?? [])];

      if (options.clearTags) {
        next = [];
      }

      if (options.addTag !== undefined) {
        const tagToAdd = String(options.addTag).trim();
        if (tagToAdd && !next.includes(tagToAdd)) {
          next.push(tagToAdd);
        }
      }

      if (options.removeTag !== undefined) {
        const tagToRemove = String(options.removeTag).trim();
        if (tagToRemove) {
          next = next.filter((tag) => tag !== tagToRemove);
        }
      }

      return next;
    };

    // Update config based on type
    switch (type) {
      case 'file': {
        const current = config.stopHookCallbacks.file;
        config.stopHookCallbacks.file = {
          enabled: enabled ?? current?.enabled ?? false,
          path: options.path ?? current?.path ?? '~/.claude/session-logs/{session_id}.md',
          format: (options.format as 'markdown' | 'json') ?? current?.format ?? 'markdown',
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
          ...current,
          enabled: enabled ?? current?.enabled ?? false,
          botToken: options.token ?? current?.botToken,
          chatId: options.chat ?? current?.chatId,
          tagList: hasTagListChanges ? resolveTagList(current?.tagList) : current?.tagList,
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
          ...current,
          enabled: enabled ?? current?.enabled ?? false,
          webhookUrl: options.webhook ?? current?.webhookUrl,
          tagList: hasTagListChanges ? resolveTagList(current?.tagList) : current?.tagList,
        };
        break;
      }

      case 'slack': {
        const current = config.stopHookCallbacks.slack;
        if (enabled === true && (!options.webhook && !current?.webhookUrl)) {
          console.error(chalk.red('Slack requires --webhook <webhook_url>'));
          process.exit(1);
        }
        config.stopHookCallbacks.slack = {
          ...current,
          enabled: enabled ?? current?.enabled ?? false,
          webhookUrl: options.webhook ?? current?.webhookUrl,
          tagList: hasTagListChanges ? resolveTagList(current?.tagList) : current?.tagList,
        };
        break;
      }
    }

    // Write config
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
      console.log(chalk.green(`\u2713 Stop callback '${type}' configured`));
      console.log(JSON.stringify(config.stopHookCallbacks[type as keyof typeof config.stopHookCallbacks], null, 2));
    } catch (error) {
      console.error(chalk.red('Failed to write configuration:'), error);
      process.exit(1);
    }
  });

/**
 * Config notify-profile subcommand - List, show, and delete notification profiles
 */
program
  .command('config-notify-profile [name]')
  .description('Manage notification profiles')
  .option('--list', 'List all profiles')
  .option('--show', 'Show profile configuration')
  .option('--delete', 'Delete a profile')
  .addHelpText('after', `
Examples:
  $ omc config-notify-profile --list
  $ omc config-notify-profile work --show
  $ omc config-notify-profile work --delete

  # Create/update profiles via config-stop-callback --profile:
  $ omc config-stop-callback discord --profile work --enable --webhook <url>

  # Select profile at launch:
  $ OMC_NOTIFY_PROFILE=work claude`)
  .action(async (name: string | undefined, options) => {
    const config = getOMCConfig() as OMCConfig & { notificationProfiles?: Record<string, any> };
    const profiles = config.notificationProfiles || {};

    if (options.list || !name) {
      const names = Object.keys(profiles);
      if (names.length === 0) {
        console.log(chalk.yellow('No notification profiles configured.'));
        console.log(chalk.gray('Create one with: omc config-stop-callback <type> --profile <name> --enable ...'));
      } else {
        console.log(chalk.blue('Notification profiles:'));
        for (const pName of names) {
          const p = profiles[pName];
          const platforms = ['discord', 'discord-bot', 'telegram', 'slack', 'webhook']
            .filter((plat) => p[plat]?.enabled)
            .join(', ');
          const status = p.enabled !== false ? chalk.green('enabled') : chalk.red('disabled');
          console.log(`  ${chalk.bold(pName)} [${status}] — ${platforms || 'no platforms'}`);
        }
      }
      const activeProfile = process.env.OMC_NOTIFY_PROFILE;
      if (activeProfile) {
        console.log(chalk.gray(`\nActive profile (OMC_NOTIFY_PROFILE): ${activeProfile}`));
      }
      return;
    }

    if (options.show) {
      if (profiles[name]) {
        console.log(chalk.blue(`Profile "${name}":`));
        console.log(JSON.stringify(profiles[name], null, 2));
      } else {
        console.log(chalk.yellow(`Profile "${name}" not found.`));
      }
      return;
    }

    if (options.delete) {
      if (!profiles[name]) {
        console.log(chalk.yellow(`Profile "${name}" not found.`));
        return;
      }
      delete profiles[name];
      config.notificationProfiles = profiles;
      if (Object.keys(profiles).length === 0) {
        delete config.notificationProfiles;
      }
      try {
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        console.log(chalk.green(`\u2713 Profile "${name}" deleted`));
      } catch (error) {
        console.error(chalk.red('Failed to write configuration:'), error);
        process.exit(1);
      }
      return;
    }

    // Default: show the named profile
    if (profiles[name]) {
      console.log(chalk.blue(`Profile "${name}":`));
      console.log(JSON.stringify(profiles[name], null, 2));
    } else {
      console.log(chalk.yellow(`Profile "${name}" not found.`));
      console.log(chalk.gray('Create it with: omc config-stop-callback <type> --profile ' + name + ' --enable ...'));
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
    const session = createOmcSession();

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
  .action(async (prompt: string) => {
    const session = createOmcSession();

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
      console.error(chalk.gray('Try again with "omc update --force", or reinstall with "omc install --force".'));
      process.exit(1);
    }
  });

/**
 * Update reconcile command - Internal command for post-update reconciliation
 * Called automatically after npm install to ensure hooks/settings are updated with NEW code
 */
program
  .command('update-reconcile')
  .description('Internal: Reconcile runtime state after update (called by update command)')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options) => {
    try {
      const reconcileResult = reconcileUpdateRuntime({ verbose: options.verbose });
      if (!reconcileResult.success) {
        console.error(chalk.red('Reconciliation failed:'));
        if (reconcileResult.errors) {
          reconcileResult.errors.forEach(err => console.error(chalk.red(`  - ${err}`)));
        }
        process.exit(1);
      }
      if (options.verbose) {
        console.log(chalk.green(reconcileResult.message));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Reconciliation error: ${message}`));
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
  .description('Install OMC agents and commands to Claude Code config (~/.claude/)')
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
        console.log(chalk.yellow('OMC is already installed.'));
        if (info) {
          console.log(chalk.gray(`  Version: ${info.version}`));
          console.log(chalk.gray(`  Installed: ${info.installedAt}`));
        }
        console.log(chalk.gray('\nUse --force to reinstall.'));
      }
      return;
    }

    // Run installation
    const result = installOmc({
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
        console.log('  /omc <task>              # Activate OMC orchestration mode');
        console.log('  /omc-default             # Configure for current project');
        console.log('  /omc-default-global      # Configure globally');
        console.log('  /ultrawork <task>             # Maximum performance mode');
        console.log('  /deepsearch <query>           # Thorough codebase search');
        console.log('  /analyze <target>             # Deep analysis mode');
        console.log('  /plan <description>           # Start planning with Planner');
        console.log('  /review [plan-path]           # Review plan with Critic');
        console.log('');
        console.log(chalk.yellow('Available Agents (via Task tool):'));
        console.log(chalk.gray('  Base Agents:'));
        console.log('    architect              - Architecture & debugging (Opus)');
        console.log('    document-specialist   - External docs & reference lookup (Sonnet)');
        console.log('    explore             - Fast pattern matching (Haiku)');
        console.log('    designer            - UI/UX specialist (Sonnet)');
        console.log('    writer              - Technical writing (Haiku)');
        console.log('    vision              - Visual analysis (Sonnet)');
        console.log('    critic               - Plan review (Opus)');
        console.log('    analyst               - Pre-planning analysis (Opus)');
        console.log('    debugger            - Root-cause diagnosis (Sonnet)');
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
        console.log('  Run \'/omc-default\' (project) or \'/omc-default-global\' (global)');
        console.log('  to download the latest CLAUDE.md configuration.');
        console.log('  This ensures you get the newest features and agent behaviors.');
        console.log('');
        console.log(chalk.blue('Quick Start:'));
        console.log('  1. Run \'claude\' to start Claude Code');
        console.log('  2. Type \'/omc-default\' for project or \'/omc-default-global\' for global');
        console.log('  3. Or use \'/omc <task>\' for one-time activation');
      }
    } else {
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
  .action(async (action: string, options) => {
    if (action !== 'start' && action !== 'stop') {
      console.error(chalk.red(`Invalid action "${action}". Valid options: start, stop`));
      console.error(chalk.gray('Example: omc wait daemon start'));
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
 * Teleport command - Quick worktree creation
 *
 * Usage:
 * - `omc teleport '#123'` - Create worktree for issue/PR #123
 * - `omc teleport my-feature` - Create worktree for feature branch
 * - `omc teleport list` - List existing worktrees
 * - `omc teleport remove <path>` - Remove a worktree
 */
const teleportCmd = program
  .command('teleport [ref]')
  .description("Create git worktree for isolated development (e.g., omc teleport '#123')")
  .option('--worktree', 'Create worktree (default behavior, flag kept for compatibility)')
  .option('-p, --path <path>', 'Custom worktree path (default: ~/Workspace/omc-worktrees/)')
  .option('-b, --base <branch>', 'Base branch to create from (default: main)')
  .option('--json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  $ omc teleport '#42'           Create worktree for issue/PR #42
  $ omc teleport add-auth        Create worktree for a feature branch
  $ omc teleport list            List existing worktrees
  $ omc teleport remove ./path   Remove a worktree

Note:
  In many shells, # starts a comment. Quote refs: omc teleport '#42'`)
  .action(async (ref: string | undefined, options) => {
    if (!ref) {
      // No ref provided, show help
      console.log(chalk.blue('Teleport - Quick worktree creation\n'));
      console.log('Usage:');
      console.log('  omc teleport <ref>           Create worktree for issue/PR/feature');
      console.log('  omc teleport list            List existing worktrees');
      console.log('  omc teleport remove <path>   Remove a worktree');
      console.log('');
      console.log('Reference formats:');
      console.log("  '#123'                       Issue/PR in current repo (quoted for shell safety)");
      console.log('  owner/repo#123               Issue/PR in specific repo');
      console.log('  my-feature                   Feature branch name');
      console.log('  https://github.com/...       GitHub URL');
      console.log('');
      console.log(chalk.yellow("Note: In many shells, # starts a comment. Quote refs: omc teleport '#42'"));
      console.log('');
      console.log('Examples:');
      console.log("  omc teleport '#42'           Create worktree for issue #42");
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
  .action(async (path: string, options) => {
    const exitCode = await teleportRemoveCommand(path, options);
    if (exitCode !== 0) process.exit(exitCode);
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
 * Setup command - Official CLI entry point for omc-setup
 *
 * User-friendly command that syncs all OMC components:
 * - Installs/updates hooks, agents, and skills
 * - Reconciles runtime state after updates
 * - Shows clear summary of what was installed/updated
 */
program
  .command('setup')
  .description('Run OMC setup to sync all components (hooks, agents, skills)')
  .option('-f, --force', 'Force reinstall even if already up to date')
  .option('-q, --quiet', 'Suppress output except for errors')
  .option('--skip-hooks', 'Skip hook installation')
  .option('--force-hooks', 'Force reinstall hooks even if unchanged')
  .addHelpText('after', `
Examples:
  $ omc setup                     Sync all OMC components
  $ omc setup --force             Force reinstall everything
  $ omc setup --quiet             Silent setup for scripts
  $ omc setup --skip-hooks        Install without hooks
  $ omc setup --force-hooks       Force reinstall hooks`)
  .action(async (options) => {
    if (!options.quiet) {
      console.log(chalk.blue('Oh-My-ClaudeCode Setup\n'));
    }

    // Step 1: Run installation (which handles hooks, agents, skills)
    if (!options.quiet) {
      console.log(chalk.gray('Syncing OMC components...'));
    }

    const result = installOmc({
      force: !!options.force,
      verbose: !options.quiet,
      skipClaudeCheck: true,
      forceHooks: !!options.forceHooks,
    });

    if (!result.success) {
      console.error(chalk.red(`Setup failed: ${result.message}`));
      if (result.errors.length > 0) {
        result.errors.forEach(err => console.error(chalk.red(`  - ${err}`)));
      }
      process.exit(1);
    }

    // Step 2: Show summary
    if (!options.quiet) {
      console.log('');
      console.log(chalk.green('Setup complete!'));
      console.log('');

      if (result.installedAgents.length > 0) {
        console.log(chalk.gray(`  Agents:   ${result.installedAgents.length} synced`));
      }
      if (result.installedCommands.length > 0) {
        console.log(chalk.gray(`  Commands: ${result.installedCommands.length} synced`));
      }
      if (result.installedSkills.length > 0) {
        console.log(chalk.gray(`  Skills:   ${result.installedSkills.length} synced`));
      }
      if (result.hooksConfigured) {
        console.log(chalk.gray('  Hooks:    configured'));
      }
      if (result.hookConflicts.length > 0) {
        console.log('');
        console.log(chalk.yellow('  Hook conflicts detected:'));
        result.hookConflicts.forEach(c => {
          console.log(chalk.yellow(`    - ${c.eventType}: ${c.existingCommand}`));
        });
      }

      console.log('');
      console.log(chalk.gray(`Version: ${version}`));
      console.log(chalk.gray('Start Claude Code and use /oh-my-claudecode:omc-setup for interactive setup.'));
    }
  });

/**
 * Postinstall command - Silent install for npm postinstall hook
 */
program
  .command('postinstall', { hidden: true })
  .description('Run post-install setup (called automatically by npm)')
  .action(async () => {
    // Silent install - only show errors
    const result = installOmc({
      force: false,
      verbose: false,
      skipClaudeCheck: true
    });

    if (result.success) {
      console.log(chalk.green('✓ Oh-My-ClaudeCode installed successfully!'));
      console.log(chalk.gray('  Run "oh-my-claudecode info" to see available agents.'));
      console.log(chalk.yellow('  Run "/omc-default" (project) or "/omc-default-global" (global) in Claude Code.'));
    } else {
      // Don't fail the npm install, just warn
      console.warn(chalk.yellow('⚠ Could not complete OMC setup:'), result.message);
      console.warn(chalk.gray('  Run "oh-my-claudecode install" manually to complete setup.'));
    }
  });

/**
 * HUD command - Run the OMC HUD statusline renderer
 * In --watch mode, loops continuously for use in a tmux pane.
 */
program
  .command('hud')
  .description('Run the OMC HUD statusline renderer')
  .option('--watch', 'Run in watch mode (continuous polling for tmux pane)')
  .option('--interval <ms>', 'Poll interval in milliseconds', '1000')
  .action(async (options) => {
    const { main: hudMain } = await import('../hud/index.js');
    if (options.watch) {
      const intervalMs = parseInt(options.interval, 10);
      while (true) {
        await hudMain(true);
        await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
      }
    } else {
      await hudMain();
    }
  });

// Parse arguments
program.parse();

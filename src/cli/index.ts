#!/usr/bin/env node

/**
 * Oh-My-ClaudeCode CLI
 *
 * Command-line interface for the OMC multi-agent system.
 *
 * Commands:
 * - run: Start an interactive session
 * - config: Show or edit configuration
 * - setup: Sync all OMC components (hooks, agents, skills)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { join, dirname } from 'path';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { OMC_PLUGIN_ROOT_ENV } from '../lib/env-vars.js';
import {
  loadConfig,
  getConfigPaths,
} from '../config/loader.js';
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
  getInstallInfo,
  isRunningAsPlugin,
  getInstalledOmcPluginRoots,
  pruneStandaloneDuplicatesForPluginMode,
} from '../installer/index.js';
import { uninstall as runUninstall } from '../installer/uninstall.js';
import { runSetup, readAlreadyConfigured } from '../setup/index.js';
import {
  mapSetupCommanderOpts,
  loadPreset,
  resolveOptions,
  InvalidOptionsError,
  type SetupOptions,
  type SetupPhase,
} from '../setup/options.js';
import { SAFE_DEFAULTS, dumpSafeDefaultsAsJson } from '../setup/safe-defaults.js';
import { buildPreset, type AnswersFile } from '../setup/preset-builder.js';
import { createReadlinePrompter } from '../setup/prompts.js';
import { runInteractiveWizard } from '../setup/wizard-prompts.js';
import { isNonInteractive } from '../hooks/non-interactive-env/detector.js';
import {
  waitCommand,
  waitStatusCommand,
  waitDaemonCommand,
  waitDetectCommand
} from './commands/wait.js';
import { doctorConflictsCommand } from './commands/doctor-conflicts.js';
import { sessionSearchCommand } from './commands/session-search.js';
import { teamCommand } from './commands/team.js';
import { ralphthonCommand } from './commands/ralphthon.js';
import {
  teleportCommand,
  teleportListCommand,
  teleportRemoveCommand
} from './commands/teleport.js';

import { getRuntimePackageVersion } from '../lib/version.js';
import { resolvePluginDirArg } from '../lib/plugin-dir.js';
import { launchCommand } from './launch.js';
import { interopCommand } from './interop.js';
import { askCommand, ASK_USAGE } from './ask.js';
import { warnIfWin32 } from './win32-warning.js';
import { autoresearchCommand } from './autoresearch.js';
import { runHudWatchLoop } from './hud-watch.js';

const version = getRuntimePackageVersion();

/**
 * Apply a --plugin-dir option value: resolve to absolute path, warn if it
 * disagrees with a pre-existing OMC_PLUGIN_ROOT env var, then set the env var
 * so all subsequent code in this process sees the correct plugin root.
 *
 * No-op when `rawPath` is undefined/empty (option was not passed).
 */
export function applyPluginDirOption(rawPath: string | undefined): void {
  if (!rawPath) return;
  let resolved: string;
  try {
    resolved = resolvePluginDirArg(rawPath);
  } catch (err) {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
  const existing = process.env[OMC_PLUGIN_ROOT_ENV];
  if (existing && existing !== resolved) {
    console.warn(
      chalk.yellow(
        `Warning: --plugin-dir "${resolved}" overrides ${OMC_PLUGIN_ROOT_ENV}="${existing}"`
      )
    );
  }
  process.env[OMC_PLUGIN_ROOT_ENV] = resolved;
}

const program = new Command();

// Win32 platform warning - OMC requires tmux which is not available on native Windows
warnIfWin32();

// Default action when running 'omc' with no subcommand
// Forwards all args to launchCommand so 'omc --notify false --madmax' etc. work directly
async function defaultAction() {
  // Pass all CLI args through to launch (strip node + script path)
  const args = process.argv.slice(2);

  // Defensive fallback: wrapper/bridge invocations must preserve explicit ask routing
  // so nested Claude launch checks only apply to actual Claude launches.
  if (args[0] === 'ask') {
    await askCommand(args.slice(1));
    return;
  }

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
 * Ask command - Run provider advisor prompt (claude|gemini)
 */
program
  .command('ask [args...]')
  .description('Run provider advisor prompt and write an ask artifact')
  .allowUnknownOption()
  .addHelpText('after', `\n${ASK_USAGE}`)
  .action(async (args: string[]) => {
    await askCommand(args || []);
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
  $ omc config-stop-callback file --enable --path ${join(getClaudeConfigDir(), 'logs/{date}.md')}
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
          path: options.path ?? current?.path ?? join(getClaudeConfigDir(), 'session-logs/{session_id}.md'),
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
  .option('--clean', 'Purge old plugin cache versions immediately (bypass 24h grace period)')
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

      const result = await performUpdate({ verbose: !options.quiet, standalone: options.standalone, clean: options.clean });

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
  .option('--skip-grace-period', 'Bypass 24h grace period for cache purge')
  .action(async (options) => {
    try {
      const reconcileResult = reconcileUpdateRuntime({ verbose: options.verbose, skipGracePeriod: options.skipGracePeriod });
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
 * Install command - Install agents and commands (default: ~/.claude/)
 */
program
  .command('install')
  .description('Install OMC agents and commands to Claude Code config directory (default: ~/.claude/)')
  .option('-f, --force', 'Overwrite existing files')
  .option('-q, --quiet', 'Suppress output except for errors')
  .option('--skip-claude-check', 'Skip checking if Claude Code is installed')
  .addHelpText('after', `
Examples:
  $ omc install                  Install to config directory (default: ~/.claude/)
  $ omc install --force          Reinstall, overwriting existing files
  $ omc install --quiet          Silent install for scripts
  $ CLAUDE_CONFIG_DIR=$HOME/.claude-isolated-workspace omc install  Isolated config directory`)
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
        console.log(chalk.gray(`Installed to: ${getClaudeConfigDir()}`));
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
 * Session command - Search prior local session history
 */
const sessionCmd = program
  .command('session')
  .alias('sessions')
  .description('Inspect prior local session history')
  .addHelpText('after', `
Examples:
  $ omc session search "team leader stale"
  $ omc session search notify-hook --since 7d
  $ omc session search provider-routing --project all --json`);

sessionCmd
  .command('search <query>')
  .description('Search prior local session transcripts and OMC session artifacts')
  .option('-l, --limit <number>', 'Maximum number of matches to return', '10')
  .option('-s, --session <id>', 'Restrict search to a specific session id')
  .option('--since <duration|date>', 'Only include matches since a duration (e.g. 7d, 24h) or absolute date')
  .option('--project <scope>', 'Project scope. Defaults to current project. Use "all" to search all local projects')
  .option('--json', 'Output results as JSON')
  .option('--case-sensitive', 'Match query case-sensitively')
  .option('--context <chars>', 'Approximate snippet context on each side of a match', '120')
  .action(async (query: string, options) => {
    await sessionSearchCommand(query, {
      limit: parseInt(options.limit, 10),
      session: options.session,
      since: options.since,
      project: options.project,
      json: options.json,
      caseSensitive: options.caseSensitive,
      context: parseInt(options.context, 10),
      workingDirectory: process.cwd(),
    });
  });

/**
 * Doctor command - Diagnostic tools
 */
const doctorCmd = program
  .command('doctor')
  .description('Diagnostic tools for troubleshooting OMC installation')
  .option('--plugin-dir <path>', 'Override OMC plugin root directory (sets OMC_PLUGIN_ROOT)')
  .addHelpText('after', `
Examples:
  $ omc doctor conflicts                        Check for plugin conflicts
  $ omc doctor --plugin-dir /path/to/plugin     Run diagnostics against a specific plugin dir`)
  .hook('preAction', (thisCommand) => {
    applyPluginDirOption(thisCommand.opts().pluginDir as string | undefined);
  });

doctorCmd
  .command('conflicts')
  .description('Check for plugin coexistence issues and configuration conflicts')
  .option('--json', 'Output as JSON')
  .option('--plugin-dir <path>', 'Override OMC plugin root directory (sets OMC_PLUGIN_ROOT)')
  .addHelpText('after', `
Examples:
  $ omc doctor conflicts                        Check for configuration issues
  $ omc doctor conflicts --json                 Output results as JSON
  $ omc doctor conflicts --plugin-dir /tmp/foo  Check against a specific plugin dir`)
  .action(async (options) => {
    applyPluginDirOption(options.pluginDir);
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

/**
 * Emit a one-shot stderr advisory for `--skip-hooks` (non-regression #2).
 *
 * The flag now actually skips hook installation (previously a no-op),
 * so we warn scripts that silently relied on the old behavior. Suppressed
 * on repeat invocations via a daily sentinel under
 * `$XDG_STATE_HOME/omc/` (fallback: `$HOME/.omc/state/`) — don't spam
 * `omc setup --skip-hooks` in a tight loop.
 */
export function emitSkipHooksAdvisory(stderr: NodeJS.WritableStream = process.stderr): void {
  try {
    const stateDir =
      process.env.XDG_STATE_HOME
        ? join(process.env.XDG_STATE_HOME, 'omc')
        : join(homedir(), '.omc', 'state');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const sentinel = join(stateDir, `skip-hooks-advised-${today}`);
    if (existsSync(sentinel)) return;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(sentinel, '', 'utf-8');
  } catch {
    // Sentinel write best-effort: if it fails we just re-emit the advisory.
  }
  stderr.write(
    chalk.yellow(
      'warning: --skip-hooks is now honored (previously a no-op). ' +
      'This flag is deprecated and will be removed in a future release. ' +
      'Hooks will NOT be installed for this run.\n',
    ),
  );
}

/**
 * `--build-preset` internal subcommand implementation.
 *
 * Reads `--answers <file>` as JSON, runs `buildPreset()` to produce a
 * validated `SetupOptions`, serializes to JSON, and writes to `--out`.
 * Exit 0 on success, non-zero on invalid answers / IO errors.
 *
 * This mirrors the skill's contract: skill collects answers → writes
 * JSON to tmp file → invokes `omc setup --build-preset` → invokes
 * `omc setup --preset <out>`. All decision logic lives in the pure
 * `buildPreset()` function which is exhaustively unit-tested.
 */
export function runBuildPreset(
  answersPath: string,
  outPath: string,
  stderr: NodeJS.WritableStream = process.stderr,
): number {
  if (!existsSync(answersPath)) {
    stderr.write(chalk.red(`--build-preset: answers file not found: ${answersPath}\n`));
    return 1;
  }
  let answers: AnswersFile;
  try {
    const raw = readFileSync(answersPath, 'utf-8');
    answers = JSON.parse(raw) as AnswersFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(chalk.red(`--build-preset: could not parse ${answersPath}: ${msg}\n`));
    return 1;
  }

  let resolved: SetupOptions;
  try {
    resolved = buildPreset(answers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(chalk.red(`--build-preset: ${msg}\n`));
    return 2;
  }

  // Serialize. `SetupOptions.phases` is a Set — convert to an array for
  // the preset schema, which loadPreset() re-inflates via presetToPartial.
  const serializable = {
    ...resolved,
    phases: Array.from(resolved.phases),
  };
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(serializable, null, 2), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(chalk.red(`--build-preset: could not write ${outPath}: ${msg}\n`));
    return 1;
  }

  // Echo the output path on stdout so wrappers can pipe it.
  process.stdout.write(`${outPath}\n`);
  return 0;
}

/**
 * Convert `SAFE_DEFAULTS` into a `Partial<SetupOptions>` so `resolveOptions`
 * can merge it as a preset-equivalent base layer. Deep-clones the `mcp`,
 * `teams`, `installerOptions`, `hud`, and `phases` fields to prevent callers
 * from mutating the frozen top-level constant.
 */
/**
 * Check whether the global base CLAUDE.md at `$CLAUDE_CONFIG_DIR/CLAUDE.md`
 * exists and is missing OMC markers. Used by the interactive wizard to
 * decide whether to ask the `installStyle` question (overwrite vs. preserve
 * into `CLAUDE-omc.md`). Returns `false` when:
 *   - the file doesn't exist (nothing to preserve)
 *   - the file already contains `<!-- OMC:BEGIN -->` (already an OMC file)
 *   - filesystem / encoding errors (fail safe: don't prompt)
 */
function hasNonOmcBaseClaudeMd(): boolean {
  try {
    const basePath = join(getClaudeConfigDir(), 'CLAUDE.md');
    if (!existsSync(basePath)) return false;
    const contents = readFileSync(basePath, 'utf-8');
    // OMC-installed files carry this sentinel at the top of the managed block.
    if (contents.includes('<!-- OMC:BEGIN -->')) return false;
    return contents.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Convert a fully-resolved `SetupOptions` (e.g. from `buildPreset(answers)`)
 * into a `Partial<SetupOptions>` suitable for the preset layer of
 * `resolveOptions` precedence. Strips the `phases` Set — phases are always
 * re-derived by `resolveOptions` from the flag combination + preset contents.
 * Deep-clones `mcp`, `teams`, `installerOptions` so callers can't mutate
 * the wizard's returned value.
 */
function wizardOptionsAsPartial(opts: SetupOptions): Partial<SetupOptions> {
  return {
    phases: new Set<SetupPhase>(opts.phases),
    interactive: opts.interactive,
    force: opts.force,
    quiet: opts.quiet,
    target: opts.target,
    installStyle: opts.installStyle,
    installCli: opts.installCli,
    executionMode: opts.executionMode,
    taskTool: opts.taskTool,
    skipHud: opts.skipHud,
    mcp: {
      ...opts.mcp,
      credentials: { ...opts.mcp.credentials },
      servers: [...opts.mcp.servers],
    },
    teams: { ...opts.teams },
    starRepo: opts.starRepo,
    installerOptions: { ...opts.installerOptions },
    hud: opts.hud ? { elements: { ...opts.hud.elements } } : undefined,
  };
}

function safeDefaultsAsPartial(): Partial<SetupOptions> {
  return {
    phases: new Set<SetupPhase>(SAFE_DEFAULTS.phases),
    interactive: SAFE_DEFAULTS.interactive,
    force: SAFE_DEFAULTS.force,
    quiet: SAFE_DEFAULTS.quiet,
    target: SAFE_DEFAULTS.target,
    installStyle: SAFE_DEFAULTS.installStyle,
    installCli: SAFE_DEFAULTS.installCli,
    executionMode: SAFE_DEFAULTS.executionMode,
    taskTool: SAFE_DEFAULTS.taskTool,
    skipHud: SAFE_DEFAULTS.skipHud,
    mcp: {
      ...SAFE_DEFAULTS.mcp,
      credentials: { ...SAFE_DEFAULTS.mcp.credentials },
      servers: [...SAFE_DEFAULTS.mcp.servers],
    },
    teams: { ...SAFE_DEFAULTS.teams },
    starRepo: SAFE_DEFAULTS.starRepo,
    installerOptions: { ...SAFE_DEFAULTS.installerOptions },
    hud: SAFE_DEFAULTS.hud
      ? { elements: { ...SAFE_DEFAULTS.hud.elements } }
      : undefined,
  };
}

/**
 * Main `omc setup` action handler, broken out of the commander `.action(...)`
 * closure so tests can invoke it directly with a synthetic option bag.
 *
 * Responsibilities:
 *   1. Map commander-parsed opts into a Partial<SetupOptions> via
 *      `mapSetupCommanderOpts()`.
 *   2. If `--build-preset` is set, dispatch to `runBuildPreset()` and return.
 *   3. Otherwise, load optional preset, call `resolveOptions()`, honor the
 *      legacy `OMC_PLUGIN_ROOT_ENV` auto-detection + conflict resolution,
 *      emit the skipHooks advisory on first use, call `runSetup()`, and
 *      print today's summary for the bare-infra path.
 *   4. Bare `omc setup` (no opt-in phase flags) runs the safe-defaults flow;
 *      `--infra-only` is the escape hatch for pre-safe-defaults behavior.
 *   5. Return the process exit code (never calls process.exit directly).
 *
 * Tests may construct the `commanderOpts` bag directly; production code
 * passes `cmd.opts()` from the commander action handler.
 */
export async function runSetupCommand(
  commanderOpts: Record<string, unknown>,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  let flagsPartial: Partial<SetupOptions>;
  try {
    flagsPartial = mapSetupCommanderOpts(commanderOpts);
  } catch (err) {
    if (err instanceof InvalidOptionsError) {
      stderr.write(chalk.red(`setup: ${err.message}\n`));
      return 2;
    }
    throw err;
  }

  // ------------------------------------------------------------------
  // --build-preset internal subcommand
  // ------------------------------------------------------------------
  const rawFlags = (flagsPartial as { __rawFlags?: Record<string, unknown> }).__rawFlags ?? {};
  if (rawFlags.buildPreset) {
    if (!rawFlags.answers || typeof rawFlags.answers !== 'string') {
      stderr.write(chalk.red('--build-preset requires --answers <file>\n'));
      return 2;
    }
    if (!rawFlags.out || typeof rawFlags.out !== 'string') {
      stderr.write(chalk.red('--build-preset requires --out <file>\n'));
      return 2;
    }
    return runBuildPreset(rawFlags.answers, rawFlags.out, stderr);
  }

  // ------------------------------------------------------------------
  // --dump-safe-defaults: print SAFE_DEFAULTS preset JSON and exit.
  // Users can redirect stdout to a file and tweak it for a custom preset.
  // ------------------------------------------------------------------
  if (rawFlags.dumpSafeDefaults) {
    process.stdout.write(dumpSafeDefaultsAsJson());
    return 0;
  }

  // ------------------------------------------------------------------
  // Detect the "bare" path: no opt-in phase/mode flags. Bare `omc setup`
  // dispatches to ONE of three branches:
  //
  //   1. TTY + no --non-interactive          → interactive wizard (11 qs)
  //   2. non-TTY, or --non-interactive       → SAFE_DEFAULTS preset
  //   3. --interactive (explicit)            → interactive wizard, errors
  //                                            clearly on non-TTY
  //
  // `--infra-only` is the explicit escape hatch for callers that want the
  // pre-safe-defaults bare-setup behavior (CI, provisioning, tests).
  //
  // Note: `--interactive` / `--non-interactive` are MODE overrides for the
  // bare path — they don't count as "opt-in phase flags" themselves, so we
  // exclude them from `optInPhaseFlags`. They still reach `resolveOptions`
  // via `rawFlags` for downstream validation (X4, X5).
  // ------------------------------------------------------------------
  const optInPhaseFlags = Boolean(
    rawFlags.wizard
      || rawFlags.preset
      || rawFlags.claudeMdOnly
      || rawFlags.mcpOnly
      || rawFlags.stateSave !== undefined
      || rawFlags.stateClear
      || rawFlags.stateResume
      || rawFlags.stateComplete !== undefined
      || rawFlags.checkState
      || rawFlags.local
      || rawFlags.global
      || rawFlags.infraOnly,
  );

  // TTY / non-interactive detection for wizard dispatch. `isNonInteractive`
  // is the canonical detector (CI, CLAUDE_CODE_RUN, non-TTY stdout, etc.).
  const isTTY = !isNonInteractive();
  const forceInteractive = Boolean(rawFlags.interactive);
  const forceNonInteractive = Boolean(rawFlags.nonInteractive);
  // `--quiet` is an implicit non-interactive signal: scripted callers that
  // pass `omc setup --quiet` (or `--force --quiet`) expect silent operation
  // and should NOT be surprised by an interactive wizard even on a TTY.
  // This is a wizard-dispatch-only override — it does NOT count as an
  // explicit `--non-interactive` for the mutex check with `--interactive`.
  const quietImpliesNonInteractive = Boolean(rawFlags.quiet);

  // X0 (new): --interactive + --non-interactive are mutually exclusive.
  if (forceInteractive && forceNonInteractive) {
    stderr.write(chalk.red('setup: --interactive and --non-interactive are mutually exclusive\n'));
    return 2;
  }

  // X4 (explicit): --interactive on a non-TTY environment is a hard error
  // on the bare path. When --interactive is combined with other phase
  // flags (e.g. --claude-md-only), resolveOptions's existing X4 check
  // surfaces the error with the same exit code and a more specific message,
  // so we scope the new CLI-level check to the bare path.
  if (forceInteractive && !isTTY && !optInPhaseFlags) {
    stderr.write(
      chalk.red(
        'setup: --interactive requires a TTY. Run in a real terminal, or drop the flag to fall back to --non-interactive safe-defaults.\n',
      ),
    );
    return 2;
  }

  // Wizard fires on bare + TTY + no forced non-interactive (and no --quiet).
  // `--interactive` on the bare path forces the wizard; when `--interactive`
  // is combined with explicit phase flags (e.g. `--claude-md-only`), the
  // existing per-phase prompter pipeline inside runSetup handles
  // interactivity and the pre-phase wizard is skipped.
  const runWizardBeforeSetup =
    !optInPhaseFlags
    && isTTY
    && !forceNonInteractive
    && !quietImpliesNonInteractive;

  // Safe-defaults fires on bare + (non-TTY OR explicit --non-interactive OR
  // --quiet). When the wizard path is taken, safe-defaults is NOT applied —
  // the wizard's own answers produce the full SetupOptions via buildPreset.
  const useSafeDefaults = !optInPhaseFlags && !runWizardBeforeSetup;

  // ------------------------------------------------------------------
  // Plugin-presence check. Gate on the bare-safe-defaults path and the
  // explicit `--wizard` path only — `--infra-only`, state ops, check-state,
  // claude-md-only, and `--no-plugin` have no plugin requirement today and
  // must stay that way to preserve scripted-caller contracts.
  // ------------------------------------------------------------------
  const noPluginFlag = Boolean(
    (rawFlags as { plugin?: boolean }).plugin === false
      || (rawFlags as { noPlugin?: boolean }).noPlugin,
  );
  const requiresPluginCheck =
    !rawFlags.infraOnly
    && !rawFlags.claudeMdOnly
    && !rawFlags.checkState
    && rawFlags.stateSave === undefined
    && !rawFlags.stateClear
    && !rawFlags.stateResume
    && rawFlags.stateComplete === undefined
    && !noPluginFlag
    && (useSafeDefaults || runWizardBeforeSetup || Boolean(rawFlags.wizard));

  if (requiresPluginCheck) {
    const pluginOk =
      isRunningAsPlugin()
      || getInstalledOmcPluginRoots().length > 0
      || Boolean(process.env.CLAUDE_PLUGIN_ROOT)
      || Boolean(process.env[OMC_PLUGIN_ROOT_ENV]);
    if (!pluginOk) {
      stderr.write(chalk.red('ERROR: oh-my-claudecode plugin installation not detected.\n\n'));
      stderr.write('Suggestions:\n');
      stderr.write('  \u2022 Install the plugin:     claude /plugin install oh-my-claudecode\n');
      stderr.write('  \u2022 Use plugin-dir mode:    omc setup --plugin-dir-mode (for dev checkouts)\n');
      stderr.write('  \u2022 Use bundled skills:     omc setup --no-plugin (copies bundled skills globally)\n');
      stderr.write('  \u2022 Escape to infra-only:   omc setup --infra-only (minimal install, pre-safe-defaults behavior)\n');
      return 1;
    }
  }

  // ------------------------------------------------------------------
  // Load preset file if provided
  // ------------------------------------------------------------------
  let presetPartial: Partial<SetupOptions> | undefined;
  if (flagsPartial.presetFile) {
    try {
      presetPartial = loadPreset(flagsPartial.presetFile);
    } catch (err) {
      if (err instanceof InvalidOptionsError) {
        stderr.write(chalk.red(`setup: ${err.message}\n`));
        return 2;
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Pre-wizard already-configured gate: check state FIRST so we don't
  // waste the user's time answering 11 questions only to be told "OMC
  // is already configured" after they submit. If alreadyConfigured and
  // not --force, also run the plugin-duplicate cleanup and exit.
  // ------------------------------------------------------------------
  if (runWizardBeforeSetup && !presetPartial && !flagsPartial.force) {
    const ac = readAlreadyConfigured(getClaudeConfigDir());
    if (ac.alreadyConfigured) {
      const pruneResult = pruneStandaloneDuplicatesForPluginMode(
        (msg) => process.stdout.write(`${msg}\n`),
      );
      const totalPruned =
        pruneResult.prunedAgents.length
        + pruneResult.prunedSkills.length
        + pruneResult.prunedHooks.length;
      if (totalPruned > 0 || pruneResult.settingsStripped) {
        process.stdout.write(chalk.green(
          `Cleaned up plugin-duplicate leftovers: `
          + `${pruneResult.prunedAgents.length} agent(s), `
          + `${pruneResult.prunedSkills.length} skill(s), `
          + `${pruneResult.prunedHooks.length} hook(s)`
          + (pruneResult.settingsStripped ? ', settings.json stripped' : '')
          + '\n',
        ));
      }

      process.stdout.write(chalk.yellow(
        `OMC is already configured (version ${ac.setupVersion ?? 'unknown'}). `
        + 'Re-run with --force to bypass this check, or use --claude-md-only '
        + 'for a quick CLAUDE.md refresh.\n',
      ));
      return 0;
    }
  }

  // ------------------------------------------------------------------
  // Interactive wizard branch (bare + TTY, or explicit --interactive).
  // Collect 11 answers via the readline prompter, run buildPreset() to
  // produce a full SetupOptions, then convert to Partial for the preset
  // layer so user flags (--force, --quiet) still win via resolveOptions.
  // ------------------------------------------------------------------
  if (runWizardBeforeSetup && !presetPartial) {
    const prompter = createReadlinePrompter();
    try {
      const answers = await runInteractiveWizard(prompter, {
        // Only ask the installStyle question when the user will land on a
        // base CLAUDE.md that does NOT already contain OMC markers.
        detectInstallStyleNeeded: () => hasNonOmcBaseClaudeMd(),
        // Skip the installCli question: if the user is already running
        // `omc setup`, the CLI is obviously already installed on PATH.
        // The `/oh-my-claudecode:omc-setup` skill path still asks it.
        skipInstallCliQuestion: true,
      });
      const wizardOptions = buildPreset(answers);
      presetPartial = wizardOptionsAsPartial(wizardOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(chalk.red(`setup: interactive wizard failed: ${msg}\n`));
      return 2;
    } finally {
      prompter.close();
    }
  }

  // ------------------------------------------------------------------
  // For the bare safe-defaults path, merge SAFE_DEFAULTS as a preset-
  // equivalent base layer. User flags (e.g. `--force`, `--quiet`) still
  // win via resolveOptions precedence. `--infra-only` bypasses this.
  // ------------------------------------------------------------------
  if (useSafeDefaults && !presetPartial) {
    presetPartial = safeDefaultsAsPartial();
  }

  // ------------------------------------------------------------------
  // Resolve into a full SetupOptions
  // ------------------------------------------------------------------
  let options: SetupOptions;
  try {
    options = resolveOptions(flagsPartial, presetPartial);
  } catch (err) {
    if (err instanceof InvalidOptionsError) {
      stderr.write(chalk.red(`setup: ${err.message}\n`));
      return 2;
    }
    throw err;
  }

  // ------------------------------------------------------------------
  // Preserve today's OMC_PLUGIN_ROOT auto-detection + conflict handling.
  // Only meaningful for the bare-infra path (no explicit phase flags),
  // but harmless to apply universally since the installer honors it.
  // ------------------------------------------------------------------
  if (!options.installerOptions.pluginDirMode && process.env[OMC_PLUGIN_ROOT_ENV]) {
    options.installerOptions.pluginDirMode = true;
    if (!options.quiet) {
      console.log(chalk.gray(`Detected ${OMC_PLUGIN_ROOT_ENV} — entering dev plugin-dir mode`));
    }
  }
  if (options.installerOptions.pluginDirMode && options.installerOptions.noPlugin) {
    if (!options.quiet) {
      console.log(chalk.yellow('Warning: --plugin-dir-mode and --no-plugin conflict; --no-plugin takes precedence'));
    }
    options.installerOptions.pluginDirMode = false;
  }
  if (options.installerOptions.pluginDirMode && !options.quiet) {
    console.log(chalk.gray('Dev plugin-dir mode: skipping agent/skill sync (plugin provides them via --plugin-dir)'));
  }

  // ------------------------------------------------------------------
  // Backfill legacy boolean defaults so the install() call shape is
  // identical to today's (which always passed these booleans explicitly).
  // The backward-compat test inspects the exact InstallOptions that
  // install() receives — keep the six known keys present even when
  // their value is `false`.
  // ------------------------------------------------------------------
  options.installerOptions.force ??= false;
  options.installerOptions.verbose ??= !options.quiet;
  options.installerOptions.skipClaudeCheck ??= true;
  options.installerOptions.forceHooks ??= false;
  options.installerOptions.noPlugin ??= false;
  options.installerOptions.pluginDirMode ??= false;

  // ------------------------------------------------------------------
  // Deprecation advisory for --skip-hooks (first use per day).
  // ------------------------------------------------------------------
  if (options.installerOptions.skipHooks) {
    emitSkipHooksAdvisory(stderr);
  }

  // ------------------------------------------------------------------
  // For the bare-infra path, preserve today's header + summary output.
  // For other paths (wizard, state machine, check-state, mcp-only),
  // runSetup handles its own output and we only need to print errors.
  // ------------------------------------------------------------------
  const isBareInfra = options.phases.size === 1 && options.phases.has('infra');
  const isStateOrCheck =
    options.checkState === true ||
    (options.phases.has('state') && options.stateAction !== undefined);

  if (isBareInfra && !isStateOrCheck && !options.quiet) {
    console.log(chalk.blue('Oh-My-ClaudeCode Setup\n'));
    console.log(chalk.gray('Syncing OMC components...'));
  }

  const result = await runSetup(options);

  // Print errors even for quiet mode
  if (!result.success) {
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        stderr.write(chalk.red(`  - ${err}\n`));
      }
    } else if (!options.quiet) {
      stderr.write(chalk.red('Setup failed\n'));
    }
    return result.exitCode || 1;
  }

  // Summary printing for the bare-infra backward-compat path only.
  if (isBareInfra && !options.quiet && result.installResult) {
    const installResult = result.installResult;
    console.log('');
    console.log(chalk.green('Setup complete!'));
    console.log('');

    if (installResult.installedAgents.length > 0) {
      console.log(chalk.gray(`  Agents:   ${installResult.installedAgents.length} synced`));
    }
    if (installResult.installedCommands.length > 0) {
      console.log(chalk.gray(`  Commands: ${installResult.installedCommands.length} synced`));
    }
    if (installResult.installedSkills.length > 0) {
      console.log(chalk.gray(`  Skills:   ${installResult.installedSkills.length} synced`));
    }
    if (installResult.hooksConfigured) {
      console.log(chalk.gray('  Hooks:    configured'));
    } else if (options.installerOptions.skipHooks) {
      console.log(chalk.gray('  Hooks:    skipped (--skip-hooks)'));
    }
    if (installResult.hookConflicts.length > 0) {
      console.log('');
      console.log(chalk.yellow('  Hook conflicts detected:'));
      installResult.hookConflicts.forEach(c => {
        console.log(chalk.yellow(`    - ${c.eventType}: ${c.existingCommand}`));
      });
    }

    const installed = getInstalledVersion();
    const reportedVersion = installed?.version ?? version;

    console.log('');
    console.log(chalk.gray(`Version: ${reportedVersion}`));
    if (reportedVersion !== version) {
      console.log(chalk.gray(`CLI package version: ${version}`));
    }
    console.log(chalk.gray('Start Claude Code and use /oh-my-claudecode:omc-setup for interactive setup.'));
  }

  // --check-state / state-machine phases already wrote their JSON line
  // via runSetup's stdout callback — nothing more to do here.
  void isStateOrCheck;

  return 0;
}

program
  .command('setup')
  .description('Run OMC setup — sync components, configure integrations, merge CLAUDE.md, or run the full wizard')
  // ---- existing 6 flags (unchanged) ----
  .option('-f, --force', 'Force reinstall even if already up to date')
  .option('-q, --quiet', 'Suppress output except for errors')
  .option('--no-plugin', 'Install bundled skills from the current package instead of relying on plugin-provided skills')
  .option('--plugin-dir-mode', 'Treat OMC as launched via --plugin-dir at runtime (skip agent/skill copy; HUD + hooks + CLAUDE.md still installed)')
  .option('--skip-hooks', 'Skip hook installation (deprecated — prints advisory on first use)')
  .option('--force-hooks', 'Force reinstall hooks even if unchanged')
  // ---- new flags: mode control ----
  .option('--preset <file>', 'Load preset JSON file (triggers multi-phase flow per preset contents)')
  .option('--wizard', 'Run the full wizard (all four phases)')
  .option('--interactive', 'Force interactive prompts (requires a TTY)')
  .option('--non-interactive', 'Disable interactive prompts (require flags/preset for all fields)')
  // ---- Phase 1: CLAUDE.md ----
  .option('--local', 'Phase 1 target: local project (.claude/CLAUDE.md)')
  .option('--global', 'Phase 1 target: global user config')
  .option('--preserve', 'Install style: preserve existing CLAUDE.md (requires --global)')
  .option('--overwrite', 'Install style: overwrite existing CLAUDE.md')
  // ---- Phase 2: configure ----
  .option('--execution-mode <mode>', 'Default execution mode: ultrawork | ralph | autopilot')
  .option('--task-tool <tool>', 'Task management tool: builtin | bd | br')
  .option('--install-cli', 'Install the oh-my-claude-sisyphus CLI globally')
  .option('--no-install-cli', 'Do not install the CLI globally')
  // ---- Phase 3: MCP ----
  .option('--configure-mcp', 'Enable MCP server configuration')
  .option('--no-mcp', 'Disable MCP server configuration')
  .option('--mcp-servers <list>', 'Comma-separated list of MCP servers to install')
  .option('--exa-key <key>', '(credential leak via argv) Exa API key')
  .option('--exa-key-file <path>', 'Path to file containing the Exa API key')
  .option('--github-token <token>', '(credential leak via argv) GitHub token')
  .option('--github-token-file <path>', 'Path to file containing the GitHub token')
  .option('--mcp-on-missing-creds <mode>', 'What to do if MCP credentials are missing: skip | error')
  .option('--mcp-scope <scope>', 'MCP scope: local | user | project')
  // ---- Phase 3: Teams ----
  .option('--enable-teams', 'Enable agent teams')
  .option('--no-teams', 'Disable agent teams')
  .option('--team-agents <n>', 'Number of team agents: 2 | 3 | 5')
  .option('--team-type <type>', 'Team agent type: executor | debugger | designer')
  .option('--teammate-display <mode>', 'Teammate display mode: auto | in-process | tmux')
  // ---- Phase 4 ----
  .option('--star-repo', 'Star the repo on GitHub after setup completes')
  .option('--no-star-repo', 'Do not star the repo')
  // ---- phase routing ----
  .option('--claude-md-only', 'Run only Phase 1 (CLAUDE.md merge)')
  .option('--mcp-only', 'Run only the MCP install sub-phase (used by mcp-setup skill)')
  // ---- state machine (bash shim forwarding) ----
  .option('--state-save <step>', 'State machine: save progress at step N')
  .option('--state-clear', 'State machine: clear saved progress')
  .option('--state-resume', 'State machine: print resume info as JSON')
  .option('--state-complete <version>', 'State machine: mark setup complete with version')
  .option('--state-config-type <type>', 'State machine: config type label for --state-save')
  // ---- read-only state inspection ----
  .option('--check-state', 'Read-only: print {alreadyConfigured, setupVersion, resumeStep} as JSON')
  // ---- internal: preset builder from skill answers ----
  .option('--build-preset', '(internal) Build a preset from a skill answers file (unstable)')
  .option('--answers <file>', '(internal) Path to the skill answers JSON (use with --build-preset)')
  .option('--out <file>', '(internal) Output path for the generated preset (use with --build-preset)')
  // ---- safe-defaults escape hatches ----
  .option('--infra-only', 'Escape hatch: restore pre-safe-defaults bare-setup behavior (phases=infra only, no plugin check)')
  .option('--dump-safe-defaults', 'Print the SAFE_DEFAULTS preset JSON to stdout and exit (copy + tweak as a preset file)')
  .addHelpText('after', `
Dispatch for bare \`omc setup\`:
  - TTY (real terminal)    → interactive wizard (11 questions, like /omc-setup)
  - non-TTY (pipe, CI)     → falls back to --non-interactive safe-defaults
  - --non-interactive      → explicit safe-defaults flow (works anywhere)
  - --interactive          → forces the wizard; errors clearly on non-TTY
  - --infra-only           → escape hatch: direct install(), no wizard, no safe-defaults
  - --preset <file>        → non-interactive from preset (unchanged)
  - --wizard               → preserved alias for the in-phase wizard flow

Examples:
  $ omc setup                          Interactive wizard on TTY; safe-defaults on non-TTY
  $ omc setup --non-interactive        Force SAFE_DEFAULTS (CLAUDE.md + infra + MCP + welcome)
  $ omc setup --interactive            Force interactive wizard (requires a TTY)
  $ omc setup --infra-only             Legacy bare behavior: sync components only (CI/automation escape)
  $ omc setup --force                  Force-rerun with current dispatch (wizard / safe-defaults)
  $ omc setup --dump-safe-defaults     Print safe-defaults preset JSON (pipe to a file, then tweak)
  $ omc setup --quiet                  Silent setup for scripts
  $ omc setup --wizard                 Run the legacy in-phase wizard (phase-router, not pre-phase prompts)
  $ omc setup --preset ./preset.json   Non-interactive: drive setup from a preset file
  $ omc setup --claude-md-only --global --overwrite
                                       Replaces scripts/setup-claude-md.sh direct calls
  $ omc setup --mcp-only --mcp-servers=context7,exa --exa-key-file ~/.exa
                                       MCP-only install (used by mcp-setup skill)
  $ omc setup --check-state            Print alreadyConfigured/resumeStep as JSON

Credential hygiene:
  --exa-key / --github-token expose secrets via process argv (visible in 'ps').
  Prefer --exa-key-file / --github-token-file, the EXA_API_KEY / GITHUB_TOKEN
  env vars, or a preset file with chmod 0600.`)
  .allowUnknownOption(false)
  .action(async function setupAction(this: Command) {
    // Commander has already parsed the outer argv; pull the parsed opts
    // directly to avoid double-parsing through parseFlagsToPartial().
    const opts = this.opts();
    const exitCode = await runSetupCommand(opts);
    if (exitCode !== 0) process.exit(exitCode);
  });

/**
 * Uninstall command — reverse of `omc setup`.
 *
 * Removes agents, skills, hooks, HUD bundle, OMC state files, and cleans up
 * CLAUDE.md and settings.json hook entries. User content outside the OMC
 * markers in CLAUDE.md is preserved by default (use --no-preserve to skip).
 *
 * Requires explicit confirmation unless --yes or --dry-run is supplied.
 * Exits with code 1 on non-interactive stdin without --yes (never acts
 * destructively without confirmation).
 */
program
  .command('uninstall')
  .description('Remove all OMC-installed files and configuration from the config directory')
  .option('--dry-run', 'List what would be removed without actually removing anything')
  .option('--no-preserve', 'Delete CLAUDE.md entirely instead of preserving user content')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('-q, --quiet', 'Suppress non-warning output')
  .addHelpText('after', `
Components removed:
  - Agents in <configDir>/agents/       (OMC-owned .md files only)
  - Skills in <configDir>/skills/       (OMC-owned skill dirs only)
  - Hooks in <configDir>/hooks/         (known OMC hook scripts)
  - HUD bundle in <configDir>/hud/      (if OMC-owned)
  - State files (.omc-*.json, CLAUDE-omc.md)
  - OMC block in CLAUDE.md              (user content preserved unless --no-preserve)
  - OMC hook entries in settings.json

Examples:
  $ omc uninstall --dry-run             Preview what would be removed
  $ omc uninstall -y                    Remove without prompting
  $ omc uninstall --no-preserve         Remove CLAUDE.md entirely (even if it has user content)
  $ omc uninstall -y --quiet            Silent removal for scripts`)
  .action(async function uninstallAction(this: Command) {
    const opts = this.opts() as {
      dryRun?: boolean;
      preserve?: boolean;
      yes?: boolean;
      quiet?: boolean;
    };

    const dryRun = opts.dryRun === true;
    // Commander --no-preserve sets opts.preserve = false
    const preserveUserContent = opts.preserve !== false;
    const skipConfirm = opts.yes === true || dryRun;
    const quiet = opts.quiet === true;

    const configDir = getClaudeConfigDir();

    const stderr = (line: string): void => { process.stderr.write(`${line}\n`); };
    const stdout = (line: string): void => {
      if (!quiet) process.stdout.write(`${line}\n`);
    };

    // ── Confirmation ──────────────────────────────────────────────────────────
    if (!skipConfirm) {
      const isTty = Boolean(process.stdin.isTTY);
      if (!isTty) {
        stderr('omc uninstall: non-interactive stdin detected. Pass --yes to proceed without a prompt.');
        process.exit(1);
      }

      // Dry-run preview: run the uninstaller with dryRun=true and a silent
      // logger to collect the EXACT list of files that would be touched.
      // This lets the confirmation prompt show resolved paths grouped by
      // kind instead of a vague "agents/skills/hooks..." component list.
      const preview = runUninstall({
        configDir,
        dryRun: true,
        preserveUserContent,
        logger: () => { /* silent — we render the preview ourselves */ },
      });

      // Bucket preview paths by kind for a readable confirmation screen.
      const buckets: {
        agents: string[];
        skills: string[];
        hooks: string[];
        hud: string[];
        stateFiles: string[];
        claudeMd: string[];
        settings: string[];
        other: string[];
      } = {
        agents: [],
        skills: [],
        hooks: [],
        hud: [],
        stateFiles: [],
        claudeMd: [],
        settings: [],
        other: [],
      };

      const agentsPrefix = `${configDir}/agents/`;
      const skillsPrefix = `${configDir}/skills/`;
      const hooksPrefix = `${configDir}/hooks/`;
      const hudPrefix = `${configDir}/hud`;
      const stateFileNames = new Set([
        '.omc-version.json',
        '.omc-silent-update.json',
        '.omc-update.log',
        '.omc-config.json',
        'CLAUDE-omc.md',
      ]);
      const claudeMdPath = `${configDir}/CLAUDE.md`;
      const settingsPath = `${configDir}/settings.json`;

      for (const p of preview.removed) {
        const rel = p.startsWith(`${configDir}/`) ? p.slice(configDir.length + 1) : p;
        const base = rel.split('/').pop() ?? rel;

        if (p.startsWith(agentsPrefix)) buckets.agents.push(p);
        else if (p.startsWith(skillsPrefix)) buckets.skills.push(p);
        else if (p.startsWith(hooksPrefix)) buckets.hooks.push(p);
        else if (p === hudPrefix || p.startsWith(`${hudPrefix}/`)) buckets.hud.push(p);
        else if (p === claudeMdPath) buckets.claudeMd.push(p);
        else if (p === settingsPath) buckets.settings.push(p);
        else if (stateFileNames.has(base) || base.startsWith('CLAUDE.md.backup.')) {
          buckets.stateFiles.push(p);
        } else {
          buckets.other.push(p);
        }
      }

      const totalRemoved = preview.removed.length;
      const totalPreserved = preview.preserved.length;

      const lines: string[] = [];
      lines.push(`omc uninstall will modify the following in:`);
      lines.push(`  ${configDir}`);
      lines.push('');
      lines.push(
        `Summary: ${totalRemoved} file(s)/dir(s) to remove, `
        + `${totalPreserved} file(s) to preserve user content.`,
      );
      lines.push('');

      const section = (title: string, items: string[]): void => {
        if (items.length === 0) return;
        lines.push(`${title} (${items.length}):`);
        for (const p of items) lines.push(`  - ${p}`);
        lines.push('');
      };

      section('Agents to remove', buckets.agents);
      section('Skills to remove', buckets.skills);
      section('Hooks to remove', buckets.hooks);
      section('HUD bundle to remove', buckets.hud);
      section('State files to remove', buckets.stateFiles);
      section('CLAUDE.md to delete', buckets.claudeMd);
      section('settings.json cleanup', buckets.settings);
      section('Other', buckets.other);

      if (totalPreserved > 0) {
        lines.push(`Files with user content to be preserved in place:`);
        for (const p of preview.preserved) lines.push(`  - ${p}`);
        lines.push('');
      }

      if (totalRemoved === 0 && totalPreserved === 0) {
        lines.push('Nothing to uninstall — config directory is already clean.');
        lines.push('');
        process.stdout.write(lines.join('\n'));
        process.exit(0);
      }

      lines.push(
        preserveUserContent
          ? 'CLAUDE.md user content outside OMC markers will be preserved.'
          : 'CLAUDE.md will be DELETED entirely (--no-preserve).',
      );
      lines.push('');
      lines.push('Continue? (y/N) ');

      process.stdout.write(lines.join('\n'));

      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      const answer = await new Promise<string>((resolve) => {
        rl.once('line', (line) => {
          rl.close();
          resolve(line.trim().toLowerCase());
        });
        rl.once('close', () => resolve(''));
      });

      if (answer !== 'y' && answer !== 'yes') {
        stdout('Uninstall cancelled.');
        process.exit(1);
      }
    }

    // ── Run uninstall ─────────────────────────────────────────────────────────
    try {
      const logger = quiet
        ? (msg: string): void => {
            // In quiet mode, still emit warnings to stderr
            if (msg.startsWith('[dry-run] Warning:') || msg.startsWith('Warning:')) {
              stderr(msg);
            }
          }
        : (msg: string): void => { stdout(msg); };

      const result = runUninstall({
        configDir,
        dryRun,
        preserveUserContent,
        logger,
      });

      if (dryRun) {
        stdout(`\n[dry-run] Would remove ${result.removed.length} item(s), preserve ${result.preserved.length}, skip ${result.skipped.length}.`);
      } else {
        stdout(`\nUninstall complete. Removed ${result.removed.length} item(s).`);
        if (result.preserved.length > 0) {
          stdout(`Preserved ${result.preserved.length} file(s) with user content.`);
        }
      }

      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          stderr(`Warning: ${w}`);
        }
      }

      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`omc uninstall: unexpected error: ${msg}`);
      process.exit(2);
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
      await runHudWatchLoop({ intervalMs, hudMain });
    } else {
      await hudMain();
    }
  });

program
  .command('mission-board')
  .description('Render the opt-in mission board snapshot for the current workspace')
  .option('--json', 'Print raw mission-board JSON')
  .action(async (options) => {
    const { refreshMissionBoardState, renderMissionBoard } = await import('../hud/mission-board.js');
    const state = refreshMissionBoardState(process.cwd());
    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    const lines = renderMissionBoard(state, {
      enabled: true,
      maxMissions: 5,
      maxAgentsPerMission: 8,
      maxTimelineEvents: 8,
      persistCompletedForMinutes: 20,
    });

    console.log(lines.length > 0 ? lines.join('\n') : '(no active missions)');
  });

/**
 * Team command - CLI API for team worker lifecycle operations
 * Exposes OMC's `omc team api` interface.
 *
 * helpOption(false) prevents commander from intercepting --help;
 * our teamCommand handler provides its own help output.
 */
program
  .command('team')
  .description('Team CLI API for worker lifecycle operations')
  .helpOption(false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument('[args...]', 'team subcommand arguments')
  .action(async (args: string[]) => {
    await teamCommand(args);
  });

/**
 * Autoresearch command - thin-supervisor autoresearch with keep/discard/reset parity
 */
program
  .command('autoresearch')
  .description('Launch thin-supervisor autoresearch with keep/discard/reset parity')
  .helpOption(false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument('[args...]', 'autoresearch subcommand arguments')
  .action(async (args: string[]) => {
    await autoresearchCommand(args);
  });

/**
 * Ralphthon command - Autonomous hackathon lifecycle
 *
 * Deep-interview generates PRD, ralph loop executes tasks,
 * auto-hardening phase, terminates after clean waves.
 */
program
  .command('ralphthon')
  .description('Autonomous hackathon lifecycle: interview -> execute -> harden -> done')
  .helpOption(false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument('[args...]', 'ralphthon arguments')
  .action(async (args: string[]) => {
    await ralphthonCommand(args);
  });

/**
 * Returns the fully-configured commander program.
 *
 * Exported so tests can drive the real CLI pipeline (e.g.
 * `await buildProgram().parseAsync(['node','omc','setup','--plugin-dir-mode'], { from: 'user' })`)
 * without spawning a subprocess. The program is built once at module load
 * (commander does not support re-registration), so this just returns the
 * singleton.
 */
export function buildProgram(): Command {
  return program;
}

// Parse arguments — skipped only when an importing test explicitly opts out
// via OMC_CLI_SKIP_PARSE. We do NOT key off process.env.VITEST because the
// CLI is also spawned as a child process from tests (e.g. cli-boot.test.ts),
// and child processes inherit VITEST from the parent vitest worker, which
// would cause the CLI to silently exit with no output.
if (!process.env.OMC_CLI_SKIP_PARSE) {
  program.parse();
}

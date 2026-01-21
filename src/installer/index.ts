/**
 * Installer Module
 *
 * Handles installation of OMC agents, commands, and configuration
 * into the Claude Code config directory (~/.claude/).
 *
 * This replicates the functionality of scripts/install.sh but in TypeScript,
 * allowing npm postinstall to work properly.
 *
 * Cross-platform support:
 * - Windows: Uses Node.js-based hook scripts (.mjs)
 * - Unix (macOS, Linux): Uses Bash scripts (.sh) by default
 *
 * Environment variables:
 * - OMC_USE_NODE_HOOKS=1: Force Node.js hooks on any platform
 * - OMC_USE_BASH_HOOKS=1: Force Bash hooks (Unix only)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';
import {
  HOOK_SCRIPTS,
  getHookScripts,
  getHooksSettingsConfig,
  isWindows,
  shouldUseNodeHooks,
  MIN_NODE_VERSION
} from './hooks.js';

/** Claude Code configuration directory */
export const CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
export const AGENTS_DIR = join(CLAUDE_CONFIG_DIR, 'agents');
export const COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const SKILLS_DIR = join(CLAUDE_CONFIG_DIR, 'skills');
export const HOOKS_DIR = join(CLAUDE_CONFIG_DIR, 'hooks');
export const HUD_DIR = join(CLAUDE_CONFIG_DIR, 'hud');
export const SETTINGS_FILE = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const VERSION_FILE = join(CLAUDE_CONFIG_DIR, '.omc-version.json');

/**
 * Core commands - DISABLED for v3.0+
 * All commands are now plugin-scoped skills managed by Claude Code.
 * The installer no longer copies commands to ~/.claude/commands/
 */
export const CORE_COMMANDS: string[] = [];

/** Current version */
export const VERSION = '3.1.0';

/** Installation result */
export interface InstallResult {
  success: boolean;
  message: string;
  installedAgents: string[];
  installedCommands: string[];
  installedSkills: string[];
  hooksConfigured: boolean;
  errors: string[];
}

/** Installation options */
export interface InstallOptions {
  force?: boolean;
  verbose?: boolean;
  skipClaudeCheck?: boolean;
}

/**
 * Check if the current Node.js version meets the minimum requirement
 */
export function checkNodeVersion(): { valid: boolean; current: number; required: number } {
  const current = parseInt(process.versions.node.split('.')[0], 10);
  return {
    valid: current >= MIN_NODE_VERSION,
    current,
    required: MIN_NODE_VERSION
  };
}

/**
 * Check if Claude Code is installed
 * Uses 'where' on Windows, 'which' on Unix
 */
export function isClaudeInstalled(): boolean {
  try {
    const command = isWindows() ? 'where claude' : 'which claude';
    execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we're running in Claude Code plugin context
 *
 * When installed as a plugin, we should NOT copy files to ~/.claude/
 * because the plugin system already handles file access via ${CLAUDE_PLUGIN_ROOT}.
 *
 * Detection method:
 * - Check if CLAUDE_PLUGIN_ROOT environment variable is set (primary method)
 * - This env var is set by the Claude Code plugin system when running plugin hooks
 *
 * @returns true if running in plugin context, false otherwise
 */
export function isRunningAsPlugin(): boolean {
  // Check for CLAUDE_PLUGIN_ROOT env var (set by plugin system)
  // This is the most reliable indicator that we're running as a plugin
  return !!process.env.CLAUDE_PLUGIN_ROOT;
}

/**
 * Get the package root directory
 * From dist/installer/index.js, go up to package root
 */
function getPackageDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // From dist/installer/index.js, go up to package root
  return join(__dirname, '..', '..');
}

/**
 * Load agent definitions from /agents/*.md files
 */
function loadAgentDefinitions(): Record<string, string> {
  const agentsDir = join(getPackageDir(), 'agents');
  const definitions: Record<string, string> = {};

  if (!existsSync(agentsDir)) {
    console.error(`FATAL: agents directory not found: ${agentsDir}`);
    process.exit(1);
  }

  for (const file of readdirSync(agentsDir)) {
    if (file.endsWith('.md')) {
      definitions[file] = readFileSync(join(agentsDir, file), 'utf-8');
    }
  }

  return definitions;
}

/**
 * Load command definitions from /commands/*.md files
 */
function loadCommandDefinitions(): Record<string, string> {
  const commandsDir = join(getPackageDir(), 'commands');
  const definitions: Record<string, string> = {};

  if (!existsSync(commandsDir)) {
    console.error(`FATAL: commands directory not found: ${commandsDir}`);
    process.exit(1);
  }

  for (const file of readdirSync(commandsDir)) {
    if (file.endsWith('.md')) {
      definitions[file] = readFileSync(join(commandsDir, file), 'utf-8');
    }
  }

  return definitions;
}

/**
 * Load CLAUDE.md content from /docs/CLAUDE.md
 */
function loadClaudeMdContent(): string {
  const claudeMdPath = join(getPackageDir(), 'docs', 'CLAUDE.md');

  if (!existsSync(claudeMdPath)) {
    console.error(`FATAL: CLAUDE.md not found: ${claudeMdPath}`);
    process.exit(1);
  }

  return readFileSync(claudeMdPath, 'utf-8');
}

/**
 * Install OMC agents, commands, skills, and hooks
 */
export function install(options: InstallOptions = {}): InstallResult {
  const result: InstallResult = {
    success: false,
    message: '',
    installedAgents: [],
    installedCommands: [],
    installedSkills: [],
    hooksConfigured: false,
    errors: []
  };

  const log = (msg: string) => {
    if (options.verbose) {
      console.log(msg);
    }
  };

  // Check Node.js version (required for Node.js hooks on Windows)
  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.valid) {
    log(`Warning: Node.js ${nodeCheck.required}+ required, found ${nodeCheck.current}`);
    if (isWindows()) {
      result.errors.push(`Node.js ${nodeCheck.required}+ is required for Windows support. Found: ${nodeCheck.current}`);
      result.message = `Installation failed: Node.js ${nodeCheck.required}+ required`;
      return result;
    }
    // On Unix, we can still use bash hooks, so just warn
  }

  // Log platform info
  log(`Platform: ${process.platform} (${shouldUseNodeHooks() ? 'Node.js hooks' : 'Bash hooks'})`);

  // Check if running as a plugin
  const runningAsPlugin = isRunningAsPlugin();
  if (runningAsPlugin) {
    log('Detected Claude Code plugin context - skipping agent/command file installation');
    log('Plugin files are managed by Claude Code plugin system');
    log('Will still install HUD statusline...');
    // Don't return early - continue to install HUD
  }

  // Check Claude installation (optional)
  if (!options.skipClaudeCheck && !isClaudeInstalled()) {
    log('Warning: Claude Code not found. Install it first:');
    if (isWindows()) {
      log('  Visit https://docs.anthropic.com/claude-code for Windows installation');
    } else {
      log('  curl -fsSL https://claude.ai/install.sh | bash');
    }
    // Continue anyway - user might be installing ahead of time
  }

  try {
    // Ensure base config directory exists
    if (!existsSync(CLAUDE_CONFIG_DIR)) {
      mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
    }

    // Skip agent/command/hook file installation when running as plugin
    // Plugin system handles these via ${CLAUDE_PLUGIN_ROOT}
    if (!runningAsPlugin) {
      // Create directories
      log('Creating directories...');
      if (!existsSync(AGENTS_DIR)) {
        mkdirSync(AGENTS_DIR, { recursive: true });
      }
      if (!existsSync(COMMANDS_DIR)) {
        mkdirSync(COMMANDS_DIR, { recursive: true });
      }
      if (!existsSync(SKILLS_DIR)) {
        mkdirSync(SKILLS_DIR, { recursive: true });
      }
      if (!existsSync(HOOKS_DIR)) {
        mkdirSync(HOOKS_DIR, { recursive: true });
      }

      // Install agents
      log('Installing agent definitions...');
      for (const [filename, content] of Object.entries(loadAgentDefinitions())) {
        const filepath = join(AGENTS_DIR, filename);
        if (existsSync(filepath) && !options.force) {
          log(`  Skipping ${filename} (already exists)`);
        } else {
          writeFileSync(filepath, content);
          result.installedAgents.push(filename);
          log(`  Installed ${filename}`);
        }
      }

      // Skip command installation - all commands are now plugin-scoped skills
      // Commands are accessible via the plugin system (${CLAUDE_PLUGIN_ROOT}/commands/)
      // and are managed by Claude Code's skill discovery mechanism.
      log('Skipping slash command installation (all commands are now plugin-scoped skills)');

      // The command installation loop is disabled - CORE_COMMANDS is empty
      for (const [filename, content] of Object.entries(loadCommandDefinitions())) {
        // All commands are skipped - they're managed by the plugin system
        if (!CORE_COMMANDS.includes(filename)) {
          log(`  Skipping ${filename} (plugin-scoped skill)`);
          continue;
        }

        const filepath = join(COMMANDS_DIR, filename);

        // Create command directory if needed (only for nested paths like 'ultrawork/skill.md')
        if (filename.includes('/')) {
          const commandDir = join(COMMANDS_DIR, filename.split('/')[0]);
          if (!existsSync(commandDir)) {
            mkdirSync(commandDir, { recursive: true });
          }
        }

        if (existsSync(filepath) && !options.force) {
          log(`  Skipping ${filename} (already exists)`);
        } else {
          writeFileSync(filepath, content);
          result.installedCommands.push(filename);
          log(`  Installed ${filename}`);
        }
      }

      // NOTE: SKILL_DEFINITIONS removed - skills now only installed via COMMAND_DEFINITIONS
      // to avoid duplicate entries in Claude Code's available skills list

      // Install CLAUDE.md (only if it doesn't exist)
      const claudeMdPath = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
      const homeMdPath = join(homedir(), 'CLAUDE.md');

      if (!existsSync(homeMdPath)) {
        if (!existsSync(claudeMdPath) || options.force) {
          writeFileSync(claudeMdPath, loadClaudeMdContent());
          log('Created CLAUDE.md');
        } else {
          log('CLAUDE.md already exists, skipping');
        }
      } else {
        log('CLAUDE.md exists in home directory, skipping');
      }

      // Install hook scripts (platform-aware)
      const hookScripts = getHookScripts();
      const hookType = shouldUseNodeHooks() ? 'Node.js' : 'Bash';
      log(`Installing ${hookType} hook scripts...`);

      for (const [filename, content] of Object.entries(hookScripts)) {
        const filepath = join(HOOKS_DIR, filename);
        if (existsSync(filepath) && !options.force) {
          log(`  Skipping ${filename} (already exists)`);
        } else {
          writeFileSync(filepath, content);
          // Make script executable (skip on Windows - not needed)
          if (!isWindows()) {
            chmodSync(filepath, 0o755);
          }
          log(`  Installed ${filename}`);
        }
      }

      // Configure settings.json for hooks (merge with existing settings)
      log('Configuring hooks in settings.json...');
      try {
        let existingSettings: Record<string, unknown> = {};
        if (existsSync(SETTINGS_FILE)) {
          const settingsContent = readFileSync(SETTINGS_FILE, 'utf-8');
          existingSettings = JSON.parse(settingsContent);
        }

        // Merge hooks configuration (platform-aware)
        const existingHooks = (existingSettings.hooks || {}) as Record<string, unknown>;
        const hooksConfig = getHooksSettingsConfig();
        const newHooks = hooksConfig.hooks;

        // Deep merge: add our hooks, or update if --force is used
        for (const [eventType, eventHooks] of Object.entries(newHooks)) {
          if (!existingHooks[eventType]) {
            existingHooks[eventType] = eventHooks;
            log(`  Added ${eventType} hook`);
          } else if (options.force) {
            existingHooks[eventType] = eventHooks;
            log(`  Updated ${eventType} hook (--force)`);
          } else {
            log(`  ${eventType} hook already configured, skipping`);
          }
        }

        existingSettings.hooks = existingHooks;

        // Write back settings
        writeFileSync(SETTINGS_FILE, JSON.stringify(existingSettings, null, 2));
        log('  Hooks configured in settings.json');
        result.hooksConfigured = true;
      } catch (_e) {
        log('  Warning: Could not configure hooks in settings.json (non-fatal)');
        result.hooksConfigured = false;
      }
    } else {
      log('Skipping agent/command/hook files (managed by plugin system)');
    }

    // Install HUD statusline (always, even in plugin mode)
    log('Installing HUD statusline...');
    try {
      if (!existsSync(HUD_DIR)) {
        mkdirSync(HUD_DIR, { recursive: true });
      }

      // Build the HUD script content (compiled from src/hud/index.ts)
      // Create a wrapper that checks multiple locations for the HUD module
      const hudScriptPath = join(HUD_DIR, 'omc-hud.mjs');
      const hudScriptLines = [
        '#!/usr/bin/env node',
        '/**',
        ' * OMC HUD - Statusline Script',
        ' * Wrapper that imports from dev paths, plugin cache, or npm package',
        ' */',
        '',
        'import { existsSync, readdirSync } from "node:fs";',
        'import { homedir } from "node:os";',
        'import { join } from "node:path";',
        '',
        'async function main() {',
        '  const home = homedir();',
        '  ',
        '  // 1. Development paths (preferred for local development)',
        '  const devPaths = [',
        '    join(home, "Workspace/oh-my-claudecode/dist/hud/index.js"),',
        '    join(home, "workspace/oh-my-claudecode/dist/hud/index.js"),',
        '    join(home, "projects/oh-my-claudecode/dist/hud/index.js"),',
        '  ];',
        '  ',
        '  for (const devPath of devPaths) {',
        '    if (existsSync(devPath)) {',
        '      try {',
        '        await import(devPath);',
        '        return;',
        '      } catch { /* continue */ }',
        '    }',
        '  }',
        '  ',
        '  // 2. Plugin cache (for production installs)',
        '  const pluginCacheBase = join(home, ".claude/plugins/cache/omc/oh-my-claudecode");',
        '  if (existsSync(pluginCacheBase)) {',
        '    try {',
        '      const versions = readdirSync(pluginCacheBase);',
        '      if (versions.length > 0) {',
        '        const latestVersion = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse()[0];',
        '        const pluginPath = join(pluginCacheBase, latestVersion, "dist/hud/index.js");',
        '        if (existsSync(pluginPath)) {',
        '          await import(pluginPath);',
        '          return;',
        '        }',
        '      }',
        '    } catch { /* continue */ }',
        '  }',
        '  ',
        '  // 3. npm package (global or local install)',
        '  try {',
        '    await import("oh-my-claude-sisyphus/dist/hud/index.js");',
        '    return;',
        '  } catch { /* continue */ }',
        '  ',
        '  // 4. Fallback: minimal HUD',
        '  console.log("[OMC] active");',
        '}',
        '',
        'main();',
      ];
      const hudScript = hudScriptLines.join('\n');

      writeFileSync(hudScriptPath, hudScript);
      if (!isWindows()) {
        chmodSync(hudScriptPath, 0o755);
      }
      log('  Installed omc-hud.mjs');

      // Configure statusLine in settings.json if not already set
      try {
        let existingSettings: Record<string, unknown> = {};
        if (existsSync(SETTINGS_FILE)) {
          const settingsContent = readFileSync(SETTINGS_FILE, 'utf-8');
          existingSettings = JSON.parse(settingsContent);
        }

        // Only add statusLine if not already configured
        if (!existingSettings.statusLine) {
          existingSettings.statusLine = {
            type: 'command',
            command: 'node ' + hudScriptPath
          };
          writeFileSync(SETTINGS_FILE, JSON.stringify(existingSettings, null, 2));
          log('  Configured statusLine in settings.json');
        } else {
          log('  statusLine already configured, skipping (use --force to override)');
          if (options.force) {
            existingSettings.statusLine = {
              type: 'command',
              command: 'node ' + hudScriptPath
            };
            writeFileSync(SETTINGS_FILE, JSON.stringify(existingSettings, null, 2));
            log('  Updated statusLine in settings.json (--force)');
          }
        }
      } catch {
        log('  Warning: Could not configure statusLine in settings.json');
      }
    } catch (_e) {
      log('  Warning: Could not install HUD statusline (non-fatal)');
    }

    // Save version metadata
    const versionMetadata = {
      version: VERSION,
      installedAt: new Date().toISOString(),
      installMethod: 'npm' as const,
      lastCheckAt: new Date().toISOString()
    };
    writeFileSync(VERSION_FILE, JSON.stringify(versionMetadata, null, 2));
    log('Saved version metadata');

    result.success = true;
    const hookCount = Object.keys(HOOK_SCRIPTS).length;
    result.message = `Successfully installed ${result.installedAgents.length} agents, ${result.installedCommands.length} commands, ${result.installedSkills.length} skills, and ${hookCount} hooks`;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    result.message = `Installation failed: ${errorMessage}`;
  }

  return result;
}

/**
 * Check if OMC is already installed
 */
export function isInstalled(): boolean {
  return existsSync(VERSION_FILE) && existsSync(AGENTS_DIR) && existsSync(COMMANDS_DIR);
}

/**
 * Get installation info
 */
export function getInstallInfo(): { version: string; installedAt: string; method: string } | null {
  if (!existsSync(VERSION_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(VERSION_FILE, 'utf-8');
    const data = JSON.parse(content);
    return {
      version: data.version,
      installedAt: data.installedAt,
      method: data.installMethod
    };
  } catch {
    return null;
  }
}

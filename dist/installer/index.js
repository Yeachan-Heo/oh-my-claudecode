/**
 * Installer Module
 *
 * Handles installation of OMC agents, commands, and configuration
 * into the Claude Code config directory (~/.claude/).
 *
 * Cross-platform support via Node.js-based hook scripts (.mjs).
 * Bash hook scripts were removed in v3.9.0.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getHookScripts, getHooksSettingsConfig, isWindows, MIN_NODE_VERSION } from './hooks.js';
import { getRuntimePackageVersion } from '../lib/version.js';
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
export const CORE_COMMANDS = [];
/** Current version */
export const VERSION = getRuntimePackageVersion();
/**
 * Find a marker that appears at the start of a line (line-anchored).
 * This prevents matching markers inside code blocks.
 * @param content - The content to search in
 * @param marker - The marker string to find
 * @param fromEnd - If true, finds the LAST occurrence instead of first
 * @returns The index of the marker, or -1 if not found
 */
function findLineAnchoredMarker(content, marker, fromEnd = false) {
    // Escape special regex characters in marker
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedMarker}$`, 'gm');
    if (fromEnd) {
        // Find the last occurrence
        let lastIndex = -1;
        let match;
        while ((match = regex.exec(content)) !== null) {
            lastIndex = match.index;
        }
        return lastIndex;
    }
    else {
        // Find the first occurrence
        const match = regex.exec(content);
        return match ? match.index : -1;
    }
}
/**
 * Detect whether a hook command belongs to oh-my-claudecode.
 *
 * Uses substring matching rather than word-boundary regex.
 * Rationale: Real OMC hooks use compound names where "omc" is embedded
 * (e.g., `omc-pre-tool-use.mjs`, `oh-my-claudecode-hook.mjs`). A word-boundary
 * regex like /\bomc\b/ would fail to match "oh-my-claudecode" since "omc" appears
 * as an interior substring. The theoretical false positives (words containing "omc"
 * like "atomic", "socom") are extremely unlikely in real hook command paths.
 *
 * @param command - The hook command string
 * @returns true if the command contains 'omc' or 'oh-my-claudecode'
 */
export function isOmcHook(command) {
    const lowerCommand = command.toLowerCase();
    // Match on path segments or word boundaries, not substrings
    // Matches: /omc/, /omc-, omc/, -omc, _omc, omc_
    const omcPattern = /(?:^|[\/\\_-])omc(?:$|[\/\\_-])/;
    const fullNamePattern = /oh-my-claudecode/;
    return omcPattern.test(lowerCommand) || fullNamePattern.test(lowerCommand);
}
/**
 * Check if the current Node.js version meets the minimum requirement
 */
export function checkNodeVersion() {
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
export function isClaudeInstalled() {
    try {
        const command = isWindows() ? 'where claude' : 'which claude';
        execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
        return true;
    }
    catch {
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
export function isRunningAsPlugin() {
    // Check for CLAUDE_PLUGIN_ROOT env var (set by plugin system)
    // This is the most reliable indicator that we're running as a plugin
    return !!process.env.CLAUDE_PLUGIN_ROOT;
}
/**
 * Check if we're running as a project-scoped plugin (not global)
 *
 * Project-scoped plugins are installed in the project's .claude/plugins/ directory,
 * while global plugins are installed in ~/.claude/plugins/.
 *
 * When project-scoped, we should NOT modify global settings (like ~/.claude/settings.json)
 * because the user explicitly chose project-level installation.
 *
 * @returns true if running as a project-scoped plugin, false otherwise
 */
export function isProjectScopedPlugin() {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) {
        return false;
    }
    // Global plugins are installed under ~/.claude/plugins/
    const globalPluginBase = join(homedir(), '.claude', 'plugins');
    // If the plugin root is NOT under the global plugin directory, it's project-scoped
    // Normalize paths for comparison (resolve symlinks, trailing slashes, etc.)
    const normalizedPluginRoot = pluginRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedGlobalBase = globalPluginBase.replace(/\\/g, '/').replace(/\/$/, '');
    return !normalizedPluginRoot.startsWith(normalizedGlobalBase);
}
/**
 * Get the package root directory
 * From dist/installer/index.js, go up to package root
 */
function getPackageDir() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // From dist/installer/index.js, go up to package root
    return join(__dirname, '..', '..');
}
/**
 * Load agent definitions from /agents/*.md files
 */
function loadAgentDefinitions() {
    const agentsDir = join(getPackageDir(), 'agents');
    const definitions = {};
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
function loadCommandDefinitions() {
    const commandsDir = join(getPackageDir(), 'commands');
    const definitions = {};
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
function loadClaudeMdContent() {
    const claudeMdPath = join(getPackageDir(), 'docs', 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
        console.error(`FATAL: CLAUDE.md not found: ${claudeMdPath}`);
        process.exit(1);
    }
    return readFileSync(claudeMdPath, 'utf-8');
}
/**
 * Merge OMC content into existing CLAUDE.md using markers
 * @param existingContent - Existing CLAUDE.md content (null if file doesn't exist)
 * @param omcContent - New OMC content to inject
 * @returns Merged content with markers
 */
export function mergeClaudeMd(existingContent, omcContent, version) {
    const START_MARKER = '<!-- OMC:START -->';
    const END_MARKER = '<!-- OMC:END -->';
    const USER_CUSTOMIZATIONS = '<!-- User customizations -->';
    // Idempotency guard: strip markers from omcContent if already present
    // This handles the case where docs/CLAUDE.md ships with markers
    let cleanOmcContent = omcContent;
    const omcStartIdx = findLineAnchoredMarker(omcContent, START_MARKER);
    const omcEndIdx = findLineAnchoredMarker(omcContent, END_MARKER, true);
    if (omcStartIdx !== -1 && omcEndIdx !== -1 && omcStartIdx < omcEndIdx) {
        // Extract content between markers, trimming any surrounding whitespace
        cleanOmcContent = omcContent
            .substring(omcStartIdx + START_MARKER.length, omcEndIdx)
            .trim();
    }
    // Strip any existing version marker from content and inject current version
    cleanOmcContent = cleanOmcContent.replace(/<!-- OMC:VERSION:[^\s]*? -->\n?/, '');
    const versionMarker = version ? `<!-- OMC:VERSION:${version} -->\n` : '';
    // Case 1: No existing content - wrap omcContent in markers
    if (!existingContent) {
        return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n`;
    }
    // Case 2: Existing content has both markers - replace content between markers
    // Use line-anchored search to avoid matching markers inside code blocks
    const startIndex = findLineAnchoredMarker(existingContent, START_MARKER);
    const endIndex = findLineAnchoredMarker(existingContent, END_MARKER, true);
    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        // Extract content before START_MARKER and after END_MARKER
        const beforeMarker = existingContent.substring(0, startIndex);
        const afterMarker = existingContent.substring(endIndex + END_MARKER.length);
        return `${beforeMarker}${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}${afterMarker}`;
    }
    // Case 3: Corrupted markers (START without END or vice versa)
    if (startIndex !== -1 || endIndex !== -1) {
        // Handle corrupted state - backup will be created by caller
        return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n<!-- User customizations (recovered from corrupted markers) -->\n${existingContent}`;
    }
    // Case 4: No markers - wrap omcContent in markers, preserve existing after user customizations header
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\n${existingContent}`;
}
/**
 * Install OMC agents, commands, skills, and hooks
 */
export function install(options = {}) {
    const result = {
        success: false,
        message: '',
        installedAgents: [],
        installedCommands: [],
        installedSkills: [],
        hooksConfigured: false,
        hookConflicts: [],
        errors: []
    };
    const log = (msg) => {
        if (options.verbose) {
            console.log(msg);
        }
    };
    // Check Node.js version (required for Node.js hooks)
    const nodeCheck = checkNodeVersion();
    if (!nodeCheck.valid) {
        result.errors.push(`Node.js ${nodeCheck.required}+ is required. Found: ${nodeCheck.current}`);
        result.message = `Installation failed: Node.js ${nodeCheck.required}+ required`;
        return result;
    }
    // Log platform info
    log(`Platform: ${process.platform} (Node.js hooks)`);
    // Check if running as a plugin
    const runningAsPlugin = isRunningAsPlugin();
    const projectScoped = isProjectScopedPlugin();
    const allowPluginHookRefresh = runningAsPlugin && options.refreshHooksInPlugin && !projectScoped;
    if (runningAsPlugin) {
        log('Detected Claude Code plugin context - skipping agent/command file installation');
        log('Plugin files are managed by Claude Code plugin system');
        if (projectScoped) {
            log('Detected project-scoped plugin - skipping global HUD/settings modifications');
        }
        else {
            log('Will still install HUD statusline...');
            if (allowPluginHookRefresh) {
                log('Will refresh global hooks/settings for plugin runtime reconciliation');
            }
        }
        // Don't return early - continue to install HUD (unless project-scoped)
    }
    // Check Claude installation (optional)
    if (!options.skipClaudeCheck && !isClaudeInstalled()) {
        log('Warning: Claude Code not found. Install it first:');
        if (isWindows()) {
            log('  Visit https://docs.anthropic.com/claude-code for Windows installation');
        }
        else {
            log('  curl -fsSL https://claude.ai/install.sh | bash');
        }
        // Continue anyway - user might be installing ahead of time
    }
    try {
        // Ensure base config directory exists (skip for project-scoped plugins)
        if (!projectScoped && !existsSync(CLAUDE_CONFIG_DIR)) {
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
                }
                else {
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
                // Handle both Unix (/) and Windows (\) path separators
                if (filename.includes('/') || filename.includes('\\')) {
                    const segments = filename.split(/[/\\]/);
                    const commandDir = join(COMMANDS_DIR, segments[0]);
                    if (!existsSync(commandDir)) {
                        mkdirSync(commandDir, { recursive: true });
                    }
                }
                if (existsSync(filepath) && !options.force) {
                    log(`  Skipping ${filename} (already exists)`);
                }
                else {
                    writeFileSync(filepath, content);
                    result.installedCommands.push(filename);
                    log(`  Installed ${filename}`);
                }
            }
            // NOTE: SKILL_DEFINITIONS removed - skills now only installed via COMMAND_DEFINITIONS
            // to avoid duplicate entries in Claude Code's available skills list
            // Install CLAUDE.md with merge support
            const claudeMdPath = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
            const homeMdPath = join(homedir(), 'CLAUDE.md');
            if (!existsSync(homeMdPath)) {
                const omcContent = loadClaudeMdContent();
                // Read existing content if it exists
                let existingContent = null;
                if (existsSync(claudeMdPath)) {
                    existingContent = readFileSync(claudeMdPath, 'utf-8');
                }
                // Always create backup before modification (if file exists)
                if (existingContent !== null) {
                    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]; // YYYY-MM-DDTHH-MM-SS
                    const backupPath = join(CLAUDE_CONFIG_DIR, `CLAUDE.md.backup.${timestamp}`);
                    writeFileSync(backupPath, existingContent);
                    log(`Backed up existing CLAUDE.md to ${backupPath}`);
                }
                // Merge OMC content with existing content
                const mergedContent = mergeClaudeMd(existingContent, omcContent, VERSION);
                writeFileSync(claudeMdPath, mergedContent);
                if (existingContent) {
                    log('Updated CLAUDE.md (merged with existing content)');
                }
                else {
                    log('Created CLAUDE.md');
                }
            }
            else {
                log('CLAUDE.md exists in home directory, skipping');
            }
            // Install hook scripts
            const hookScripts = getHookScripts();
            log('Installing hook scripts...');
            for (const [filename, content] of Object.entries(hookScripts)) {
                const filepath = join(HOOKS_DIR, filename);
                // Create subdirectory if needed (e.g., lib/)
                const dir = dirname(filepath);
                if (!existsSync(dir)) {
                    mkdirSync(dir, { recursive: true });
                }
                if (existsSync(filepath) && !options.force) {
                    log(`  Skipping ${filename} (already exists)`);
                }
                else {
                    writeFileSync(filepath, content);
                    // Make script executable (skip on Windows - not needed)
                    if (!isWindows()) {
                        chmodSync(filepath, 0o755);
                    }
                    log(`  Installed ${filename}`);
                }
            }
            // Note: hooks configuration is deferred to consolidated settings.json write below
            result.hooksConfigured = true; // Will be set properly after consolidated write
        }
        else if (allowPluginHookRefresh) {
            // Refresh hooks in plugin context when explicitly requested (global plugin only)
            log('Refreshing hook scripts for plugin reconciliation...');
            if (!existsSync(HOOKS_DIR)) {
                mkdirSync(HOOKS_DIR, { recursive: true });
            }
            const hookScripts = getHookScripts();
            for (const [filename, content] of Object.entries(hookScripts)) {
                const filepath = join(HOOKS_DIR, filename);
                const dir = dirname(filepath);
                if (!existsSync(dir)) {
                    mkdirSync(dir, { recursive: true });
                }
                writeFileSync(filepath, content);
                if (!isWindows()) {
                    chmodSync(filepath, 0o755);
                }
            }
            result.hooksConfigured = true;
        }
        else {
            log('Skipping agent/command/hook files (managed by plugin system)');
        }
        // Install HUD statusline (skip for project-scoped plugins to avoid affecting global settings)
        // Project-scoped plugins should not modify ~/.claude/settings.json
        let hudScriptPath = null;
        if (projectScoped) {
            log('Skipping HUD statusline (project-scoped plugin should not modify global settings)');
        }
        else {
            log('Installing HUD statusline...');
        }
        if (!projectScoped)
            try {
                if (!existsSync(HUD_DIR)) {
                    mkdirSync(HUD_DIR, { recursive: true });
                }
                // Build the HUD script content (compiled from src/hud/index.ts)
                // Create a wrapper that checks multiple locations for the HUD module
                hudScriptPath = join(HUD_DIR, 'omc-hud.mjs');
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
                    'import { pathToFileURL } from "node:url";',
                    '',
                    'async function main() {',
                    '  const home = homedir();',
                    '  let pluginCacheVersion = null;',
                    '  let pluginCacheDir = null;',
                    '  ',
                    '  // 1. Development paths (only when OMC_DEV=1)',
                    '  if (process.env.OMC_DEV === "1") {',
                    '    const devPaths = [',
                    '      join(home, "Workspace/oh-my-claudecode/dist/hud/index.js"),',
                    '      join(home, "workspace/oh-my-claudecode/dist/hud/index.js"),',
                    '      join(home, "projects/oh-my-claudecode/dist/hud/index.js"),',
                    '    ];',
                    '    ',
                    '    for (const devPath of devPaths) {',
                    '      if (existsSync(devPath)) {',
                    '        try {',
                    '          await import(pathToFileURL(devPath).href);',
                    '          return;',
                    '        } catch { /* continue */ }',
                    '      }',
                    '    }',
                    '  }',
                    '  ',
                    '  // 2. Plugin cache (for production installs)',
                    '  const pluginCacheBase = join(home, ".claude/plugins/cache/omc/oh-my-claudecode");',
                    '  if (existsSync(pluginCacheBase)) {',
                    '    try {',
                    '      const versions = readdirSync(pluginCacheBase);',
                    '      if (versions.length > 0) {',
                    '        // Filter to only versions with built dist/hud/index.js',
                    '        // This prevents picking an unbuilt new version after plugin update',
                    '        const builtVersions = versions.filter(version => {',
                    '          const pluginPath = join(pluginCacheBase, version, "dist/hud/index.js");',
                    '          return existsSync(pluginPath);',
                    '        });',
                    '        ',
                    '        if (builtVersions.length > 0) {',
                    '          const latestVersion = builtVersions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse()[0];',
                    '          pluginCacheVersion = latestVersion;',
                    '          pluginCacheDir = join(pluginCacheBase, latestVersion);',
                    '          const pluginPath = join(pluginCacheDir, "dist/hud/index.js");',
                    '          await import(pathToFileURL(pluginPath).href);',
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
                    '  // 4. Fallback: provide detailed error message with fix instructions',
                    '  if (pluginCacheDir && existsSync(pluginCacheDir)) {',
                    '    // Plugin exists but dist/ folder is missing - needs build',
                    '    const distDir = join(pluginCacheDir, "dist");',
                    '    if (!existsSync(distDir)) {',
                    '      console.log(`[OMC HUD] Plugin installed but not built. Run: cd "${pluginCacheDir}" && npm install && npm run build`);',
                    '    } else {',
                    '      console.log(`[OMC HUD] Plugin dist/ exists but HUD not found. Run: cd "${pluginCacheDir}" && npm run build`);',
                    '    }',
                    '  } else if (existsSync(pluginCacheBase)) {',
                    '    // Plugin cache directory exists but no versions',
                    '    console.log(`[OMC HUD] Plugin cache found but no versions installed. Run: /oh-my-claudecode:omc-setup`);',
                    '  } else {',
                    '    // No plugin installation found at all',
                    '    console.log("[OMC HUD] Plugin not installed. Run: /oh-my-claudecode:omc-setup");',
                    '  }',
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
            }
            catch (_e) {
                log('  Warning: Could not install HUD statusline script (non-fatal)');
                hudScriptPath = null;
            }
        // Consolidated settings.json write (atomic: read once, modify, write once)
        // Skip for project-scoped plugins to avoid affecting global settings
        if (projectScoped) {
            log('Skipping settings.json configuration (project-scoped plugin)');
        }
        else {
            log('Configuring settings.json...');
        }
        if (!projectScoped)
            try {
                let existingSettings = {};
                if (existsSync(SETTINGS_FILE)) {
                    const settingsContent = readFileSync(SETTINGS_FILE, 'utf-8');
                    existingSettings = JSON.parse(settingsContent);
                }
                // 1. Configure hooks (only if not running as plugin unless refresh requested)
                if (!runningAsPlugin || allowPluginHookRefresh) {
                    const existingHooks = (existingSettings.hooks || {});
                    const hooksConfig = getHooksSettingsConfig();
                    const newHooks = hooksConfig.hooks;
                    // Deep merge: add our hooks, check for conflicts, or update if --force/--forceHooks is used
                    for (const [eventType, eventHooks] of Object.entries(newHooks)) {
                        if (!existingHooks[eventType]) {
                            existingHooks[eventType] = eventHooks;
                            log(`  Added ${eventType} hook`);
                        }
                        else {
                            // Check if existing hook is owned by another plugin
                            const existingEventHooks = existingHooks[eventType];
                            let hasNonOmcHook = false;
                            let nonOmcCommand = '';
                            for (const hookGroup of existingEventHooks) {
                                for (const hook of hookGroup.hooks) {
                                    if (hook.type === 'command' && !isOmcHook(hook.command)) {
                                        hasNonOmcHook = true;
                                        nonOmcCommand = hook.command;
                                        break;
                                    }
                                }
                                if (hasNonOmcHook)
                                    break;
                            }
                            const canOverrideNonOmc = options.forceHooks && !allowPluginHookRefresh;
                            if (hasNonOmcHook && !canOverrideNonOmc) {
                                // Conflict detected - don't overwrite
                                log(`  [OMC] Warning: ${eventType} hook owned by another plugin. Skipping. Use --force-hooks to override.`);
                                result.hookConflicts.push({ eventType, existingCommand: nonOmcCommand });
                            }
                            else if (options.force || options.forceHooks) {
                                existingHooks[eventType] = eventHooks;
                                log(`  Updated ${eventType} hook (${options.forceHooks ? '--force-hooks' : '--force'})`);
                            }
                            else {
                                log(`  ${eventType} hook already configured, skipping`);
                            }
                        }
                    }
                    existingSettings.hooks = existingHooks;
                    log('  Hooks configured');
                    result.hooksConfigured = true;
                }
                // 2. Configure statusLine (always, even in plugin mode)
                if (hudScriptPath) {
                    if (!existingSettings.statusLine) {
                        existingSettings.statusLine = {
                            type: 'command',
                            command: 'node ' + hudScriptPath
                        };
                        log('  Configured statusLine');
                    }
                    else if (options.force) {
                        existingSettings.statusLine = {
                            type: 'command',
                            command: 'node ' + hudScriptPath
                        };
                        log('  Updated statusLine (--force)');
                    }
                    else {
                        log('  statusLine already configured, skipping (use --force to override)');
                    }
                }
                // 3. Single atomic write
                writeFileSync(SETTINGS_FILE, JSON.stringify(existingSettings, null, 2));
                log('  settings.json updated');
            }
            catch (_e) {
                log('  Warning: Could not configure settings.json (non-fatal)');
                result.hooksConfigured = false;
            }
        // Save version metadata (skip for project-scoped plugins)
        if (!projectScoped) {
            const versionMetadata = {
                version: VERSION,
                installedAt: new Date().toISOString(),
                installMethod: 'npm',
                lastCheckAt: new Date().toISOString()
            };
            writeFileSync(VERSION_FILE, JSON.stringify(versionMetadata, null, 2));
            log('Saved version metadata');
        }
        else {
            log('Skipping version metadata (project-scoped plugin)');
        }
        result.success = true;
        const hookCount = Object.keys(getHookScripts()).length;
        result.message = `Successfully installed ${result.installedAgents.length} agents, ${result.installedCommands.length} commands, ${result.installedSkills.length} skills, and ${hookCount} hooks`;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push(errorMessage);
        result.message = `Installation failed: ${errorMessage}`;
    }
    return result;
}
/**
 * Check if OMC is already installed
 */
export function isInstalled() {
    return existsSync(VERSION_FILE) && existsSync(AGENTS_DIR) && existsSync(COMMANDS_DIR);
}
/**
 * Get installation info
 */
export function getInstallInfo() {
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
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=index.js.map
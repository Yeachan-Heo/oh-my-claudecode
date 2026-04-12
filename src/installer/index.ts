/**
 * Installer Module
 *
 * Handles installation of OMC agents, commands, and configuration
 * into the Claude Code config directory (~/.claude/).
 *
 * Cross-platform support via Node.js-based hook scripts (.mjs).
 * Bash hook scripts were removed in v3.9.0.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, readdirSync, cpSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';
import {
  isWindows,
  MIN_NODE_VERSION,
  getHooksSettingsConfig,
} from './hooks.js';
import { getRuntimePackageVersion } from '../lib/version.js';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { resolveNodeBinary } from '../utils/resolve-node.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { isSkininthegamebrosUser } from '../utils/skininthegamebros-user.js';
import { syncUnifiedMcpRegistryTargets } from './mcp-registry.js';
import { OMC_CONFIG_FILE_REL } from '../lib/paths.js';
import { buildHudWrapper } from '../lib/hud-wrapper-template.js';

/** Claude Code configuration directory */
export const CLAUDE_CONFIG_DIR = getClaudeConfigDir();
export const AGENTS_DIR = join(CLAUDE_CONFIG_DIR, 'agents');
export const COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const SKILLS_DIR = join(CLAUDE_CONFIG_DIR, 'skills');
export const HOOKS_DIR = join(CLAUDE_CONFIG_DIR, 'hooks');
export const HUD_DIR = join(CLAUDE_CONFIG_DIR, 'hud');
export const SETTINGS_FILE = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const VERSION_FILE = join(CLAUDE_CONFIG_DIR, '.omc-version.json');
const OMC_MANAGED_SKILL_MARKER = '.omc-managed';

/**
 * Core commands - DISABLED for v3.0+
 * All commands are now plugin-scoped skills managed by Claude Code.
 * The installer no longer copies commands to ~/.claude/commands/
 */
export const CORE_COMMANDS: string[] = [];

/** Current version */
export const VERSION = getRuntimePackageVersion();

const OMC_VERSION_MARKER_PATTERN = /<!-- OMC:VERSION:([^\s]+) -->/;

const CC_NATIVE_COMMANDS = new Set([
  'review',
  'plan',
  'security-review',
  'init',
  'doctor',
  'help',
  'config',
  'clear',
  'compact',
  'memory',
]);

const SKININTHEGAMEBROS_ONLY_SKILLS = new Set([
  'remember',
  'verify',
  'debug',
  'skillify',
]);

/**
 * Detects the newest installed OMC version from persistent metadata or
 * existing CLAUDE.md markers so an older CLI package cannot overwrite a
 * newer installation during `omc setup`.
 */
function isComparableVersion(version: string | null | undefined): version is string {
  return !!version && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version);
}

function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, '').split('.').map(part => parseInt(part, 10) || 0);
  const partsB = b.replace(/^v/, '').split('.').map(part => parseInt(part, 10) || 0);
  const maxLength = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLength; i++) {
    const valueA = partsA[i] || 0;
    const valueB = partsB[i] || 0;
    if (valueA < valueB) return -1;
    if (valueA > valueB) return 1;
  }

  return 0;
}

function extractOmcVersionMarker(content: string): string | null {
  const match = content.match(OMC_VERSION_MARKER_PATTERN);
  return match?.[1] ?? null;
}

function getNewestInstalledVersionHint(): string | null {
  const candidates: string[] = [];

  if (existsSync(VERSION_FILE)) {
    try {
      const metadata = JSON.parse(readFileSync(VERSION_FILE, 'utf-8')) as { version?: string };
      if (isComparableVersion(metadata.version)) {
        candidates.push(metadata.version);
      }
    } catch {
      // Ignore unreadable metadata and fall back to CLAUDE.md markers.
    }
  }

  const claudeCandidates = [
    join(CLAUDE_CONFIG_DIR, 'CLAUDE.md'),
    join(homedir(), 'CLAUDE.md'),
  ];

  for (const candidatePath of claudeCandidates) {
    if (!existsSync(candidatePath)) continue;
    try {
      const detectedVersion = extractOmcVersionMarker(readFileSync(candidatePath, 'utf-8'));
      if (isComparableVersion(detectedVersion)) {
        candidates.push(detectedVersion);
      }
    } catch {
      // Ignore unreadable CLAUDE.md candidates.
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((highest, candidate) =>
    compareVersions(candidate, highest) > 0 ? candidate : highest
  );
}

/**
 * Find a marker that appears at the start of a line (line-anchored).
 * This prevents matching markers inside code blocks.
 * @param content - The content to search in
 * @param marker - The marker string to find
 * @param fromEnd - If true, finds the LAST occurrence instead of first
 * @returns The index of the marker, or -1 if not found
 */
function findLineAnchoredMarker(content: string, marker: string, fromEnd: boolean = false): number {
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
  } else {
    // Find the first occurrence
    const match = regex.exec(content);
    return match ? match.index : -1;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isDefaultClaudeConfigDirPath(configDir: string): boolean {
  return normalizePath(configDir) === normalizePath(join(homedir(), '.claude'));
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildStatusLineCommand(nodeBin: string, hudScriptPath: string, findNodePath?: string): string {
  if (isWindows()) {
    return `${quoteShellArg(nodeBin)} ${quoteShellArg(hudScriptPath)}`;
  }

  if (isDefaultClaudeConfigDirPath(CLAUDE_CONFIG_DIR)) {
    if (findNodePath) {
      return 'sh ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/find-node.sh ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/omc-hud.mjs';
    }

    return 'node ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/omc-hud.mjs';
  }

  const normalizedHudScriptPath = hudScriptPath.replace(/\\/g, '/');
  if (findNodePath) {
    return `sh ${quoteShellArg(findNodePath.replace(/\\/g, '/'))} ${quoteShellArg(normalizedHudScriptPath)}`;
  }

  return `node ${quoteShellArg(normalizedHudScriptPath)}`;
}

function createLineAnchoredMarkerRegex(marker: string, flags: string = 'gm'): RegExp {
  return new RegExp(`^${escapeRegex(marker)}$`, flags);
}

function stripGeneratedUserCustomizationHeaders(content: string): string {
  return content.replace(
    /^<!-- User customizations(?: \([^)]+\))? -->\r?\n?/gm,
    ''
  );
}

function trimClaudeUserContent(content: string): string {
  if (content.trim().length === 0) {
    return '';
  }

  return content
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '')
    .replace(/(?:\r?\n){3,}/g, '\n\n');
}

/** Installation result */
export interface InstallResult {
  success: boolean;
  message: string;
  installedAgents: string[];
  installedCommands: string[];
  installedSkills: string[];
  hooksConfigured: boolean;
  hookConflicts: Array<{ eventType: string; existingCommand: string }>;
  errors: string[];
}

/** Installation options */
export interface InstallOptions {
  force?: boolean;
  version?: string;
  verbose?: boolean;
  skipClaudeCheck?: boolean;
  forceHooks?: boolean;
  refreshHooksInPlugin?: boolean;
  skipHud?: boolean;
  noPlugin?: boolean;
  /**
   * Dev plugin-dir mode: skip copying agents and bundled skills into
   * `<configDir>` because the user is launching OMC via
   * `claude --plugin-dir <path>` (or `omc --plugin-dir <path>`) and the
   * plugin already provides them at runtime. HUD, hooks, CLAUDE.md, and
   * `.omc-config.json` are still installed. Mutually exclusive with
   * `noPlugin` (the CLI gives `noPlugin` precedence).
   */
  pluginDirMode?: boolean;
}

/**
 * Read hudEnabled from .omc-config.json without importing auto-update
 * (avoids circular dependency since auto-update imports from installer)
 */
export function isHudEnabledInConfig(): boolean {
  const configPath = join(CLAUDE_CONFIG_DIR, OMC_CONFIG_FILE_REL);
  if (!existsSync(configPath)) {
    return true; // default: enabled
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    // Only disable if explicitly set to false
    return config.hudEnabled !== false;
  } catch {
    return true; // default: enabled on parse error
  }
}

/**
 * Detect whether a statusLine config belongs to oh-my-claudecode.
 *
 * Checks the command string for known OMC HUD paths so that custom
 * (non-OMC) statusLine configurations are preserved during forced
 * updates/reconciliation.
 *
 * @param statusLine - The statusLine setting object from settings.json
 * @returns true if the statusLine was set by OMC
 */
export function isOmcStatusLine(statusLine: unknown): boolean {
  if (!statusLine) return false;
  // Legacy string format (pre-v4.5): "~/.claude/hud/omc-hud.mjs"
  if (typeof statusLine === 'string') {
    return statusLine.includes('omc-hud');
  }
  // Current object format: { type: "command", command: "node ...omc-hud.mjs" }
  if (typeof statusLine === 'object') {
    const sl = statusLine as Record<string, unknown>;
    if (typeof sl.command === 'string') {
      return sl.command.includes('omc-hud');
    }
  }
  return false;
}

/**
 * Known OMC hook script filenames installed into .claude/hooks/.
 * Must be kept in sync with HOOKS_SETTINGS_CONFIG_NODE command entries.
 */
const OMC_HOOK_FILENAMES = new Set([
  'keyword-detector.mjs',
  'session-start.mjs',
  'pre-tool-use.mjs',
  'post-tool-use.mjs',
  'post-tool-use-failure.mjs',
  'persistent-mode.mjs',
  'code-simplifier.mjs',
  'stop-continuation.mjs',
]);

/**
 * Detect whether a hook command belongs to oh-my-claudecode.
 *
 * Recognition strategy (any match is sufficient):
 * 1. Command path contains "omc" as a path/word segment (e.g. `omc-hook.mjs`, `/omc/`)
 * 2. Command path contains "oh-my-claudecode"
 * 3. Command references a known OMC hook filename inside .claude/hooks/
 *
 * @param command - The hook command string
 * @returns true if the command belongs to OMC
 */
export function isOmcHook(command: string): boolean {
  const lowerCommand = command.toLowerCase();
  // Match "omc" as a path segment or word boundary
  // Matches: /omc/, /omc-, omc/, -omc, _omc, omc_
  const omcPattern = /(?:^|[\/\\_-])omc(?:$|[\/\\_-])/;
  const fullNamePattern = /oh-my-claudecode/;
  if (omcPattern.test(lowerCommand) || fullNamePattern.test(lowerCommand)) {
    return true;
  }
  // Check for known OMC hook filenames in .claude/hooks/ path.
  // Handles both Unix (.claude/hooks/) and Windows (.claude\hooks\) paths.
  const containsHooksDir = /hooks[/\\]/.test(lowerCommand);
  const hookFilenameMatch = lowerCommand.match(/([a-z0-9-]+\.mjs)(?:$|["'\s])/);
  if (containsHooksDir && hookFilenameMatch && OMC_HOOK_FILENAMES.has(hookFilenameMatch[1])) {
    return true;
  }
  return false;
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
export function isProjectScopedPlugin(): boolean {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    return false;
  }

  // Global plugins are installed under ~/.claude/plugins/
  const globalPluginBase = join(CLAUDE_CONFIG_DIR, 'plugins');

  // If the plugin root is NOT under the global plugin directory, it's project-scoped
  // Normalize paths for comparison (resolve symlinks, trailing slashes, etc.)
  const normalizedPluginRoot = pluginRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedGlobalBase = globalPluginBase.replace(/\\/g, '/').replace(/\/$/, '');

  return !normalizedPluginRoot.startsWith(normalizedGlobalBase);
}

type HookEntry = { type: string; command: string };
type HookGroup = { hooks: HookEntry[] };

const STANDALONE_HOOK_TEMPLATE_FILES = [
  'keyword-detector.mjs',
  'session-start.mjs',
  'pre-tool-use.mjs',
  'post-tool-use.mjs',
  'post-tool-use-failure.mjs',
  'persistent-mode.mjs',
  'code-simplifier.mjs',
] as const;

function ensureStandaloneHookScripts(log: (msg: string) => void): void {
  const packageDir = getPackageDir();
  const templatesDir = join(packageDir, 'templates', 'hooks');
  const templatesLibDir = join(templatesDir, 'lib');
  const hooksLibDir = join(HOOKS_DIR, 'lib');

  if (!existsSync(HOOKS_DIR)) {
    mkdirSync(HOOKS_DIR, { recursive: true });
  }
  if (!existsSync(hooksLibDir)) {
    mkdirSync(hooksLibDir, { recursive: true });
  }

  for (const filename of STANDALONE_HOOK_TEMPLATE_FILES) {
    const sourcePath = join(templatesDir, filename);
    const targetPath = join(HOOKS_DIR, filename);
    copyFileSync(sourcePath, targetPath);
    if (!isWindows()) {
      chmodSync(targetPath, 0o755);
    }
  }

  for (const filename of readdirSync(templatesLibDir)) {
    if (filename === 'config-dir.mjs') continue; // sourced from scripts/lib/ below
    const sourcePath = join(templatesLibDir, filename);
    const targetPath = join(hooksLibDir, filename);
    copyFileSync(sourcePath, targetPath);
    if (!isWindows()) {
      chmodSync(targetPath, 0o755);
    }
  }

  // config-dir.mjs: canonical source is scripts/lib/, not templates (avoids duplication)
  const configDirHelperMjs = join(packageDir, 'scripts', 'lib', 'config-dir.mjs');
  const configDirHelperMjsDest = join(hooksLibDir, 'config-dir.mjs');
  copyFileSync(configDirHelperMjs, configDirHelperMjsDest);
  if (!isWindows()) {
    chmodSync(configDirHelperMjsDest, 0o755);
  }

  if (!isWindows()) {
    const findNodeSrc = join(packageDir, 'scripts', 'find-node.sh');
    const findNodeDest = join(HOOKS_DIR, 'find-node.sh');
    const configDirHelperSrc = join(packageDir, 'scripts', 'lib', 'config-dir.sh');
    const configDirHelperDest = join(hooksLibDir, 'config-dir.sh');
    copyFileSync(findNodeSrc, findNodeDest);
    copyFileSync(configDirHelperSrc, configDirHelperDest);
    chmodSync(findNodeDest, 0o755);
    chmodSync(configDirHelperDest, 0o755);
  }

  log('  Installed standalone hook scripts');
}

function mergeHookGroups(
  eventType: string,
  existingGroups: HookGroup[],
  newOmcGroups: HookGroup[],
  options: { force?: boolean; forceHooks?: boolean; allowPluginHookRefresh?: boolean },
  log: (msg: string) => void,
  result: InstallResult,
): HookGroup[] {
  const nonOmcGroups = existingGroups.filter(group =>
    group.hooks.some(h => h.type === 'command' && !isOmcHook(h.command))
  );
  const hasNonOmcHook = nonOmcGroups.length > 0;
  const nonOmcCommand = hasNonOmcHook
    ? nonOmcGroups[0].hooks.find(h => h.type === 'command' && !isOmcHook(h.command))?.command ?? ''
    : '';

  if (options.forceHooks && !options.allowPluginHookRefresh) {
    if (hasNonOmcHook) {
      log(`  Warning: Overwriting non-OMC ${eventType} hook with --force-hooks: ${nonOmcCommand}`);
      result.hookConflicts.push({ eventType, existingCommand: nonOmcCommand });
    }
    log(`  Updated ${eventType} hook (--force-hooks)`);
    return newOmcGroups;
  }

  if (options.force) {
    if (hasNonOmcHook) {
      log(`  Merged ${eventType} hooks (updated OMC hooks, preserved non-OMC hook: ${nonOmcCommand})`);
      result.hookConflicts.push({ eventType, existingCommand: nonOmcCommand });
    } else {
      log(`  Updated ${eventType} hook (--force)`);
    }
    return [...nonOmcGroups, ...newOmcGroups];
  }

  if (hasNonOmcHook) {
    log(`  Warning: ${eventType} hook has non-OMC hook. Skipping. Use --force-hooks to override.`);
    result.hookConflicts.push({ eventType, existingCommand: nonOmcCommand });
  } else {
    log(`  ${eventType} hook already configured, skipping`);
  }
  return existingGroups;
}

/**
 * Remove stale OMC-created agent files from the config agents directory.
 *
 * When OMC drops an agent definition in a new version, the old .md file
 * lingers in ~/.claude/agents/. This function compares the installed files
 * against the current package's agent definitions and removes any that:
 *   1. Are .md files (OMC agent naming convention)
 *   2. Were previously shipped by OMC (match the frontmatter `name:` pattern)
 *   3. No longer exist in the current package's agents/ directory
 *
 * User-created files (those whose filename does not match any historically
 * known OMC agent) are preserved.
 */
export function cleanupStaleAgents(log: (msg: string) => void): string[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const currentAgentFiles = new Set(
    Object.keys(loadAgentDefinitions()),
  );

  const removed: string[] = [];
  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.endsWith('.md')) continue;
    if (file === 'AGENTS.md') continue;
    if (currentAgentFiles.has(file)) continue;

    // Check if this looks like an OMC-created agent (kebab-case .md with frontmatter)
    const filepath = join(AGENTS_DIR, file);
    try {
      const content = readFileSync(filepath, 'utf-8');
      if (content.startsWith('---\n') && /^name:\s+\S+/m.test(content)) {
        unlinkSync(filepath);
        removed.push(file);
        log(`  Removed stale agent: ${file}`);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return removed;
}

/**
 * Remove standalone agent files that duplicate plugin-provided agents (#2252).
 *
 * When the plugin is the canonical agent source, standalone copies in
 * ~/.claude/agents/ from a prior `omc setup` cause agent definitions to
 * appear twice. Removes standalone copies with OMC frontmatter whose
 * filename matches a current package agent.
 */
export function prunePluginDuplicateAgents(log: (msg: string) => void): string[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const currentAgentFiles = new Set(
    Object.keys(loadAgentDefinitions()),
  );

  const removed: string[] = [];
  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.endsWith('.md')) continue;
    if (file === 'AGENTS.md') continue;
    // Only prune agents whose name matches a current package agent
    if (!currentAgentFiles.has(file)) continue;

    const filepath = join(AGENTS_DIR, file);
    try {
      const content = readFileSync(filepath, 'utf-8');
      if (content.startsWith('---\n') && /^name:\s+\S+/m.test(content)) {
        unlinkSync(filepath);
        removed.push(file);
        log(`  Pruned plugin-duplicate agent: ${file}`);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return removed;
}

/**
 * Remove stale OMC-created skill directories from the config skills directory.
 *
 * Similar to cleanupStaleAgents but for skill directories. Removes directories
 * that contain a SKILL.md with OMC frontmatter but are no longer shipped by
 * the current package version. User-created skills are preserved.
 */
export function cleanupStaleSkills(log: (msg: string) => void): string[] {
  if (!existsSync(SKILLS_DIR)) return [];

  const packageSkillsDir = join(getPackageDir(), 'skills');
  const currentSkillNames = new Set<string>();

  if (existsSync(packageSkillsDir)) {
    for (const entry of readdirSync(packageSkillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        currentSkillNames.add(entry.name);
        // Also add the safe standalone name variant
        const skillMdPath = join(packageSkillsDir, entry.name, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          const content = readFileSync(skillMdPath, 'utf-8');
          const { metadata } = parseFrontmatter(content);
          if (typeof metadata.name === 'string' && metadata.name.trim().length > 0) {
            currentSkillNames.add(toSafeStandaloneSkillName(metadata.name));
          }
        }
      }
    }
  }

  const removed: string[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (currentSkillNames.has(entry.name)) continue;
    if (entry.name === 'omc-learned') continue;

    const skillDir = join(SKILLS_DIR, entry.name);
    const skillMdPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    if (!isOmcManagedSkillDir(skillDir)) continue;

    try {
      rmSync(skillDir, { recursive: true, force: true });
      removed.push(entry.name);
      log(`  Removed stale skill: ${entry.name}/`);
    } catch {
      // Skip directories that can't be removed
    }
  }

  return removed;
}

/**
 * Remove standalone skill directories that duplicate plugin-provided skills.
 *
 * When the plugin is the canonical skill source, standalone copies in
 * ~/.claude/skills/ from a prior `omc setup` cause every command to appear
 * twice (#2252). This function removes standalone copies whose SKILL.md
 * content-hashes match any installed plugin version, preserving user-authored
 * skills that happen to share a name.
 */
export function prunePluginDuplicateSkills(log: (msg: string) => void): string[] {
  if (!existsSync(SKILLS_DIR)) return [];

  const packageSkillsDir = join(getPackageDir(), 'skills');
  if (!existsSync(packageSkillsDir)) return [];

  // Build set of plugin-provided skill names (both dir name and safe standalone name)
  const pluginSkillNames = new Set<string>();
  // Build map of skill name → content hash from the package for safety comparison
  const pluginSkillHashes = new Map<string, string>();

  for (const entry of readdirSync(packageSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    pluginSkillNames.add(entry.name);

    const skillMdPath = join(packageSkillsDir, entry.name, 'SKILL.md');
    if (existsSync(skillMdPath)) {
      const content = readFileSync(skillMdPath, 'utf-8');
      const { metadata } = parseFrontmatter(content);
      if (typeof metadata.name === 'string' && metadata.name.trim().length > 0) {
        pluginSkillNames.add(toSafeStandaloneSkillName(metadata.name));
      }
      // Store a simple content hash for safety comparison
      pluginSkillHashes.set(entry.name, content.trim());
    }
  }

  const removed: string[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'omc-learned' || entry.name === '.omc-trash') continue;

    // Only prune skills whose name matches a plugin-provided skill
    if (!pluginSkillNames.has(entry.name)) continue;

    const skillMdPath = join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    try {
      const standaloneContent = readFileSync(skillMdPath, 'utf-8').trim();

      // Safety check: only remove if the standalone content matches the plugin's
      // copy (or looks like standard OMC frontmatter). This preserves user-authored
      // skills that happen to share a name with a plugin skill.
      const pluginContent = pluginSkillHashes.get(entry.name);
      const isOmcCreated = standaloneContent.startsWith('---\n') && /^name:\s+\S+/m.test(standaloneContent);

      if (pluginContent === standaloneContent || isOmcCreated) {
        rmSync(join(SKILLS_DIR, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
        log(`  Pruned plugin-duplicate skill: ${entry.name}/`);
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  return removed;
}

function directoryHasMarkdownFiles(directory: string): boolean {
  if (!existsSync(directory)) {
    return false;
  }

  try {
    return readdirSync(directory).some(file => file.endsWith('.md'));
  } catch {
    return false;
  }
}

function directoryHasSkillDefinitions(directory: string): boolean {
  if (!existsSync(directory)) {
    return false;
  }

  try {
    return readdirSync(directory, { withFileTypes: true }).some(entry =>
      entry.isDirectory() && existsSync(join(directory, entry.name, 'SKILL.md'))
    );
  } catch {
    return false;
  }
}

export function getInstalledOmcPluginRoots(): string[] {
  const pluginRoots = new Set<string>();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT?.trim();

  if (pluginRoot) {
    pluginRoots.add(pluginRoot);
  }

  const installedPluginsPath = join(CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json');
  if (!existsSync(installedPluginsPath)) {
    return Array.from(pluginRoots);
  }

  try {
    const raw = JSON.parse(readFileSync(installedPluginsPath, 'utf-8')) as {
      plugins?: Record<string, Array<{ installPath?: string }>>;
    } | Record<string, Array<{ installPath?: string }>>;
    const plugins = raw.plugins ?? raw;

    for (const [pluginId, entries] of Object.entries(plugins)) {
      if (!pluginId.toLowerCase().includes('oh-my-claudecode') || !Array.isArray(entries)) {
        continue;
      }

      for (const entry of entries) {
        if (typeof entry?.installPath === 'string' && entry.installPath.trim().length > 0) {
          pluginRoots.add(entry.installPath.trim());
        }
      }
    }
  } catch {
    // Ignore unreadable plugin registry and fall back to env-based detection.
  }

  return Array.from(pluginRoots);
}

/**
 * Detect whether an installed Claude Code plugin already provides OMC agent
 * markdown files, so the legacy ~/.claude/agents copy can be skipped.
 */
export function hasPluginProvidedAgentFiles(): boolean {
  return getInstalledOmcPluginRoots().some(pluginRoot =>
    directoryHasMarkdownFiles(join(pluginRoot, 'agents'))
  );
}

export function hasPluginProvidedSkillFiles(): boolean {
  return getInstalledOmcPluginRoots().some(pluginRoot =>
    directoryHasSkillDefinitions(join(pluginRoot, 'skills'))
  );
}

export function hasEnabledOmcPlugin(): boolean {
  if (process.env.CLAUDE_PLUGIN_ROOT?.trim()) {
    return true;
  }

  if (!existsSync(SETTINGS_FILE)) {
    return false;
  }

  try {
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as {
      // Modern Claude Code 1.x format. The canonical field name.
      enabledPlugins?: unknown;
      // Legacy field name kept for backward compatibility with older
      // Claude Code installs that wrote `plugins` instead of `enabledPlugins`.
      plugins?: unknown;
    };

    // Prefer `enabledPlugins` (modern), fall back to `plugins` (legacy).
    // Returning on the first hit short-circuits the check whenever we find
    // an enabled OMC plugin entry in either field.
    for (const candidate of [settings.enabledPlugins, settings.plugins]) {
      if (Array.isArray(candidate)) {
        if (candidate.some(plugin =>
          typeof plugin === 'string' && plugin.toLowerCase().includes('oh-my-claudecode')
        )) {
          return true;
        }
      } else if (candidate && typeof candidate === 'object') {
        if (Object.entries(candidate as Record<string, unknown>).some(([pluginId, value]) =>
          pluginId.toLowerCase().includes('oh-my-claudecode') && value !== false
        )) {
          return true;
        }
      }
    }
  } catch {
    // Ignore unreadable settings and treat plugin mode as disabled.
  }

  return false;
}

/**
 * Get the package root directory.
 * Works for both ESM (dist/installer/) and CJS bundles (bridge/).
 * When esbuild bundles to CJS, import.meta is replaced with {} so we
 * fall back to __dirname which is natively available in CJS.
 */
function getPackageDir(): string {
  const resolveFromDir = (baseDir: string): string => {
    const candidates = [
      join(baseDir, '..'),
      join(baseDir, '..', '..'),
      join(baseDir, '..', '..', '..'),
    ];

    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'package.json'))) {
        return candidate;
      }
    }

    return candidates[0];
  };

  // CJS bundle path (bridge/cli.cjs) and test/dev source imports.
  if (typeof __dirname !== 'undefined') {
    return resolveFromDir(__dirname);
  }
  // ESM path (works in dev via ts/dist)
  try {
    const __filename = fileURLToPath(import.meta.url);
    const currentDir = dirname(__filename);
    return resolveFromDir(currentDir);
  } catch {
    // import.meta.url unavailable — last resort
    return process.cwd();
  }
}

export function getRuntimePackageRoot(): string {
  return getPackageDir();
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
 *
 * NOTE: The commands/ directory was removed in v4.1.16 (#582).
 * All commands are now plugin-scoped skills. This function returns
 * an empty object for backward compatibility.
 */
function loadCommandDefinitions(): Record<string, string> {
  const commandsDir = join(getPackageDir(), 'commands');

  if (!existsSync(commandsDir)) {
    return {};
  }

  const definitions: Record<string, string> = {};
  for (const file of readdirSync(commandsDir)) {
    if (file.endsWith('.md')) {
      definitions[file] = readFileSync(join(commandsDir, file), 'utf-8');
    }
  }

  return definitions;
}

function toSafeStandaloneSkillName(name: string): string {
  const normalized = name.trim();
  return CC_NATIVE_COMMANDS.has(normalized.toLowerCase())
    ? `omc-${normalized}`
    : normalized;
}

function getManagedSkillMarkerPath(skillDir: string): string {
  return join(skillDir, OMC_MANAGED_SKILL_MARKER);
}

function markSkillAsOmcManaged(skillDir: string): void {
  writeFileSync(getManagedSkillMarkerPath(skillDir), 'omc-managed\n');
}

function isOmcManagedSkillDir(skillDir: string): boolean {
  return existsSync(getManagedSkillMarkerPath(skillDir));
}

function syncBundledSkillDefinitions(log: (msg: string) => void, options?: { safeStandaloneNames?: boolean }): string[] {
  const skillsDir = join(getPackageDir(), 'skills');
  const installedSkills: string[] = [];

  if (!existsSync(skillsDir)) {
    return installedSkills;
  }

  const seenTargetDirs = new Set<string>();

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SKININTHEGAMEBROS_ONLY_SKILLS.has(entry.name) && !isSkininthegamebrosUser()) {
      continue;
    }

    const sourceDir = join(skillsDir, entry.name);
    const sourceSkillPath = join(sourceDir, 'SKILL.md');
    if (!existsSync(sourceSkillPath)) continue;

    let targetDirName = entry.name;
    if (options?.safeStandaloneNames) {
      const content = readFileSync(sourceSkillPath, 'utf-8');
      const { metadata } = parseFrontmatter(content);
      const rawName = typeof metadata.name === 'string' && metadata.name.trim().length > 0
        ? metadata.name
        : entry.name;
      targetDirName = toSafeStandaloneSkillName(rawName);
    }

    const dedupeKey = targetDirName.toLowerCase();
    if (seenTargetDirs.has(dedupeKey)) continue;
    seenTargetDirs.add(dedupeKey);

    const relativePath = join(targetDirName, 'SKILL.md');
    const targetDir = join(SKILLS_DIR, targetDirName);
    cpSync(sourceDir, targetDir, { recursive: true, force: true });
    markSkillAsOmcManaged(targetDir);
    installedSkills.push(relativePath.replace(/\\/g, '/'));
    log(`  Synced ${relativePath}`);
  }

  return installedSkills;
}

function loadClaudeMdContent(): string {
  const claudeMdPath = join(getPackageDir(), 'docs', 'CLAUDE.md');

  if (!existsSync(claudeMdPath)) {
    console.error(`FATAL: CLAUDE.md not found: ${claudeMdPath}`);
    process.exit(1);
  }

  return readFileSync(claudeMdPath, 'utf-8');
}

/**
 * Extract the embedded OMC version from a CLAUDE.md file.
 *
 * Primary source of truth is the injected `<!-- OMC:VERSION:x.y.z -->` marker.
 * Falls back to legacy headings that may include a version string inline.
 */
export function extractOmcVersionFromClaudeMd(content: string): string | null {
  const versionMarkerMatch = content.match(/<!--\s*OMC:VERSION:([^\s]+)\s*-->/i);
  if (versionMarkerMatch?.[1]) {
    const markerVersion = versionMarkerMatch[1].trim();
    return markerVersion.startsWith('v') ? markerVersion : `v${markerVersion}`;
  }

  const headingMatch = content.match(/^#\s+oh-my-claudecode.*?\b(v?\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/m);
  if (headingMatch?.[1]) {
    const headingVersion = headingMatch[1].trim();
    return headingVersion.startsWith('v') ? headingVersion : `v${headingVersion}`;
  }

  return null;
}

/**
 * Keep persisted setup metadata in sync with the installed OMC runtime version.
 *
 * This intentionally updates only already-configured users by default so
 * installer/reconciliation flows do not accidentally mark fresh installs as if
 * the interactive setup wizard had been completed.
 */
export function syncPersistedSetupVersion(options?: {
  configPath?: string;
  claudeMdPath?: string;
  version?: string;
  onlyIfConfigured?: boolean;
}): boolean {
  const configPath = options?.configPath ?? join(CLAUDE_CONFIG_DIR, OMC_CONFIG_FILE_REL);
  let config: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    const rawConfig = readFileSync(configPath, 'utf-8').trim();
    if (rawConfig.length > 0) {
      config = JSON.parse(rawConfig) as Record<string, unknown>;
    }
  }

  const onlyIfConfigured = options?.onlyIfConfigured ?? true;
  const isConfigured = typeof config.setupCompleted === 'string' || typeof config.setupVersion === 'string';
  if (onlyIfConfigured && !isConfigured) {
    return false;
  }

  let detectedVersion = options?.version?.trim();
  if (!detectedVersion) {
    const claudeMdPath = options?.claudeMdPath ?? join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      detectedVersion = extractOmcVersionFromClaudeMd(readFileSync(claudeMdPath, 'utf-8')) ?? undefined;
    }
  }

  const normalizedVersion = (() => {
    const candidate = (detectedVersion && detectedVersion !== 'unknown') ? detectedVersion : VERSION;
    return candidate.startsWith('v') ? candidate : `v${candidate}`;
  })();

  if (config.setupVersion === normalizedVersion) {
    return false;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ ...config, setupVersion: normalizedVersion }, null, 2));
  return true;
}

/**
 * Merge OMC content into existing CLAUDE.md using markers
 * @param existingContent - Existing CLAUDE.md content (null if file doesn't exist)
 * @param omcContent - New OMC content to inject
 * @returns Merged content with markers
 */
export function mergeClaudeMd(existingContent: string | null, omcContent: string, version?: string): string {
  const START_MARKER = '<!-- OMC:START -->';
  const END_MARKER = '<!-- OMC:END -->';
  const USER_CUSTOMIZATIONS = '<!-- User customizations -->';
  const OMC_BLOCK_PATTERN = new RegExp(
    `^${escapeRegex(START_MARKER)}\\r?\\n[\\s\\S]*?^${escapeRegex(END_MARKER)}(?:\\r?\\n)?`,
    'gm'
  );
  const markerStartRegex = createLineAnchoredMarkerRegex(START_MARKER);
  const markerEndRegex = createLineAnchoredMarkerRegex(END_MARKER);

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

  const strippedExistingContent = existingContent.replace(OMC_BLOCK_PATTERN, '');
  const hasResidualStartMarker = markerStartRegex.test(strippedExistingContent);
  const hasResidualEndMarker = markerEndRegex.test(strippedExistingContent);

  // Case 2: Corrupted markers (unmatched markers remain after removing complete blocks)
  if (hasResidualStartMarker || hasResidualEndMarker) {
    // Handle corrupted state - backup will be created by caller
    // Strip unmatched OMC markers from recovered content to prevent unbounded
    // growth on repeated calls (each call would re-detect corruption and append again)
    const recoveredContent = strippedExistingContent
      .replace(markerStartRegex, '')
      .replace(markerEndRegex, '')
      .trim();
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n<!-- User customizations (recovered from corrupted markers) -->\n${recoveredContent}`;
  }

  const preservedUserContent = trimClaudeUserContent(
    stripGeneratedUserCustomizationHeaders(strippedExistingContent)
  );

  if (!preservedUserContent) {
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n`;
  }

  // Case 3: Preserve only user-authored content that lives outside OMC markers
  return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\n${preservedUserContent}`;
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
    hookConflicts: [],
    errors: []
  };

  const log = (msg: string) => {
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

  const targetVersion = options.version ?? VERSION;
  const installedVersionHint = getNewestInstalledVersionHint();

  if (isComparableVersion(targetVersion)
    && isComparableVersion(installedVersionHint)
    && compareVersions(targetVersion, installedVersionHint) < 0) {
    const message = `Skipping install: installed OMC ${installedVersionHint} is newer than CLI package ${targetVersion}. Run "omc update" to update the CLI package, then rerun "omc setup".`;
    log(message);
    result.success = true;
    result.message = message;
    return result;
  }

  // Log platform info
  log(`Platform: ${process.platform} (Node.js hooks)`);

  // Check if running as a plugin
  const runningAsPlugin = isRunningAsPlugin();
  const projectScoped = isProjectScopedPlugin();
  const pluginProvidesAgentFiles = hasPluginProvidedAgentFiles();
  const pluginProvidesSkillFiles = hasPluginProvidedSkillFiles();
  const enabledOmcPlugin = hasEnabledOmcPlugin();
  // Dev plugin-dir mode: user launched OMC via `claude --plugin-dir <path>` or
  // `omc --plugin-dir <path>`. The plugin already exposes agents/skills at runtime,
  // so skip copying them into <configDir>. Auto-detected via OMC_PLUGIN_ROOT in CLI.
  // `noPlugin` still wins (CLI enforces precedence and warns), so we ignore
  // `pluginDirMode` whenever `noPlugin` is set.
  const pluginDirMode = options.pluginDirMode === true && options.noPlugin !== true;
  if (pluginDirMode) {
    log('Dev plugin-dir mode: skipping agent/skill sync (plugin provides them via --plugin-dir)');
  }
  const shouldInstallLegacyAgents = !runningAsPlugin && !pluginProvidesAgentFiles && !pluginDirMode;
  const shouldInstallBundledSkills =
    !pluginDirMode && (options.noPlugin === true || !enabledOmcPlugin || !pluginProvidesSkillFiles);
  const allowPluginHookRefresh = runningAsPlugin && options.refreshHooksInPlugin && !projectScoped;
  if (runningAsPlugin) {
    log('Detected Claude Code plugin context - skipping agent/command file installation');
    log('Plugin files are managed by Claude Code plugin system');
    if (projectScoped) {
      log('Detected project-scoped plugin - skipping global HUD/settings modifications');
    } else {
      log('Will still install HUD statusline...');
      if (allowPluginHookRefresh) {
        log('Will refresh global hooks/settings for plugin runtime reconciliation');
      }
    }
    // Don't return early - continue to install HUD (unless project-scoped)
  } else if (pluginProvidesAgentFiles) {
    log('Detected installed OMC plugin agent definitions - skipping legacy ~/.claude/agents sync');
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
    // Ensure base config directory exists (skip for project-scoped plugins)
    if ((!projectScoped || shouldInstallBundledSkills) && !existsSync(CLAUDE_CONFIG_DIR)) {
      mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
    }

    if (shouldInstallBundledSkills && !existsSync(SKILLS_DIR)) {
      mkdirSync(SKILLS_DIR, { recursive: true });
    }

    // Skip agent/command/hook file installation when running as plugin
    // Plugin system handles these via ${CLAUDE_PLUGIN_ROOT}
    if (!runningAsPlugin) {
      // Create directories
      log('Creating directories...');
      if (shouldInstallLegacyAgents && !existsSync(AGENTS_DIR)) {
        mkdirSync(AGENTS_DIR, { recursive: true });
      }
      // NOTE: COMMANDS_DIR creation removed - commands/ deprecated in v4.1.16 (#582)
      if (shouldInstallBundledSkills && !existsSync(SKILLS_DIR)) {
        mkdirSync(SKILLS_DIR, { recursive: true });
      }
      if (!existsSync(HOOKS_DIR)) {
        mkdirSync(HOOKS_DIR, { recursive: true });
      }

      // Install agents
      if (shouldInstallLegacyAgents) {
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
      } else {
        log('Skipping legacy agent file installation (plugin-provided agents are available)');
        // Remove standalone copies that duplicate plugin-provided agents (#2252)
        const prunedAgents = prunePluginDuplicateAgents(log);
        if (prunedAgents.length > 0) {
          log(`Pruned ${prunedAgents.length} duplicate standalone agent(s)`);
        }
      }

      // Clean up stale OMC-created agents from previous versions
      if (existsSync(AGENTS_DIR)) {
        const removedAgents = cleanupStaleAgents(log);
        if (removedAgents.length > 0) {
          log(`Cleaned up ${removedAgents.length} stale agent(s)`);
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
        } else {
          writeFileSync(filepath, content);
          result.installedCommands.push(filename);
          log(`  Installed ${filename}`);
        }
      }

      // Standalone installs still need ~/.claude/hooks/* scripts because their
      // settings.json hook entries execute those local paths directly. Plugin installs
      // keep using hooks/hooks.json + scripts/ under CLAUDE_PLUGIN_ROOT.
      ensureStandaloneHookScripts(log);
      result.hooksConfigured = true; // Will be set properly after consolidated settings.json write
    } else {
      log('Skipping agent/command/hook files (managed by plugin system)');
    }

    if (shouldInstallBundledSkills) {
      log(options.noPlugin
        ? 'Installing bundled skills from local package (--no-plugin)...'
        : !enabledOmcPlugin
          ? 'Installing bundled skills from local package (no enabled OMC plugin detected)...'
          : 'Installing bundled skills from local package (enabled plugin skill files not found)...');
      result.installedSkills.push(...syncBundledSkillDefinitions(log, {
        safeStandaloneNames: !enabledOmcPlugin || options.noPlugin === true,
      }));
    } else if (pluginProvidesSkillFiles) {
      log('Skipping bundled skill installation (plugin-provided skills are available). Use --no-plugin to force local skill sync.');
      // Remove standalone copies that duplicate plugin-provided skills (#2252)
      const prunedSkills = prunePluginDuplicateSkills(log);
      if (prunedSkills.length > 0) {
        log(`Pruned ${prunedSkills.length} duplicate standalone skill(s)`);
      }
    } else if (runningAsPlugin) {
      log('Skipping bundled skill installation (managed by plugin system)');
    }

    // Clean up stale OMC-created skills from previous versions
    if (existsSync(SKILLS_DIR)) {
      const removedSkills = cleanupStaleSkills(log);
      if (removedSkills.length > 0) {
        log(`Cleaned up ${removedSkills.length} stale skill(s)`);
      }
    }

    // Install CLAUDE.md with merge support.
    // This runs regardless of plugin context so that `omc update` (which re-execs
    // as `update-reconcile` with CLAUDE_PLUGIN_ROOT still set) always keeps the
    // version marker and OMC instructions in ~/.claude/CLAUDE.md up to date.
    // Skipped only for project-scoped plugins to avoid mutating global config.
    if (!projectScoped) {
      const claudeMdPath = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
      const omcContent = loadClaudeMdContent();

      // Read existing content if it exists
      let existingContent: string | null = null;
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
      const mergedContent = mergeClaudeMd(existingContent, omcContent, targetVersion);
      writeFileSync(claudeMdPath, mergedContent);

      if (existingContent) {
        log('Updated CLAUDE.md (merged with existing content)');
      } else {
        log('Created CLAUDE.md');
      }
    }

    // Install HUD statusline (skip for project-scoped plugins, skipHud option, or hudEnabled config)
    let hudScriptPath: string | null = null;
    const hudDisabledByOption = options.skipHud === true;
    const hudDisabledByConfig = !isHudEnabledInConfig();
    const skipHud = projectScoped || hudDisabledByOption || hudDisabledByConfig;
    if (projectScoped) {
      log('Skipping HUD statusline (project-scoped plugin should not modify global settings)');
    } else if (hudDisabledByOption) {
      log('Skipping HUD statusline (user opted out)');
    } else if (hudDisabledByConfig) {
      log('Skipping HUD statusline (hudEnabled is false in .omc-config.json)');
    } else {
      log('Installing HUD statusline...');
    }
    if (!skipHud) try {
      if (!existsSync(HUD_DIR)) {
        mkdirSync(HUD_DIR, { recursive: true });
      }

      // Build the HUD script content (compiled from src/hud/index.ts).
      // The wrapper body is read by buildHudWrapper() in src/lib/hud-wrapper-template.ts —
      // the single TS source of truth, mirrored by scripts/lib/hud-wrapper-template.mjs
      // for scripts/plugin-setup.mjs. Drift enforced by hud-wrapper-template-sync.test.ts.
      hudScriptPath = join(HUD_DIR, 'omc-hud.mjs').replace(/\\/g, '/');
      const hudScript = buildHudWrapper(getPackageDir());

      writeFileSync(hudScriptPath, hudScript);
      if (!isWindows()) {
        chmodSync(hudScriptPath, 0o755);
      }
      log('  Installed omc-hud.mjs');
    } catch (_e) {
      log('  Warning: Could not install HUD statusline script (non-fatal)');
      hudScriptPath = null;
    }

    // Consolidated settings.json write (atomic: read once, modify, write once)
    // Skip for project-scoped plugins to avoid affecting global settings
    if (projectScoped) {
      log('Skipping settings.json configuration (project-scoped plugin)');
    } else {
      log('Configuring settings.json...');
    }
    if (!projectScoped) try {
      let existingSettings: Record<string, unknown> = {};
      if (existsSync(SETTINGS_FILE)) {
        const settingsContent = readFileSync(SETTINGS_FILE, 'utf-8');
        existingSettings = JSON.parse(settingsContent);
      }

      // 1. Remove legacy ~/.claude/hooks/ entries from settings.json, then restore
      // standalone settings hooks or refresh plugin-safe merged hooks as needed.
      {
        const existingHooks = { ...((existingSettings.hooks || {}) as Record<string, unknown>) };
        let legacyRemoved = 0;

        for (const [eventType, groups] of Object.entries(existingHooks)) {
          const groupList = groups as HookGroup[];
          const filtered = groupList.filter(group => {
            const isLegacy = group.hooks.every(h =>
              h.type === 'command'
              && (h.command.includes('/.claude/hooks/') || h.command.includes('\\.claude\\hooks\\'))
              && isOmcHook(h.command)
            );
            if (isLegacy) legacyRemoved++;
            return !isLegacy;
          });
          if (filtered.length === 0) {
            delete existingHooks[eventType];
          } else {
            existingHooks[eventType] = filtered;
          }
        }

        if (legacyRemoved > 0) {
          log(`  Cleaned up ${legacyRemoved} legacy hook entries from settings.json`);
        }

        const shouldConfigureSettingsHooks = !runningAsPlugin || allowPluginHookRefresh;
        if (shouldConfigureSettingsHooks) {
          const desiredHooks = getHooksSettingsConfig().hooks as Record<string, HookGroup[]>;

          for (const [eventType, newOmcGroups] of Object.entries(desiredHooks)) {
            const currentGroups = (existingHooks[eventType] as HookGroup[] | undefined) ?? [];
            existingHooks[eventType] = mergeHookGroups(
              eventType,
              currentGroups,
              newOmcGroups,
              options,
              log,
              result,
            );
          }
        }

        existingSettings.hooks = Object.keys(existingHooks).length > 0 ? existingHooks : undefined;
        result.hooksConfigured = true;
      }

      // 2. Configure statusLine (always, even in plugin mode)
      if (hudScriptPath) {
        const nodeBin = resolveNodeBinary();
        const absoluteCommand = '"' + nodeBin + '" "' + hudScriptPath.replace(/\\/g, '/') + '"';
        try {
          const configDirHelperMjsSrc = join(getPackageDir(), 'scripts', 'lib', 'config-dir.mjs');
          const hudLibDir = join(HUD_DIR, 'lib');
          const configDirHelperMjsDest = join(hudLibDir, 'config-dir.mjs');
          if (!existsSync(hudLibDir)) {
            mkdirSync(hudLibDir, { recursive: true });
          }
          copyFileSync(configDirHelperMjsSrc, configDirHelperMjsDest);
        } catch {
          // Keep HUD installation best-effort if helper copy fails unexpectedly.
        }

        // On Unix, use find-node.sh for portable $HOME paths (multi-machine sync)
        // and robust node discovery (nvm/fnm in non-interactive shells).
        // Copy find-node.sh into the HUD directory so statusLine can reference it
        // without depending on CLAUDE_PLUGIN_ROOT (which is only set for hooks).
        let statusLineCommand = absoluteCommand;
        if (!isWindows()) {
          try {
            const findNodeSrc = join(getPackageDir(), 'scripts', 'find-node.sh');
            const findNodeDest = join(HUD_DIR, 'find-node.sh');
            const configDirHelperSrc = join(getPackageDir(), 'scripts', 'lib', 'config-dir.sh');
            const hudLibDir = join(HUD_DIR, 'lib');
            const configDirHelperDest = join(hudLibDir, 'config-dir.sh');
            if (!existsSync(hudLibDir)) {
              mkdirSync(hudLibDir, { recursive: true });
            }
            copyFileSync(findNodeSrc, findNodeDest);
            copyFileSync(configDirHelperSrc, configDirHelperDest);
            chmodSync(findNodeDest, 0o755);
            chmodSync(configDirHelperDest, 0o755);
            statusLineCommand = buildStatusLineCommand(nodeBin, hudScriptPath.replace(/\\/g, '/'), findNodeDest);
          } catch {
            // Fallback to bare node if find-node.sh copy fails
            statusLineCommand = buildStatusLineCommand(nodeBin, hudScriptPath.replace(/\\/g, '/'));
          }
        } else {
          statusLineCommand = buildStatusLineCommand(nodeBin, hudScriptPath);
        }
        // Auto-migrate legacy string format (pre-v4.5) to object format
        const needsMigration = typeof existingSettings.statusLine === 'string'
          && isOmcStatusLine(existingSettings.statusLine);
        if (!existingSettings.statusLine || needsMigration) {
          existingSettings.statusLine = {
            type: 'command',
            command: statusLineCommand
          };
          log(needsMigration
            ? '  Migrated statusLine from legacy string to object format'
            : '  Configured statusLine');
        } else if (options.force && isOmcStatusLine(existingSettings.statusLine)) {
          existingSettings.statusLine = {
            type: 'command',
            command: statusLineCommand
          };
          log('  Updated statusLine (--force)');
        } else if (options.force) {
          log('  statusLine owned by another tool, preserving (use manual edit to override)');
        } else {
          log('  statusLine already configured, skipping (use --force to override)');
        }
      }

      // 3. Persist the detected node binary path into .omc-config.json so that
      //    find-node.sh (used in hooks/hooks.json) can locate it at hook runtime
      //    even when node is not on PATH (nvm/fnm users, issue #892).
      try {
        const configPath = join(CLAUDE_CONFIG_DIR, OMC_CONFIG_FILE_REL);
        let omcConfig: Record<string, unknown> = {};
        if (existsSync(configPath)) {
          omcConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        }
        const detectedNode = resolveNodeBinary();
        if (detectedNode !== 'node') {
          omcConfig.nodeBinary = detectedNode;
          writeFileSync(configPath, JSON.stringify(omcConfig, null, 2));
          log(`  Saved node binary path to .omc-config.json: ${detectedNode}`);
        }
      } catch {
        log('  Warning: Could not save node binary path (non-fatal)');
      }

      // 4. Sync unified MCP registry into Claude + Codex config surfaces
      const mcpSync = syncUnifiedMcpRegistryTargets(existingSettings);
      existingSettings = mcpSync.settings;
      if (mcpSync.result.bootstrappedFromClaude) {
        log(`  Bootstrapped unified MCP registry: ${mcpSync.result.registryPath}`);
      }
      if (mcpSync.result.claudeChanged) {
        log(`  Synced ${mcpSync.result.serverNames.length} MCP server(s) into Claude MCP config: ${mcpSync.result.claudeConfigPath}`);
      }
      if (mcpSync.result.codexChanged) {
        log(`  Synced ${mcpSync.result.serverNames.length} MCP server(s) into Codex config: ${mcpSync.result.codexConfigPath}`);
      }

      // 5. Single atomic write
      writeFileSync(SETTINGS_FILE, JSON.stringify(existingSettings, null, 2));
      log('  settings.json updated');
    } catch (_e) {
      log('  Warning: Could not configure settings.json (non-fatal)');
      result.hooksConfigured = false;
    }

    // Save version metadata (skip for project-scoped plugins)
    if (!projectScoped) {
      const versionMetadata = {
        version: targetVersion,
        installedAt: new Date().toISOString(),
        installMethod: 'npm' as const,
        lastCheckAt: new Date().toISOString()
      };
      writeFileSync(VERSION_FILE, JSON.stringify(versionMetadata, null, 2));
      log('Saved version metadata');
    } else {
      log('Skipping version metadata (project-scoped plugin)');
    }

    try {
      const setupVersionSynced = syncPersistedSetupVersion({
        version: options.version ?? VERSION,
        onlyIfConfigured: true,
      });
      if (setupVersionSynced) {
        log('Updated persisted setupVersion');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  Warning: Could not refresh setupVersion metadata (non-fatal): ${message}`);
    }

    result.success = true;
    result.message = `Successfully installed ${result.installedAgents.length} agents, ${result.installedCommands.length} commands, ${result.installedSkills.length} skills`; 

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
  return existsSync(VERSION_FILE) && (existsSync(AGENTS_DIR) || hasPluginProvidedAgentFiles());
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

/**
 * Installer Module
 *
 * Handles installation of OMC agents, commands, and configuration
 * into the Claude Code config directory (~/.claude/).
 *
 * Cross-platform support via Node.js-based hook scripts (.mjs).
 * Bash hook scripts were removed in v3.9.0.
 */
import { mergeClaudeMd } from '../setup/claude-md.js';
export { mergeClaudeMd };
/** Claude Code configuration directory */
export declare const CLAUDE_CONFIG_DIR: string;
export declare const AGENTS_DIR: string;
export declare const COMMANDS_DIR: string;
export declare const SKILLS_DIR: string;
export declare const HOOKS_DIR: string;
export declare const HUD_DIR: string;
export declare const SETTINGS_FILE: string;
export declare const VERSION_FILE: string;
/**
 * Core commands - DISABLED for v3.0+
 * All commands are now plugin-scoped skills managed by Claude Code.
 * The installer no longer copies commands to ~/.claude/commands/
 */
export declare const CORE_COMMANDS: string[];
/** Current version */
export declare const VERSION: string;
/** Installation result */
export interface InstallResult {
    success: boolean;
    message: string;
    installedAgents: string[];
    installedCommands: string[];
    installedSkills: string[];
    hooksConfigured: boolean;
    hookConflicts: Array<{
        eventType: string;
        existingCommand: string;
    }>;
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
     * Skip hook installation entirely: no standalone hook scripts written
     * and no hook merge into `settings.json`. Exposed via the `--skip-hooks`
     * CLI flag; prior to the setup unification this flag was silently
     * ignored (non-regression #2 / plan: skipHooks bug fix).
     *
     * Deprecated: flag is kept for two release cycles with a stderr advisory
     * on first use (see CLI).
     */
    skipHooks?: boolean;
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
export declare function isHudEnabledInConfig(): boolean;
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
export declare function isOmcStatusLine(statusLine: unknown): boolean;
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
export declare function isOmcHook(command: string): boolean;
/**
 * Check if the current Node.js version meets the minimum requirement
 */
export declare function checkNodeVersion(): {
    valid: boolean;
    current: number;
    required: number;
};
/**
 * Check if Claude Code is installed
 * Uses 'where' on Windows, 'which' on Unix
 */
export declare function isClaudeInstalled(): boolean;
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
export declare function isRunningAsPlugin(): boolean;
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
export declare function isProjectScopedPlugin(): boolean;
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
export declare function cleanupStaleAgents(log: (msg: string) => void): string[];
/**
 * Remove standalone agent files that duplicate plugin-provided agents (#2252).
 *
 * When the plugin is the canonical agent source, standalone copies in
 * ~/.claude/agents/ from a prior `omc setup` cause agent definitions to
 * appear twice. Removes standalone copies with OMC frontmatter whose
 * filename matches a current package agent.
 */
export declare function prunePluginDuplicateAgents(log: (msg: string) => void): string[];
/**
 * Remove stale OMC-created skill directories from the config skills directory.
 *
 * Similar to cleanupStaleAgents but for skill directories. Removes directories
 * that contain a SKILL.md with OMC frontmatter but are no longer shipped by
 * the current package version. User-created skills are preserved.
 */
export declare function cleanupStaleSkills(log: (msg: string) => void): string[];
/**
 * Remove standalone skill directories that duplicate plugin-provided skills.
 *
 * When the plugin is the canonical skill source, standalone copies in
 * ~/.claude/skills/ from a prior `omc setup` cause every command to appear
 * twice (#2252). This function removes standalone copies whose SKILL.md
 * content-hashes match any installed plugin version, preserving user-authored
 * skills that happen to share a name.
 */
export declare function prunePluginDuplicateSkills(log: (msg: string) => void): string[];
/**
 * Remove standalone hook files under $CONFIG_DIR/hooks/ that duplicate the
 * plugin's hooks/hooks.json delivery. Invoked ONLY when a plugin is active
 * AND user opted into cleanup. Ownership check: filename must be in
 * OMC_HOOK_FILENAMES so we never touch user-authored hooks.
 *
 * Returns the list of absolute paths that were removed.
 */
export declare function prunePluginDuplicateHooks(log: (msg: string) => void): string[];
/**
 * Result shape shared by both the preview and execute paths for plugin-mode
 * leftover cleanup.
 */
export interface StandaloneDuplicatesPreview {
    /** Absolute paths of agent files that were (or would be) removed. */
    prunedAgents: string[];
    /** Names of skill directories that were (or would be) removed. */
    prunedSkills: string[];
    /** Absolute paths of hook files that were (or would be) removed. */
    prunedHooks: string[];
    /** Whether settings.json was (or would be) mutated to strip OMC entries. */
    settingsStripped: boolean;
    /** Sum of prunedAgents + prunedSkills + prunedHooks lengths. */
    totalPruneCount: number;
    /** True when any cleanup work exists (prune OR settings strip). */
    hasWork: boolean;
}
/**
 * Preview what `pruneStandaloneDuplicatesForPluginMode` would do without
 * mutating the filesystem. Safe to call at any time.
 */
export declare function previewStandaloneDuplicatesForPluginMode(opts?: {
    configDir?: string;
}): StandaloneDuplicatesPreview;
/**
 * When a Claude Code plugin is active (marketplace OR --plugin-dir-mode),
 * the plugin delivers agents/skills/hooks at runtime from its own root,
 * so any standalone copies under $CONFIG_DIR/ are redundant and can cause
 * duplicate loading / duplicate hook invocations.
 *
 * This helper runs the three prune helpers when their corresponding
 * plugin-provided-files check returns true, and strips OMC-owned hook
 * entries from settings.json when the plugin provides hooks.json.
 *
 * Safe to call multiple times — every prune helper is idempotent and
 * gated on ownership checks (plugin basename list for agents, sentinel
 * file check for skills, OMC_HOOK_FILENAMES list for hooks).
 *
 * Returns a summary of what was pruned. Empty arrays when nothing
 * needed cleanup.
 */
export declare function pruneStandaloneDuplicatesForPluginMode(log: (msg: string) => void, opts?: {
    configDir?: string;
}): StandaloneDuplicatesPreview;
export declare function getInstalledOmcPluginRoots(): string[];
/**
 * Detect whether an installed Claude Code plugin already provides OMC agent
 * markdown files, so the legacy ~/.claude/agents copy can be skipped.
 */
export declare function hasPluginProvidedAgentFiles(): boolean;
export declare function hasPluginProvidedSkillFiles(): boolean;
/**
 * Detect whether an installed Claude Code plugin ships `hooks/hooks.json`.
 * Claude Code loads plugin hooks.json automatically, referencing scripts
 * under `$CLAUDE_PLUGIN_ROOT/scripts/*.mjs` — so `$CONFIG_DIR/hooks/`
 * standalone copies are redundant and cause duplicate hook invocations.
 */
export declare function hasPluginProvidedHookFiles(): boolean;
export declare function hasEnabledOmcPlugin(): boolean;
export declare function getRuntimePackageRoot(): string;
/**
 * Extract the embedded OMC version from a CLAUDE.md file.
 *
 * Primary source of truth is the injected `<!-- OMC:VERSION:x.y.z -->` marker.
 * Falls back to legacy headings that may include a version string inline.
 */
export declare function extractOmcVersionFromClaudeMd(content: string): string | null;
/**
 * Keep persisted setup metadata in sync with the installed OMC runtime version.
 *
 * This intentionally updates only already-configured users by default so
 * installer/reconciliation flows do not accidentally mark fresh installs as if
 * the interactive setup wizard had been completed.
 */
export declare function syncPersistedSetupVersion(options?: {
    configPath?: string;
    claudeMdPath?: string;
    version?: string;
    onlyIfConfigured?: boolean;
}): boolean;
/**
 * Install OMC agents, commands, skills, and hooks
 */
export declare function install(options?: InstallOptions): InstallResult;
/**
 * Check if OMC is already installed
 */
export declare function isInstalled(): boolean;
/**
 * Get installation info
 */
export declare function getInstallInfo(): {
    version: string;
    installedAt: string;
    method: string;
} | null;
//# sourceMappingURL=index.d.ts.map
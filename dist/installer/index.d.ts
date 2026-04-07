/**
 * Installer Module
 *
 * Handles installation of OMC agents, commands, and configuration
 * into the Claude Code config directory (~/.claude/).
 *
 * Cross-platform support via Node.js-based hook scripts (.mjs).
 * Bash hook scripts were removed in v3.9.0.
 */
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
export declare function getInstalledOmcPluginRoots(): string[];
/**
 * Detect whether an installed Claude Code plugin already provides OMC agent
 * markdown files, so the legacy ~/.claude/agents copy can be skipped.
 */
export declare function hasPluginProvidedAgentFiles(): boolean;
export declare function hasPluginProvidedSkillFiles(): boolean;
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
 * Merge OMC content into existing CLAUDE.md using markers
 * @param existingContent - Existing CLAUDE.md content (null if file doesn't exist)
 * @param omcContent - New OMC content to inject
 * @returns Merged content with markers
 */
export declare function mergeClaudeMd(existingContent: string | null, omcContent: string, version?: string): string;
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
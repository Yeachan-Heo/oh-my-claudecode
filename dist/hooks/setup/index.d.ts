/**
 * Setup Hook Module
 *
 * Handles OMC initialization and maintenance tasks.
 * Triggers:
 * - init: Create directory structure, validate configs, set environment
 * - maintenance: Prune old state files, cleanup orphaned state, vacuum SQLite
 */
export interface SetupInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: 'Setup';
    trigger: 'init' | 'maintenance';
}
export interface SetupResult {
    directories_created: string[];
    configs_validated: string[];
    errors: string[];
    env_vars_set: string[];
}
export interface HookOutput {
    continue: boolean;
    hookSpecificOutput: {
        hookEventName: 'Setup';
        additionalContext: string;
    };
}
/**
 * Ensure all required directories exist
 */
export declare function ensureDirectoryStructure(directory: string): string[];
/**
 * Validate that config files exist and are readable
 */
export declare function validateConfigFiles(directory: string): string[];
/**
 * Set environment variables for OMC initialization
 */
export declare function setEnvironmentVariables(): string[];
/**
 * On Windows, rewrite hook invocations to `command: node` plus `args`.
 *
 * The sh->find-node.sh->node chain (v4.3.4, issue #892) is only needed on
 * Unix, where nvm/fnm may not expose `node` on PATH. On Windows that chain
 * triggers Claude Code UI bug #17088. The later shell string
 * `node "${CLAUDE_PLUGIN_ROOT}"/scripts/run.cjs ...` avoids #17088 and still
 * breaks under PowerShell: the shell splits the quoted root from `/scripts`,
 * and Node loads the plugin directory. Exec form spawns `node` with each
 * path as one argument and no shell (#4042, Grok on Windows).
 *
 * Input may be find-node.sh, the split shell string, or exec form. Exec form
 * is left unchanged. The file is written only when a command changed.
 */
export declare function patchHooksJsonForWindows(pluginRoot: string): void;
/**
 * Ensure ~/.claude/hooks/lib/stdin.mjs points to the current plugin version.
 *
 * This fixes a silent breakage that occurs when OMC upgrades to a new version:
 * the symlink stays pointing at the old version's cache dir, so hooks that
 * import stdin.mjs fail with ERR_MODULE_NOT_FOUND.  Rebuilding the symlink on
 * every init keeps it in sync automatically.
 *
 * Safe replace strategy: we only remove the old destination AFTER successfully
 * creating the new symlink, so we never leave the setup in a broken state.
 * Falls back to copy if symlink is unavailable on the platform.
 */
export declare function ensureStdinSymlink(pluginRoot: string): void;
/**
 * Process setup init trigger
 */
export declare function processSetupInit(input: SetupInput): Promise<HookOutput>;
/**
 * Prune old state files from .omc/state directory
 */
export declare function pruneOldStateFiles(directory: string, maxAgeDays?: number): number;
/**
 * Clean up orphaned state files (state files without corresponding active sessions)
 */
export declare function cleanupOrphanedState(directory: string): number;
/**
 * Process setup maintenance trigger
 */
export declare function processSetupMaintenance(input: SetupInput): Promise<HookOutput>;
/**
 * Process setup hook based on trigger type
 */
export declare function processSetup(input: SetupInput): Promise<HookOutput>;
//# sourceMappingURL=index.d.ts.map
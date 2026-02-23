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
 * On Windows, replace sh+find-node.sh hook invocations with direct node calls.
 *
 * The sh->find-node.sh->node chain introduced in v4.3.4 (issue #892) is only
 * needed on Unix where nvm/fnm may not expose `node` on PATH in non-interactive
 * shells.  On Windows (MSYS2 / Git Bash) the same chain triggers Claude Code UI
 * bug #17088, which mislabels every successful hook as an error.
 *
 * This function reads the plugin's hooks.json and rewrites every command of the
 * form:
 *   sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/X.mjs" [args]
 * to:
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/X.mjs" [args]
 *
 * The file is only written when at least one command was actually changed, so
 * the function is safe to call on every init (idempotent after first patch).
 */
export declare function patchHooksJsonForWindows(pluginRoot: string): void;
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
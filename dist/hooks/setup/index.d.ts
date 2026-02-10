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
 * Run VACUUM on swarm SQLite database if it exists
 */
export declare function vacuumSwarmDb(directory: string): boolean;
/**
 * Process setup maintenance trigger
 */
export declare function processSetupMaintenance(input: SetupInput): Promise<HookOutput>;
/**
 * Process setup hook based on trigger type
 */
export declare function processSetup(input: SetupInput): Promise<HookOutput>;
//# sourceMappingURL=index.d.ts.map
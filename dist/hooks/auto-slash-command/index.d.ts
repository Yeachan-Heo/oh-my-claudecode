/**
 * Auto Slash Command Hook
 *
 * Detects and expands slash commands in user prompts.
 * Complements Claude Code's native slash command system by adding:
 * - Skill-based commands from ~/.claude/skills/
 * - Project-level commands from .claude/commands/
 * - Template expansion with $ARGUMENTS placeholder
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */
import type { AutoSlashCommandHookInput, AutoSlashCommandResult } from './types.js';
export * from './types.js';
export * from './constants.js';
export { detectSlashCommand, extractPromptText, parseSlashCommand, removeCodeBlocks, isExcludedCommand, } from './detector.js';
export { executeSlashCommand, findCommand, discoverAllCommands, listAvailableCommands, } from './executor.js';
/**
 * Create auto slash command hook handlers
 */
export declare function createAutoSlashCommandHook(): {
    /**
     * Hook name identifier
     */
    name: "auto-slash-command";
    /**
     * Process a user message to detect and expand slash commands
     */
    processMessage: (input: AutoSlashCommandHookInput, parts: Array<{
        type: string;
        text?: string;
    }>) => AutoSlashCommandResult;
    /**
     * Get list of available commands
     */
    listCommands: () => {
        name: string;
        description: string;
        scope: import("./types.js").CommandScope;
    }[];
    /**
     * Find a specific command by name
     */
    findCommand: (name: string) => import("./types.js").CommandInfo | null;
    /**
     * Clear processed commands cache for a session
     */
    clearSession: (sessionId: string) => void;
};
/**
 * Process a prompt for slash command expansion (simple utility function)
 */
export declare function processSlashCommand(prompt: string): AutoSlashCommandResult;
//# sourceMappingURL=index.d.ts.map
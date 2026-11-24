/**
 * Auto Slash Command Executor
 *
 * Discovers and executes slash commands from various sources.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */
import type { ParsedSlashCommand, CommandInfo, CommandScope, ExecuteResult } from './types.js';
/**
 * Discover all available commands from multiple sources
 */
export declare function discoverAllCommands(): CommandInfo[];
/**
 * Find a specific command by name
 */
export declare function findCommand(commandName: string): CommandInfo | null;
/**
 * Execute a slash command and return replacement text
 */
export declare function executeSlashCommand(parsed: ParsedSlashCommand): ExecuteResult;
/**
 * List all available commands
 */
export declare function listAvailableCommands(): Array<{
    name: string;
    description: string;
    scope: CommandScope;
}>;
export declare function listAvailableCommandsWithOptions(options?: {
    includeAliases?: boolean;
}): Array<{
    name: string;
    description: string;
    scope: CommandScope;
}>;
//# sourceMappingURL=executor.d.ts.map
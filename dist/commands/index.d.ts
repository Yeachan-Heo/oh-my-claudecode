/**
 * Command Expansion Utilities
 *
 * Provides SDK-compatible access to slash commands by reading
 * command templates and expanding them with arguments.
 */
export interface CommandInfo {
    name: string;
    description: string;
    template: string;
    filePath: string;
}
export interface ExpandedCommand {
    name: string;
    prompt: string;
    description: string;
}
/**
 * Get the commands directory path
 */
export declare function getCommandsDir(): string;
/**
 * Get a specific command by name
 */
export declare function getCommand(name: string): CommandInfo | null;
/**
 * Get all available commands
 */
export declare function getAllCommands(): CommandInfo[];
/**
 * List available command names
 */
export declare function listCommands(): string[];
/**
 * Expand a command template with arguments
 *
 * @param name - Command name (without leading slash)
 * @param args - Arguments to substitute for $ARGUMENTS
 * @returns Expanded command ready for SDK query
 *
 * @example
 * ```typescript
 * import { expandCommand } from 'oh-my-claudecode';
 *
 * const prompt = expandCommand('ralph', 'Build a REST API');
 * // Returns the full ralph template with "Build a REST API" substituted
 * ```
 */
export declare function expandCommand(name: string, args?: string): ExpandedCommand | null;
/**
 * Expand a command and return just the prompt string
 * Convenience function for direct use with SDK query
 *
 * @example
 * ```typescript
 * import { expandCommandPrompt } from 'oh-my-claudecode';
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 *
 * const prompt = expandCommandPrompt('ultrawork', 'Refactor the auth module');
 *
 * for await (const msg of query({ prompt })) {
 *   console.log(msg);
 * }
 * ```
 */
export declare function expandCommandPrompt(name: string, args?: string): string | null;
/**
 * Check if a command exists
 */
export declare function commandExists(name: string): boolean;
/**
 * Batch expand multiple commands
 */
export declare function expandCommands(commands: Array<{
    name: string;
    args?: string;
}>): ExpandedCommand[];
//# sourceMappingURL=index.d.ts.map
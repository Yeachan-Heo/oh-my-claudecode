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
import { detectSlashCommand, extractPromptText, } from './detector.js';
import { executeSlashCommand, findCommand, listAvailableCommands, } from './executor.js';
import { HOOK_NAME, AUTO_SLASH_COMMAND_TAG_OPEN, AUTO_SLASH_COMMAND_TAG_CLOSE, } from './constants.js';
// Re-export all submodules
export * from './types.js';
export * from './constants.js';
export { detectSlashCommand, extractPromptText, parseSlashCommand, removeCodeBlocks, isExcludedCommand, } from './detector.js';
export { executeSlashCommand, findCommand, discoverAllCommands, listAvailableCommands, } from './executor.js';
/** Track processed commands to avoid duplicate expansion */
const sessionProcessedCommands = new Set();
/**
 * Create auto slash command hook handlers
 */
export function createAutoSlashCommandHook() {
    return {
        /**
         * Hook name identifier
         */
        name: HOOK_NAME,
        /**
         * Process a user message to detect and expand slash commands
         */
        processMessage: (input, parts) => {
            const promptText = extractPromptText(parts);
            // Skip if already processed (contains our tags)
            if (promptText.includes(AUTO_SLASH_COMMAND_TAG_OPEN) ||
                promptText.includes(AUTO_SLASH_COMMAND_TAG_CLOSE)) {
                return { detected: false };
            }
            const parsed = detectSlashCommand(promptText);
            if (!parsed) {
                return { detected: false };
            }
            // Deduplicate within session
            const commandKey = `${input.sessionId}:${input.messageId}:${parsed.command}`;
            if (sessionProcessedCommands.has(commandKey)) {
                return { detected: false };
            }
            sessionProcessedCommands.add(commandKey);
            // Execute the command
            const result = executeSlashCommand(parsed);
            if (result.success && result.replacementText) {
                const taggedContent = `${AUTO_SLASH_COMMAND_TAG_OPEN}\n${result.replacementText}\n${AUTO_SLASH_COMMAND_TAG_CLOSE}`;
                return {
                    detected: true,
                    parsedCommand: parsed,
                    injectedMessage: taggedContent,
                };
            }
            // Command not found or error
            const errorMessage = `${AUTO_SLASH_COMMAND_TAG_OPEN}\n[AUTO-SLASH-COMMAND ERROR]\n${result.error}\n\nOriginal input: ${parsed.raw}\n${AUTO_SLASH_COMMAND_TAG_CLOSE}`;
            return {
                detected: true,
                parsedCommand: parsed,
                injectedMessage: errorMessage,
            };
        },
        /**
         * Get list of available commands
         */
        listCommands: () => {
            return listAvailableCommands();
        },
        /**
         * Find a specific command by name
         */
        findCommand: (name) => {
            return findCommand(name);
        },
        /**
         * Clear processed commands cache for a session
         */
        clearSession: (sessionId) => {
            // Clear all commands for this session
            const keysToDelete = [];
            for (const key of sessionProcessedCommands) {
                if (key.startsWith(`${sessionId}:`)) {
                    keysToDelete.push(key);
                }
            }
            for (const key of keysToDelete) {
                sessionProcessedCommands.delete(key);
            }
        },
    };
}
/**
 * Process a prompt for slash command expansion (simple utility function)
 */
export function processSlashCommand(prompt) {
    const hook = createAutoSlashCommandHook();
    return hook.processMessage({}, [{ type: 'text', text: prompt }]);
}
//# sourceMappingURL=index.js.map
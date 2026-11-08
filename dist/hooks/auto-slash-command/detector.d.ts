/**
 * Auto Slash Command Detector
 *
 * Detects slash commands in user prompts.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */
import type { ParsedSlashCommand } from './types.js';
/**
 * Remove code blocks from text to prevent false positives
 */
export declare function removeCodeBlocks(text: string): string;
/**
 * Parse a slash command from text
 */
export declare function parseSlashCommand(text: string): ParsedSlashCommand | null;
/**
 * Check if a command should be excluded from auto-expansion
 */
export declare function isExcludedCommand(command: string): boolean;
/**
 * Detect a slash command in user input text
 * Returns null if no command detected or if command is excluded
 */
export declare function detectSlashCommand(text: string): ParsedSlashCommand | null;
/**
 * Extract text content from message parts array
 */
export declare function extractPromptText(parts: Array<{
    type: string;
    text?: string;
}>): string;
//# sourceMappingURL=detector.d.ts.map
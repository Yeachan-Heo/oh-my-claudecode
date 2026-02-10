/**
 * Magic Keywords Feature
 *
 * Detects special keywords in prompts and activates enhanced behaviors.
 * Patterns ported from oh-my-opencode.
 */
import type { MagicKeyword, PluginConfig } from '../shared/types.js';
/**
 * All built-in magic keyword definitions
 */
export declare const builtInMagicKeywords: MagicKeyword[];
/**
 * Create a magic keyword processor with custom triggers
 */
export declare function createMagicKeywordProcessor(config?: PluginConfig['magicKeywords']): (prompt: string) => string;
/**
 * Check if a prompt contains any magic keywords
 */
export declare function detectMagicKeywords(prompt: string, config?: PluginConfig['magicKeywords']): string[];
/**
 * Extract prompt text from message parts (for hook usage)
 */
export declare function extractPromptText(parts: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
}>): string;
//# sourceMappingURL=magic-keywords.d.ts.map
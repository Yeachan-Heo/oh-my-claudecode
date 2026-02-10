/**
 * Keyword Detector Hook
 *
 * Detects magic keywords in user prompts and returns the appropriate
 * mode message to inject into context.
 *
 * Ported from oh-my-opencode's keyword-detector hook.
 */
export type KeywordType = 'cancel' | 'ralph' | 'autopilot' | 'team' | 'ultrawork' | 'ecomode' | 'pipeline' | 'ralplan' | 'plan' | 'tdd' | 'research' | 'ultrathink' | 'deepsearch' | 'analyze' | 'codex' | 'gemini';
export interface DetectedKeyword {
    type: KeywordType;
    keyword: string;
    position: number;
}
/**
 * Remove code blocks from text to prevent false positives
 * Handles both fenced code blocks and inline code
 */
export declare function removeCodeBlocks(text: string): string;
/**
 * Sanitize text for keyword detection by removing XML tags, URLs, file paths,
 * and code blocks to prevent false positives
 */
export declare function sanitizeForKeywordDetection(text: string): string;
/**
 * Extract prompt text from message parts
 */
export declare function extractPromptText(parts: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
}>): string;
/**
 * Detect keywords in text and return matches with type info
 */
export declare function detectKeywordsWithType(text: string, _agentName?: string): DetectedKeyword[];
/**
 * Check if text contains any magic keyword
 */
export declare function hasKeyword(text: string): boolean;
/**
 * Get all detected keywords with conflict resolution applied
 */
export declare function getAllKeywords(text: string): KeywordType[];
/**
 * Get the highest priority keyword detected with conflict resolution
 */
export declare function getPrimaryKeyword(text: string): DetectedKeyword | null;
//# sourceMappingURL=index.d.ts.map
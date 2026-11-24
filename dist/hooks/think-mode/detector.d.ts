/**
 * Think Mode Detector
 *
 * Detects think/ultrathink keywords in prompts.
 * Supports multiple languages for global accessibility.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */
/**
 * Remove code blocks from text to avoid false positive keyword detection.
 */
export declare function removeCodeBlocks(text: string): string;
/**
 * Detect if text contains a think keyword (excluding code blocks).
 */
export declare function detectThinkKeyword(text: string): boolean;
/**
 * Extract text content from message parts.
 */
export declare function extractPromptText(parts: Array<{
    type: string;
    text?: string;
}>): string;
/**
 * Check if the text contains the ultrathink keyword specifically.
 */
export declare function detectUltrathinkKeyword(text: string): boolean;
//# sourceMappingURL=detector.d.ts.map
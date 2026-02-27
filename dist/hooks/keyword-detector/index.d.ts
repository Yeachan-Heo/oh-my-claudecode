/**
 * Keyword Detector Hook
 *
 * Detects magic keywords in user prompts and returns the appropriate
 * mode message to inject into context.
 *
 * Ported from oh-my-opencode's keyword-detector hook.
 */
import { type TaskSizeResult } from '../task-size-detector/index.js';
export type KeywordType = 'cancel' | 'ralph' | 'autopilot' | 'team' | 'ultrawork' | 'ralplan' | 'tdd' | 'ultrathink' | 'deepsearch' | 'analyze' | 'codex' | 'gemini' | 'ccg';
/** Deprecated keyword types that emit deprecation warnings (removed in #1131). */
export type DeprecatedKeywordType = 'ultrapilot' | 'swarm' | 'pipeline';
export interface DetectedKeyword {
    type: KeywordType;
    keyword: string;
    position: number;
}
/** Deprecation messages for removed modes. */
export declare const DEPRECATION_MESSAGES: Record<DeprecatedKeywordType, string>;
/**
 * Remove code blocks from text to prevent false positives
 * Handles both fenced code blocks and inline code
 */
export declare function removeCodeBlocks(text: string): string;
/**
 * Regex matching non-Latin script characters for prompt translation detection.
 * Uses Unicode script ranges (not raw non-ASCII) to avoid false positives on emoji and accented Latin.
 * Covers: CJK (Japanese/Chinese), Korean, Cyrillic, Arabic, Devanagari, Thai, Myanmar.
 */
export declare const NON_LATIN_SCRIPT_PATTERN: RegExp;
/**
* Sanitize text for keyword detection by removing structural noise.
 * Strips XML tags, URLs, file paths, and code blocks.
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
 * Detect deprecated keywords in text and return deprecation warnings.
 * Returns an array of deprecation messages for any matched deprecated keywords.
 */
export declare function detectDeprecatedKeywords(text: string): string[];
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
 * Options for task-size-aware keyword filtering
 */
export interface TaskSizeFilterOptions {
    /** Enable task-size detection. Default: true */
    enabled?: boolean;
    /** Word count threshold for small tasks. Default: 50 */
    smallWordLimit?: number;
    /** Word count threshold for large tasks. Default: 200 */
    largeWordLimit?: number;
    /** Suppress heavy modes for small tasks. Default: true */
    suppressHeavyModesForSmallTasks?: boolean;
}
/**
 * Result of task-size-aware keyword detection
 */
export interface TaskSizeAwareKeywordsResult {
    keywords: KeywordType[];
    taskSizeResult: TaskSizeResult | null;
    suppressedKeywords: KeywordType[];
}
/**
 * Get all keywords with task-size-based filtering applied.
 * For small tasks, heavy orchestration modes (ralph/autopilot/team/ultrawork etc.)
 * are suppressed to avoid over-orchestration.
 *
 * This is the recommended function to use in the bridge hook for keyword detection.
 */
export declare function getAllKeywordsWithSizeCheck(text: string, options?: TaskSizeFilterOptions): TaskSizeAwareKeywordsResult;
/**
 * Get the highest priority keyword detected with conflict resolution
 */
export declare function getPrimaryKeyword(text: string): DetectedKeyword | null;
/**
 * Execution mode keywords subject to the ralplan-first gate (issue #997).
 * These modes spin up heavy orchestration and should not run on vague requests.
 */
export declare const EXECUTION_GATE_KEYWORDS: Set<KeywordType>;
/**
 * Check if a prompt is underspecified for direct execution.
 * Returns true if the prompt lacks enough specificity for heavy execution modes.
 *
 * Conservative: only gates clearly vague prompts. Borderline cases pass through.
 */
export declare function isUnderspecifiedForExecution(text: string): boolean;
/**
 * Apply the ralplan-first gate (issue #997): if execution keywords are present
 * but the prompt is underspecified, redirect to ralplan.
 *
 * Returns the modified keyword list and gate metadata.
 */
export declare function applyRalplanGate(keywords: KeywordType[], text: string): {
    keywords: KeywordType[];
    gateApplied: boolean;
    gatedKeywords: KeywordType[];
};
//# sourceMappingURL=index.d.ts.map
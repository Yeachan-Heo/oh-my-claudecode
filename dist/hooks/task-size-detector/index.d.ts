/**
 * Task Size Detector
 *
 * Classifies user prompts as small/medium/large to prevent over-orchestration.
 *
 * Issue #790: OMC orchestration modes (ralph, autopilot, team) are overkill for small tasks.
 * This module provides a pre-execution gate that routes small tasks to lightweight paths.
 */
export type TaskSize = 'small' | 'medium' | 'large';
export interface TaskSizeResult {
    size: TaskSize;
    reason: string;
    wordCount: number;
    hasEscapeHatch: boolean;
    escapePrefixUsed?: string;
}
/**
 * Word limit thresholds for task size classification.
 * Prompts under smallLimit are classified as small (unless overridden).
 * Prompts over largeLimit are classified as large.
 */
export interface TaskSizeThresholds {
    smallWordLimit: number;
    largeWordLimit: number;
}
export declare const DEFAULT_THRESHOLDS: TaskSizeThresholds;
/**
 * Count words in a prompt (splits on whitespace).
 */
export declare function countWords(text: string): number;
/**
 * Check if the prompt starts with a lightweight escape hatch prefix.
 * Returns the prefix if found, null otherwise.
 */
export declare function detectEscapeHatch(text: string): string | null;
/**
 * Check for small task signal patterns (single file, typo, minor, etc.)
 */
export declare function hasSmallTaskSignals(text: string): boolean;
/**
 * Check for large task signal patterns (architecture, refactor, entire codebase, etc.)
 */
export declare function hasLargeTaskSignals(text: string): boolean;
/**
 * Classify a user prompt as small, medium, or large.
 *
 * Classification rules (in priority order):
 * 1. Escape hatch prefix (`quick:`, `simple:`, etc.) → always small
 * 2. Large task signals (architecture, refactor, entire codebase) → large
 * 3. Prompt > largeWordLimit words → large
 * 4. Small task signals (typo, single file, rename) AND prompt < largeWordLimit → small
 * 5. Prompt < smallWordLimit words → small
 * 6. Everything else → medium
 */
export declare function classifyTaskSize(text: string, thresholds?: TaskSizeThresholds): TaskSizeResult;
/**
 * Heavy orchestration keyword types that should be suppressed for small tasks.
 * These modes spin up multiple agents and are overkill for single-file/minor changes.
 */
export declare const HEAVY_MODE_KEYWORDS: Set<string>;
/**
 * Check if a keyword type is a heavy orchestration mode.
 */
export declare function isHeavyMode(keywordType: string): boolean;
//# sourceMappingURL=index.d.ts.map
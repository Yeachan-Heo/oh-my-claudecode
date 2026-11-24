/**
 * Ralph Progress Log Support
 *
 * Implements append-only progress tracking using progress.txt format from original Ralph.
 * This provides memory persistence between ralph iterations.
 *
 * Structure:
 * - Codebase Patterns section at top (consolidated learnings)
 * - Per-story progress entries appended
 * - Learnings captured for future iterations
 */
export interface ProgressEntry {
    /** ISO timestamp */
    timestamp: string;
    /** Story ID (e.g., "US-001") */
    storyId: string;
    /** What was implemented */
    implementation: string[];
    /** Files changed */
    filesChanged: string[];
    /** Learnings for future iterations */
    learnings: string[];
}
export interface CodebasePattern {
    /** The pattern description */
    pattern: string;
    /** When it was discovered */
    discoveredAt?: string;
}
export interface ProgressLog {
    /** Consolidated codebase patterns at top */
    patterns: CodebasePattern[];
    /** Progress entries (append-only) */
    entries: ProgressEntry[];
    /** When the log was started */
    startedAt: string;
}
export declare const PROGRESS_FILENAME = "progress.txt";
export declare const PATTERNS_HEADER = "## Codebase Patterns";
export declare const ENTRY_SEPARATOR = "---";
/**
 * Get the path to progress.txt in a directory
 */
export declare function getProgressPath(directory: string): string;
/**
 * Get the path to progress.txt in .omc subdirectory
 */
export declare function getOmcProgressPath(directory: string): string;
/**
 * Find progress.txt in a directory (checks both root and .omc)
 */
export declare function findProgressPath(directory: string): string | null;
/**
 * Read raw progress.txt content
 */
export declare function readProgressRaw(directory: string): string | null;
/**
 * Parse progress.txt content into structured format
 */
export declare function parseProgress(content: string): ProgressLog;
/**
 * Read and parse progress.txt
 */
export declare function readProgress(directory: string): ProgressLog | null;
/**
 * Initialize a new progress.txt file
 */
export declare function initProgress(directory: string): boolean;
/**
 * Append a progress entry
 */
export declare function appendProgress(directory: string, entry: Omit<ProgressEntry, 'timestamp'>): boolean;
/**
 * Add a codebase pattern to the patterns section
 * @param retryCount - Internal retry counter to prevent infinite recursion
 */
export declare function addPattern(directory: string, pattern: string, retryCount?: number): boolean;
/**
 * Get patterns from progress.txt for injection into context
 */
export declare function getPatterns(directory: string): string[];
/**
 * Get recent learnings for context injection
 */
export declare function getRecentLearnings(directory: string, limit?: number): string[];
/**
 * Format patterns for context injection
 */
export declare function formatPatternsForContext(directory: string): string;
/**
 * Format recent progress for context injection
 */
export declare function formatProgressForContext(directory: string, limit?: number): string;
/**
 * Format learnings for context injection
 */
export declare function formatLearningsForContext(directory: string): string;
/**
 * Get full context injection for ralph
 */
export declare function getProgressContext(directory: string): string;
//# sourceMappingURL=progress.d.ts.map
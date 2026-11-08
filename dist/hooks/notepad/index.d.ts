/**
 * Notepad Support
 *
 * Implements compaction-resilient memory persistence using notepad.md format.
 * Provides a three-tier memory system:
 * 1. Priority Context - Always loaded, critical discoveries (max 500 chars)
 * 2. Working Memory - Session notes, auto-pruned after 7 days
 * 3. MANUAL - User content, never auto-pruned
 *
 * Structure:
 * ```markdown
 * # Notepad
 * <!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->
 *
 * ## Priority Context
 * <!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->
 *
 * ## Working Memory
 * <!-- Session notes. Auto-pruned after 7 days. -->
 *
 * ## MANUAL
 * <!-- User content. Never auto-pruned. -->
 * ```
 */
export interface NotepadConfig {
    /** Maximum characters for Priority Context section */
    priorityMaxChars: number;
    /** Days to keep Working Memory entries before pruning */
    workingMemoryDays: number;
    /** Maximum total file size in bytes */
    maxTotalSize: number;
}
export interface NotepadStats {
    /** Whether notepad.md exists */
    exists: boolean;
    /** Total file size in bytes */
    totalSize: number;
    /** Priority Context section size in bytes */
    prioritySize: number;
    /** Number of Working Memory entries */
    workingMemoryEntries: number;
    /** ISO timestamp of oldest Working Memory entry */
    oldestEntry: string | null;
}
export interface PriorityContextResult {
    /** Whether the operation succeeded */
    success: boolean;
    /** Warning message if content exceeds limit */
    warning?: string;
}
export interface PruneResult {
    /** Number of entries pruned */
    pruned: number;
    /** Number of entries remaining */
    remaining: number;
}
export declare const NOTEPAD_FILENAME = "notepad.md";
export declare const DEFAULT_CONFIG: NotepadConfig;
export declare const PRIORITY_HEADER = "## Priority Context";
export declare const WORKING_MEMORY_HEADER = "## Working Memory";
export declare const MANUAL_HEADER = "## MANUAL";
/**
 * Get the path to notepad.md in .omc subdirectory
 */
export declare function getNotepadPath(directory: string): string;
/**
 * Initialize notepad.md if it doesn't exist
 */
export declare function initNotepad(directory: string): boolean;
/**
 * Read entire notepad content
 */
export declare function readNotepad(directory: string): string | null;
/**
 * Get Priority Context section only (for injection)
 */
export declare function getPriorityContext(directory: string): string | null;
/**
 * Get Working Memory section
 */
export declare function getWorkingMemory(directory: string): string | null;
/**
 * Get MANUAL section
 */
export declare function getManualSection(directory: string): string | null;
/**
 * Add/update Priority Context (replaces content, warns if over limit)
 */
export declare function setPriorityContext(directory: string, content: string, config?: NotepadConfig): PriorityContextResult;
/**
 * Add entry to Working Memory with timestamp
 */
export declare function addWorkingMemoryEntry(directory: string, content: string): boolean;
/**
 * Add to MANUAL section
 */
export declare function addManualEntry(directory: string, content: string): boolean;
/**
 * Prune Working Memory entries older than N days
 */
export declare function pruneOldEntries(directory: string, daysOld?: number): PruneResult;
/**
 * Get notepad stats
 */
export declare function getNotepadStats(directory: string): NotepadStats;
/**
 * Format context for injection into session
 */
export declare function formatNotepadContext(directory: string): string | null;
/**
 * Format full notepad for display
 */
export declare function formatFullNotepad(directory: string): string | null;
//# sourceMappingURL=index.d.ts.map
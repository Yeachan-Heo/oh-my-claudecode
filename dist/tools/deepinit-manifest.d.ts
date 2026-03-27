/**
 * Deepinit Manifest Tool
 *
 * Deterministic, code-level manifest system for incremental /deepinit.
 * Tracks directory file lists so subsequent runs only regenerate AGENTS.md
 * for directories whose structure has actually changed.
 *
 * Actions:
 * - diff: Compare current filesystem to saved manifest
 * - save: Write current filesystem state as manifest
 * - check: Return whether manifest exists and is valid
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1719
 */
import { z } from 'zod';
import type { ToolDefinition } from './types.js';
/** Sorted file list for a single directory */
interface DirectoryEntry {
    readonly files: readonly string[];
}
/** The persisted manifest structure */
interface DeepInitManifest {
    readonly version: 1;
    readonly generatedAt: string;
    readonly directories: Readonly<Record<string, DirectoryEntry>>;
}
/** Change status for a directory */
type ChangeStatus = 'added' | 'deleted' | 'modified' | 'unchanged';
/** Diff result for a single directory */
interface DiffEntry {
    readonly path: string;
    readonly status: ChangeStatus;
    readonly reason?: string;
}
/** Full diff result */
interface DiffResult {
    readonly entries: readonly DiffEntry[];
    readonly summary: {
        readonly total: number;
        readonly added: number;
        readonly deleted: number;
        readonly modified: number;
        readonly unchanged: number;
    };
}
declare const deepinitManifestSchema: {
    action: z.ZodEnum<["diff", "save", "check"]>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    mode: z.ZodDefault<z.ZodOptional<z.ZodEnum<["incremental", "full"]>>>;
    dryRun: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
};
/**
 * Returns true if a directory name should be excluded from scanning.
 * Excludes all hidden directories (starting with '.') and known build/dependency dirs.
 */
export declare function isExcluded(name: string): boolean;
/**
 * Recursively scan a project directory and build a record of directory → file list.
 * - Skips excluded directories via isExcluded()
 * - Skips empty directories (no files)
 * - Uses inode tracking to prevent symlink loops
 * - File lists are sorted alphabetically for deterministic comparison
 * - All paths use '/' separator regardless of platform
 *
 * @param projectRoot Absolute path to the project root
 * @returns Record keyed by relative path ('.' for root), value is DirectoryEntry
 */
export declare function scanDirectories(projectRoot: string): Record<string, DirectoryEntry>;
/**
 * Load and parse a manifest file.
 * Returns null if file doesn't exist, is unreadable, fails JSON parse,
 * or has an incompatible version.
 */
export declare function loadManifest(manifestPath: string): DeepInitManifest | null;
/**
 * Compute the diff between a previous manifest state and the current directory tree.
 * - If previous is null, all current directories are 'added' (first run)
 * - Applies ancestor cascading: when a child is added/deleted, all ancestor
 *   directories are marked 'modified' (to update their Subdirectories table)
 *
 * @param previous Previous directory state (null = first run)
 * @param current Current directory state from scanDirectories()
 * @returns DiffResult with entries sorted by path
 */
export declare function computeDiff(previous: Readonly<Record<string, DirectoryEntry>> | null, current: Readonly<Record<string, DirectoryEntry>>): DiffResult;
export declare const deepinitManifestTool: ToolDefinition<typeof deepinitManifestSchema>;
export {};
//# sourceMappingURL=deepinit-manifest.d.ts.map
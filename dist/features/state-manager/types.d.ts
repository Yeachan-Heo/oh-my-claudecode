/**
 * State Manager Types
 *
 * Type definitions for unified state management across
 * local (.omc/state/) and global (~/.omc/state/) locations.
 */
/**
 * Location where state should be stored
 */
export declare enum StateLocation {
    /** Local project state: .omc/state/{name}.json */
    LOCAL = "local",
    /** Global user state: ~/.omc/state/{name}.json */
    GLOBAL = "global"
}
/**
 * Configuration for state operations
 */
export interface StateConfig {
    /** State file name (without .json extension) */
    name: string;
    /** Where to store the state */
    location: StateLocation;
    /** Whether to create directories if they don't exist */
    createDirs?: boolean;
    /** Whether to check legacy locations when reading */
    checkLegacy?: boolean;
}
/**
 * Result of a state read operation
 */
export interface StateReadResult<T = unknown> {
    /** Whether state was found */
    exists: boolean;
    /** The state data (if found) */
    data?: T;
    /** Where the state was found */
    foundAt?: string;
    /** Legacy location that was checked */
    legacyLocations?: string[];
}
/**
 * Result of a state write operation
 */
export interface StateWriteResult {
    /** Whether write was successful */
    success: boolean;
    /** Path where state was written */
    path: string;
    /** Error message if failed */
    error?: string;
}
/**
 * Result of a state clear operation
 */
export interface StateClearResult {
    /** Paths that were removed */
    removed: string[];
    /** Paths that didn't exist */
    notFound: string[];
    /** Paths that failed to remove */
    errors: Array<{
        path: string;
        error: string;
    }>;
}
/**
 * Result of a state migration operation
 */
export interface StateMigrationResult {
    /** Whether migration occurred */
    migrated: boolean;
    /** Source path (legacy location) */
    from?: string;
    /** Destination path (standard location) */
    to?: string;
    /** Error message if failed */
    error?: string;
}
/**
 * Information about a state file
 */
export interface StateFileInfo {
    /** State name */
    name: string;
    /** Full file path */
    path: string;
    /** Location type */
    location: StateLocation;
    /** File size in bytes */
    size: number;
    /** Last modified timestamp */
    modified: Date;
    /** Whether this is a legacy location */
    isLegacy: boolean;
}
/**
 * Options for listing states
 */
export interface ListStatesOptions {
    /** Filter by location */
    location?: StateLocation;
    /** Include legacy locations */
    includeLegacy?: boolean;
    /** Filter by name pattern (glob) */
    pattern?: string;
}
/**
 * Options for cleanup operation
 */
export interface CleanupOptions {
    /** Maximum age in days for orphaned states */
    maxAgeDays?: number;
    /** Dry run - don't actually delete */
    dryRun?: boolean;
    /** Patterns to exclude from cleanup */
    exclude?: string[];
}
/**
 * Result of cleanup operation
 */
export interface CleanupResult {
    /** Files that were deleted */
    deleted: string[];
    /** Files that would be deleted (dry run) */
    wouldDelete?: string[];
    /** Total space freed in bytes */
    spaceFreed: number;
    /** Errors encountered */
    errors: Array<{
        path: string;
        error: string;
    }>;
}
/**
 * Generic state data structure
 */
export type StateData = Record<string, unknown>;
/**
 * Type guard for StateLocation
 */
export declare function isStateLocation(value: unknown): value is StateLocation;
/**
 * Default state configuration
 */
export declare const DEFAULT_STATE_CONFIG: Partial<StateConfig>;
//# sourceMappingURL=types.d.ts.map
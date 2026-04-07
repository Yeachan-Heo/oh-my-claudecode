/**
 * Cross-Platform Path Utilities
 *
 * Provides utility functions for handling paths across Windows, macOS, and Linux.
 * These utilities ensure paths in configuration files use forward slashes
 * (which work universally) and handle platform-specific directory conventions.
 */
/**
 * Convert a path to use forward slashes (for JSON/config files)
 * This is necessary because settings.json commands are executed
 * by shells that expect forward slashes even on Windows
 */
export declare function toForwardSlash(path: string): string;
/**
 * Get a path suitable for use in shell commands
 * Converts backslashes to forward slashes for cross-platform compatibility
 */
export declare function toShellPath(path: string): string;
/**
 * Get Windows-appropriate data directory
 * Falls back to sensible locations instead of XDG paths
 */
export declare function getDataDir(): string;
/**
 * Get Windows-appropriate config directory
 */
export declare function getConfigDir(): string;
/**
 * Get Windows-appropriate state directory.
 */
export declare function getStateDir(): string;
/**
 * Legacy global OMC directory under the user's home directory.
 */
export declare function getLegacyOmcDir(): string;
/**
 * Global OMC config directory.
 *
 * Precedence:
 * 1. OMC_HOME (existing explicit override)
 * 2. XDG-aware config root on Linux/Unix
 * 3. Legacy ~/.omc elsewhere
 */
export declare function getGlobalOmcConfigRoot(): string;
/**
 * Global OMC state directory.
 *
 * When OMC_HOME is set, preserve that existing override semantics by treating
 * it as the shared root and resolving state beneath it.
 */
export declare function getGlobalOmcStateRoot(): string;
export declare function getGlobalOmcConfigPath(...segments: string[]): string;
export declare function getGlobalOmcStatePath(...segments: string[]): string;
export declare function getLegacyOmcPath(...segments: string[]): string;
export declare function getGlobalOmcConfigCandidates(...segments: string[]): string[];
export declare function getGlobalOmcStateCandidates(...segments: string[]): string[];
/**
 * Get the plugin cache base directory for oh-my-claudecode.
 * This is the directory containing version subdirectories.
 *
 * Structure: <configDir>/plugins/cache/omc/oh-my-claudecode/
 */
export declare function getPluginCacheBase(): string;
/**
 * Safely delete a file, ignoring ENOENT errors.
 * Prevents crashes when cleaning up files that may not exist (Bug #13 fix).
 */
export declare function safeUnlinkSync(filePath: string): boolean;
/**
 * Safely remove a directory recursively, ignoring errors.
 */
export declare function safeRmSync(dirPath: string): boolean;
/**
 * Result of a plugin cache purge operation.
 */
export interface PurgeCacheResult {
    /** Number of stale version directories removed */
    removed: number;
    /** Paths that were removed */
    removedPaths: string[];
    /** Errors encountered (non-fatal) */
    errors: string[];
}
export declare function purgeStalePluginCacheVersions(options?: {
    skipGracePeriod?: boolean;
}): PurgeCacheResult;
//# sourceMappingURL=paths.d.ts.map
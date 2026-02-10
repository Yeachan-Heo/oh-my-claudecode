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
 * Get Claude config directory path
 */
export declare function getClaudeConfigDir(): string;
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
 * Safely delete a file, ignoring ENOENT errors.
 * Prevents crashes when cleaning up files that may not exist (Bug #13 fix).
 */
export declare function safeUnlinkSync(filePath: string): boolean;
/**
 * Safely remove a directory recursively, ignoring errors.
 */
export declare function safeRmSync(dirPath: string): boolean;
//# sourceMappingURL=paths.d.ts.map
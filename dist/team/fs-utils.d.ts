/** Atomic write: write JSON to temp file with permissions, then rename (prevents corruption on crash) */
export declare function atomicWriteJson(filePath: string, data: unknown, mode?: number): void;
/** Write file with explicit permission mode */
export declare function writeFileWithMode(filePath: string, data: string, mode?: number): void;
/** Append to file with explicit permission mode. Creates with mode if file doesn't exist.
 *  Uses O_WRONLY|O_APPEND|O_CREAT to atomically create-or-append in a single syscall,
 *  avoiding TOCTOU race between existence check and write. */
export declare function appendFileWithMode(filePath: string, data: string, mode?: number): void;
/** Create directory with explicit permission mode */
export declare function ensureDirWithMode(dirPath: string, mode?: number): void;
/** Validate that a resolved path is under the expected base directory. Throws if not.
 *  Uses realpathSync to resolve symlinks, preventing symlink-based escapes. */
export declare function validateResolvedPath(resolvedPath: string, expectedBase: string): void;
//# sourceMappingURL=fs-utils.d.ts.map
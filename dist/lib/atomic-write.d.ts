/**
 * Atomic, durable file writes for oh-my-claudecode.
 * Self-contained module with no external dependencies.
 */
/**
 * Create directory recursively (inline implementation).
 * Ensures parent directories exist before creating the target directory.
 *
 * @param dir Directory path to create
 * @param mode Optional permission mode for the directory (e.g. 0o700)
 */
export declare function ensureDirSync(dir: string, mode?: number): void;
/**
 * Write JSON data atomically to a file.
 * Uses temp file + atomic rename pattern to ensure durability.
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @throws Error if JSON serialization fails or write operation fails
 */
export declare function atomicWriteJson(filePath: string, data: unknown): Promise<void>;
/**
 * Write string data atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern with fsync for durability.
 *
 * @param filePath Target file path
 * @param content String content to write
 * @param options Optional settings (mode defaults to 0o600, dirMode for parent directory permissions)
 * @throws Error if write operation fails
 */
export declare function atomicWriteFileSync(filePath: string, content: string, options?: {
    mode?: number;
    dirMode?: number;
}): void;
/**
 * @deprecated Use atomicWriteFileSync instead. This is a compatibility alias.
 */
export declare const atomicWriteSync: typeof atomicWriteFileSync;
/**
 * Write JSON data atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern with fsync for durability.
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @throws Error if JSON serialization fails or write operation fails
 */
export declare function atomicWriteJsonSync(filePath: string, data: unknown): void;
export declare function safeReadJson<T>(filePath: string): Promise<T | null>;
//# sourceMappingURL=atomic-write.d.ts.map
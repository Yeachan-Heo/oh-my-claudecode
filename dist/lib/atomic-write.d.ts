/**
 * Atomic, durable file writes for oh-my-claudecode.
 * Self-contained module with no external dependencies.
 */
import * as fsSync from "fs";
/** Optional basename-based backend for an already-open directory. */
export interface AtomicWriteOperations {
    open(name: string, flags: number, mode?: number): number;
    lstat(name: string): Pick<fsSync.Stats, "dev" | "ino" | "mode" | "nlink" | "isFile">;
    rename(source: string, destination: string): void;
    unlink(name: string): void;
    link(source: string, destination: string): void;
    sync(): void;
}
/**
 * Create directory recursively (inline implementation).
 * Ensures parent directories exist before creating the target directory.
 *
 * @param dir Directory path to create
 */
export declare function ensureDirSync(dir: string): void;
/** Optional hooks used by ownership-fenced publishers at the rename boundary. */
export interface AtomicWriteHooks {
    readonly beforeRename?: () => void;
    readonly afterRename?: () => void;
}
/**
 * Exact file identity. `dev`/`ino` are BigInt because NTFS file IDs are
 * `(sequence << 48) | mftIndex`: once the sequence number reaches 32 the
 * value exceeds Number.MAX_SAFE_INTEGER and a Number `ino` rounds away the
 * low MFT-index bits, so two distinct files can compare equal.
 */
export interface FileIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
}
/** Normalize a stat result (BigInt or Number) into a comparable identity. */
export declare function fileIdentityOf(stats: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
}): FileIdentity;
/**
 * Compare two file identities for equality.
 * On Windows, Node returns real volume serial from fstat but 0 from lstat/stat,
 * so we compare dev only when NOT on Windows OR both dev values are non-zero.
 * Inode comparison is always performed.
 */
export declare function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean;
/**
 * Write JSON data atomically to a file.
 * Uses temp file + atomic rename pattern to ensure durability.
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @throws Error if JSON serialization fails or write operation fails
 */
export declare function atomicWriteJson(filePath: string, data: unknown, hooks?: AtomicWriteHooks): Promise<void>;
/**
 * Write text content atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern to ensure durability.
 *
 * @param filePath Target file path
 * @param content Text content to write
 * @throws Error if write operation fails
 */
export declare function atomicWriteSync(filePath: string, content: string, hooks?: AtomicWriteHooks): void;
/**
 * Read and parse JSON file with error handling.
 * Returns null if file doesn't exist or on parse errors.
 *
 * @param filePath Path to JSON file
 * @returns Parsed JSON data or null on error
 */
/**
 * Write string data atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern with fsync for durability.
 *
 * @param filePath Target file path
 * @param content String content to write
 * @throws Error if write operation fails
 */
export declare function atomicWriteFileSync(filePath: string, content: string, hooks?: AtomicWriteHooks, operations?: AtomicWriteOperations): void;
/**
 * Write JSON data atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern with fsync for durability.
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @throws Error if JSON serialization fails or write operation fails
 */
export declare function atomicWriteJsonSync(filePath: string, data: unknown, hooks?: AtomicWriteHooks, operations?: AtomicWriteOperations): void;
/**
 * Bounded set of independently atomic writes. This is not a multi-file
 * transaction: a crash between renames can expose a prefix of the batch.
 * Every visible file, however, is fully written and durable before return.
 */
export interface AtomicBatchWrite {
    path: string;
    content: string;
    mode?: number;
}
/**
 * Exported for use in other state management functions.
 * Shared file identity comparison that handles Windows dev=0 quirk.
 */
export declare function atomicWriteBatchSync(writes: AtomicBatchWrite[], hooks?: AtomicWriteHooks): void;
export declare function safeReadJson<T>(filePath: string): Promise<T | null>;
//# sourceMappingURL=atomic-write.d.ts.map
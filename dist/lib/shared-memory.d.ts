/**
 * Shared Memory State Layer
 *
 * Filesystem-based key-value store for cross-session memory sync
 * between agents in /team and /pipeline workflows.
 *
 * Storage: .omc/state/shared-memory/{namespace}/{key}.json
 *
 * Each entry is a JSON file containing:
 * - key: string identifier
 * - value: arbitrary JSON-serializable data
 * - namespace: grouping identifier (session group, pipeline run, etc.)
 * - createdAt: ISO timestamp
 * - updatedAt: ISO timestamp
 * - ttl: optional time-to-live in seconds
 * - expiresAt: optional ISO timestamp (computed from ttl)
 *
 * @see https://github.com/anthropics/oh-my-claudecode/issues/1119
 */
export interface SharedMemoryEntry {
    key: string;
    value: unknown;
    namespace: string;
    createdAt: string;
    updatedAt: string;
    /** TTL in seconds. Omitted or 0 means no expiry. */
    ttl?: number;
    /** Absolute expiry timestamp (ISO). Computed from ttl on write. */
    expiresAt?: string;
}
export interface SharedMemoryListItem {
    key: string;
    updatedAt: string;
    expiresAt?: string;
}
/**
 * Check if shared memory is enabled via config.
 *
 * Reads `agents.sharedMemory.enabled` from
 * `[$CLAUDE_CONFIG_DIR|~/.claude]/.omc-config.json`.
 * Defaults to true when the config key is absent (opt-out rather than opt-in
 * once the feature ships, but tools check this gate).
 */
export declare function isSharedMemoryEnabled(): boolean;
/**
 * Write a key-value pair to shared memory.
 *
 * Creates or updates the entry. If ttl is provided, computes expiresAt.
 */
export declare function writeEntry(namespace: string, key: string, value: unknown, ttl?: number, worktreeRoot?: string): SharedMemoryEntry;
/**
 * Read a key from shared memory.
 *
 * Returns null if the key doesn't exist or has expired.
 * Expired entries are automatically deleted on read.
 */
export declare function readEntry(namespace: string, key: string, worktreeRoot?: string): SharedMemoryEntry | null;
/**
 * List all keys in a namespace.
 *
 * Expired entries are filtered out (but not deleted during list).
 */
export declare function listEntries(namespace: string, worktreeRoot?: string): SharedMemoryListItem[];
/**
 * Delete a specific key from shared memory.
 *
 * Returns true if the key existed and was deleted.
 */
export declare function deleteEntry(namespace: string, key: string, worktreeRoot?: string): boolean;
/**
 * Clean up expired entries in a namespace (or all namespaces).
 *
 * Returns the count of entries removed.
 */
export declare function cleanupExpired(namespace?: string, worktreeRoot?: string): {
    removed: number;
    namespaces: string[];
};
/**
 * List all namespaces that have shared memory entries.
 */
export declare function listNamespaces(worktreeRoot?: string): string[];
//# sourceMappingURL=shared-memory.d.ts.map
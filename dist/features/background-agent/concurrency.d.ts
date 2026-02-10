/**
 * Background Agent Concurrency Manager
 *
 * Manages concurrency limits for background tasks.
 *
 * Adapted from oh-my-opencode's background-agent feature.
 */
import type { BackgroundTaskConfig } from './types.js';
/**
 * Manages concurrency limits for background tasks.
 * Provides acquire/release semantics with queueing.
 */
export declare class ConcurrencyManager {
    private config?;
    private counts;
    private queues;
    constructor(config?: BackgroundTaskConfig);
    /**
     * Get the concurrency limit for a given key (model/agent name)
     */
    getConcurrencyLimit(key: string): number;
    /**
     * Acquire a slot for the given key.
     * Returns immediately if under limit, otherwise queues the request.
     */
    acquire(key: string): Promise<void>;
    /**
     * Release a slot for the given key.
     * If there are queued requests, resolves the next one.
     */
    release(key: string): void;
    /**
     * Get current count for a key
     */
    getCount(key: string): number;
    /**
     * Get queue length for a key
     */
    getQueueLength(key: string): number;
    /**
     * Check if a key is at capacity
     */
    isAtCapacity(key: string): boolean;
    /**
     * Get all active keys and their counts
     */
    getActiveCounts(): Map<string, number>;
    /**
     * Clear all counts and queues
     */
    clear(): void;
}
//# sourceMappingURL=concurrency.d.ts.map
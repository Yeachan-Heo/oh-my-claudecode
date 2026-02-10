/**
 * Background Agent Concurrency Manager
 *
 * Manages concurrency limits for background tasks.
 *
 * Adapted from oh-my-opencode's background-agent feature.
 */
/**
 * Manages concurrency limits for background tasks.
 * Provides acquire/release semantics with queueing.
 */
export class ConcurrencyManager {
    config;
    counts = new Map();
    queues = new Map();
    constructor(config) {
        this.config = config;
    }
    /**
     * Get the concurrency limit for a given key (model/agent name)
     */
    getConcurrencyLimit(key) {
        // Check model-specific limit
        const modelLimit = this.config?.modelConcurrency?.[key];
        if (modelLimit !== undefined) {
            return modelLimit === 0 ? Infinity : modelLimit;
        }
        // Check provider-specific limit (first part of key before /)
        const provider = key.split('/')[0];
        const providerLimit = this.config?.providerConcurrency?.[provider];
        if (providerLimit !== undefined) {
            return providerLimit === 0 ? Infinity : providerLimit;
        }
        // Fall back to default
        const defaultLimit = this.config?.defaultConcurrency;
        if (defaultLimit !== undefined) {
            return defaultLimit === 0 ? Infinity : defaultLimit;
        }
        // Default to 5 concurrent tasks per key
        return 5;
    }
    /**
     * Acquire a slot for the given key.
     * Returns immediately if under limit, otherwise queues the request.
     */
    async acquire(key) {
        const limit = this.getConcurrencyLimit(key);
        if (limit === Infinity) {
            return;
        }
        const current = this.counts.get(key) ?? 0;
        if (current < limit) {
            this.counts.set(key, current + 1);
            return;
        }
        // Queue the request
        return new Promise((resolve) => {
            const queue = this.queues.get(key) ?? [];
            queue.push(resolve);
            this.queues.set(key, queue);
        });
    }
    /**
     * Release a slot for the given key.
     * If there are queued requests, resolves the next one.
     */
    release(key) {
        const limit = this.getConcurrencyLimit(key);
        if (limit === Infinity) {
            return;
        }
        const queue = this.queues.get(key);
        if (queue && queue.length > 0) {
            // Resolve next queued request
            const next = queue.shift();
            next();
        }
        else {
            // Decrement count
            const current = this.counts.get(key) ?? 0;
            if (current > 0) {
                this.counts.set(key, current - 1);
            }
        }
    }
    /**
     * Get current count for a key
     */
    getCount(key) {
        return this.counts.get(key) ?? 0;
    }
    /**
     * Get queue length for a key
     */
    getQueueLength(key) {
        return this.queues.get(key)?.length ?? 0;
    }
    /**
     * Check if a key is at capacity
     */
    isAtCapacity(key) {
        const limit = this.getConcurrencyLimit(key);
        if (limit === Infinity)
            return false;
        return (this.counts.get(key) ?? 0) >= limit;
    }
    /**
     * Get all active keys and their counts
     */
    getActiveCounts() {
        return new Map(this.counts);
    }
    /**
     * Clear all counts and queues
     */
    clear() {
        this.counts.clear();
        this.queues.clear();
    }
}
//# sourceMappingURL=concurrency.js.map
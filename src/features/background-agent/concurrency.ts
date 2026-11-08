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
export class ConcurrencyManager {
  private config?: BackgroundTaskConfig;
  private counts: Map<string, number> = new Map();
  private queues: Map<string, Array<() => void>> = new Map();

  constructor(config?: BackgroundTaskConfig) {
    this.config = config;
  }

  /**
   * Get the concurrency limit for a given key (model/agent name)
   */
  getConcurrencyLimit(key: string): number {
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
  async acquire(key: string): Promise<void> {
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
    return new Promise<void>((resolve) => {
      const queue = this.queues.get(key) ?? [];
      queue.push(resolve);
      this.queues.set(key, queue);
    });
  }

  /**
   * Release a slot for the given key.
   * If there are queued requests, resolves the next one.
   */
  release(key: string): void {
    const limit = this.getConcurrencyLimit(key);
    if (limit === Infinity) {
      return;
    }

    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      // Resolve next queued request
      const next = queue.shift()!;
      next();
    } else {
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
  getCount(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /**
   * Get queue length for a key
   */
  getQueueLength(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  /**
   * Check if a key is at capacity
   */
  isAtCapacity(key: string): boolean {
    const limit = this.getConcurrencyLimit(key);
    if (limit === Infinity) return false;
    return (this.counts.get(key) ?? 0) >= limit;
  }

  /**
   * Get all active keys and their counts
   */
  getActiveCounts(): Map<string, number> {
    return new Map(this.counts);
  }

  /**
   * Clear all counts and queues
   */
  clear(): void {
    this.counts.clear();
    this.queues.clear();
  }
}

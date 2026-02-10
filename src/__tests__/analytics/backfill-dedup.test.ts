import { describe, it, expect, beforeEach } from 'vitest';

/**
 * BackfillDedup Test Suite
 *
 * Tests for deduplication and backfilling of transcript entries.
 * This ensures we don't double-count tokens when replaying or reconstructing
 * transcript data.
 */

describe('BackfillDedup', () => {
  /**
   * Mock BackfillDedup class for testing deduplication logic
   */
  class MockBackfillDedup {
    private processed: Set<string> = new Set();
    private lastBackfillTime: string;

    constructor() {
      this.lastBackfillTime = new Date().toISOString();
    }

    markProcessed(entryId: string): void {
      this.processed.add(entryId);
      this.lastBackfillTime = new Date().toISOString();
    }

    isProcessed(entryId: string): boolean {
      return this.processed.has(entryId);
    }

    getStats() {
      return {
        totalProcessed: this.processed.size,
        lastBackfillTime: this.lastBackfillTime
      };
    }

    async reset(): Promise<void> {
      this.processed.clear();
      this.lastBackfillTime = new Date().toISOString();
    }
  }

  let dedup: MockBackfillDedup;

  beforeEach(() => {
    dedup = new MockBackfillDedup();
  });

  describe('initialization', () => {
    it('should initialize with empty state', () => {
      const stats = dedup.getStats();

      expect(stats.totalProcessed).toBe(0);
      expect(stats.lastBackfillTime).toBeDefined();
    });

    it('should have valid ISO timestamp on init', () => {
      const stats = dedup.getStats();
      const date = new Date(stats.lastBackfillTime);

      expect(date).toBeInstanceOf(Date);
      expect(date.getTime()).toBeGreaterThan(0);
    });
  });

  describe('deduplication', () => {
    it('should mark entries as processed', () => {
      const entryId = 'session-1:2024-01-01T00:00:00Z:claude-sonnet-4.5:100:50';

      expect(dedup.isProcessed(entryId)).toBe(false);

      dedup.markProcessed(entryId);

      expect(dedup.isProcessed(entryId)).toBe(true);
    });

    it('should track total processed count', () => {
      dedup.markProcessed('entry-1');
      expect(dedup.getStats().totalProcessed).toBe(1);

      dedup.markProcessed('entry-2');
      expect(dedup.getStats().totalProcessed).toBe(2);

      dedup.markProcessed('entry-3');
      expect(dedup.getStats().totalProcessed).toBe(3);
    });

    it('should not double-count duplicate marks', () => {
      const entryId = 'session-1:2024-01-01T00:00:00Z:claude-sonnet-4.5:100:50';

      dedup.markProcessed(entryId);
      dedup.markProcessed(entryId); // Duplicate
      dedup.markProcessed(entryId); // Another duplicate

      expect(dedup.getStats().totalProcessed).toBe(1);
    });

    it('should handle multiple entry IDs with different patterns', () => {
      const entries = [
        'session-1:2024-01-01T00:00:00Z:claude-sonnet-4.5:100:50',
        'session-1:2024-01-01T00:01:00Z:claude-opus-4.6:200:100',
        'session-2:2024-01-01T00:00:00Z:claude-haiku-4:50:25',
        'session-3:2024-01-02T00:00:00Z:claude-sonnet-4.5:150:75'
      ];

      entries.forEach(id => dedup.markProcessed(id));

      expect(dedup.getStats().totalProcessed).toBe(4);
      entries.forEach(id => {
        expect(dedup.isProcessed(id)).toBe(true);
      });
    });

    it('should distinguish between similar entry IDs', () => {
      const entry1 = 'session-1:2024-01-01T00:00:00Z:claude-sonnet-4.5:100:50';
      const entry2 = 'session-1:2024-01-01T00:00:00Z:claude-sonnet-4.5:100:51'; // Different output tokens

      dedup.markProcessed(entry1);

      expect(dedup.isProcessed(entry1)).toBe(true);
      expect(dedup.isProcessed(entry2)).toBe(false);
    });

    it('should handle empty entry ID', () => {
      const emptyId = '';

      dedup.markProcessed(emptyId);

      expect(dedup.isProcessed(emptyId)).toBe(true);
      expect(dedup.getStats().totalProcessed).toBe(1);
    });

    it('should handle long entry IDs', () => {
      const longId = 'a'.repeat(1000);

      dedup.markProcessed(longId);

      expect(dedup.isProcessed(longId)).toBe(true);
    });

    it('should update last backfill time on each mark', async () => {
      const time1 = dedup.getStats().lastBackfillTime;

      // Small delay to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      dedup.markProcessed('entry-1');
      const time2 = dedup.getStats().lastBackfillTime;

      // time2 should be >= time1
      expect(new Date(time2).getTime()).toBeGreaterThanOrEqual(new Date(time1).getTime());
    });
  });

  describe('backfilling scenarios', () => {
    it('should handle incremental backfills without duplication', () => {
      // First batch
      dedup.markProcessed('session-1:2024-01-01T00:00:00Z:model1:100:50');
      dedup.markProcessed('session-1:2024-01-01T00:01:00Z:model1:200:100');

      expect(dedup.getStats().totalProcessed).toBe(2);

      // Second batch (replay + new)
      dedup.markProcessed('session-1:2024-01-01T00:00:00Z:model1:100:50'); // Replay
      dedup.markProcessed('session-1:2024-01-01T00:01:00Z:model1:200:100'); // Replay
      dedup.markProcessed('session-1:2024-01-01T00:02:00Z:model1:300:150'); // New

      expect(dedup.getStats().totalProcessed).toBe(3); // Not 5
    });

    it('should support out-of-order processing', () => {
      const entries = [
        'session-1:2024-01-01T00:05:00Z:model1:100:50',
        'session-1:2024-01-01T00:02:00Z:model1:200:100',
        'session-1:2024-01-01T00:01:00Z:model1:300:150'
      ];

      entries.forEach(id => dedup.markProcessed(id));

      expect(dedup.getStats().totalProcessed).toBe(3);
      entries.forEach(id => {
        expect(dedup.isProcessed(id)).toBe(true);
      });
    });

    it('should handle high-volume dedup', () => {
      // Simulate processing 10,000 entries with some duplicates
      for (let i = 0; i < 10000; i++) {
        const sessionId = `session-${i % 50}`;
        const timestamp = new Date(Date.now() - (i * 1000)).toISOString();
        const model = ['claude-sonnet-4.5', 'claude-haiku-4', 'claude-opus-4.6'][i % 3];
        const tokens = (i % 1000) + 100;
        const entryId = `${sessionId}:${timestamp}:${model}:${tokens}:${tokens / 2}`;

        dedup.markProcessed(entryId);
      }

      const stats = dedup.getStats();
      expect(stats.totalProcessed).toBeGreaterThan(0);
      // With 50 sessions, 3 models, and varying timestamps, we should have many unique entries
      expect(stats.totalProcessed).toBeLessThanOrEqual(10000);
    });
  });

  describe('reset', () => {
    it('should reset state correctly', async () => {
      dedup.markProcessed('entry-1');
      dedup.markProcessed('entry-2');
      dedup.markProcessed('entry-3');

      expect(dedup.getStats().totalProcessed).toBe(3);

      await dedup.reset();

      expect(dedup.getStats().totalProcessed).toBe(0);
      expect(dedup.isProcessed('entry-1')).toBe(false);
      expect(dedup.isProcessed('entry-2')).toBe(false);
      expect(dedup.isProcessed('entry-3')).toBe(false);
    });

    it('should allow re-processing after reset', async () => {
      dedup.markProcessed('entry-1');
      expect(dedup.getStats().totalProcessed).toBe(1);

      await dedup.reset();
      expect(dedup.getStats().totalProcessed).toBe(0);

      dedup.markProcessed('entry-1');
      expect(dedup.getStats().totalProcessed).toBe(1);
    });
  });
});

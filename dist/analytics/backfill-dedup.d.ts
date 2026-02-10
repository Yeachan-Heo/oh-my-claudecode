export interface DedupIndex {
    processedIds: string[];
    lastBackfillTime: string;
    totalProcessed: number;
}
/**
 * BackfillDedup provides fast deduplication for backfill operations.
 *
 * Uses in-memory Set for O(1) lookups and persists state to disk.
 * Loads existing entries from token-tracking.jsonl on initialization.
 */
export declare class BackfillDedup {
    private processedSet;
    private totalProcessed;
    private lastBackfillTime;
    /**
     * Load existing processed IDs from backfill-index.json and scan token-tracking.jsonl
     */
    load(): Promise<void>;
    /**
     * Generate unique ID for a token usage entry
     * Uses SHA256 hash to match transcript-token-extractor.ts format
     */
    private generateEntryId;
    /**
     * Check if an entry ID has already been processed
     */
    isProcessed(entryId: string): boolean;
    /**
     * Mark an entry ID as processed
     */
    markProcessed(entryId: string): void;
    /**
     * Persist deduplication state to backfill-index.json
     */
    save(): Promise<void>;
    /**
     * Clear all processed entries and delete index file
     */
    reset(): Promise<void>;
    /**
     * Get current statistics
     */
    getStats(): {
        totalProcessed: number;
        lastBackfillTime: string;
    };
}
//# sourceMappingURL=backfill-dedup.d.ts.map
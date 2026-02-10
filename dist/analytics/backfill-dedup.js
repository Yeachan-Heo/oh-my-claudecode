import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
const TOKEN_LOG_FILE = path.join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
const DEDUP_INDEX_FILE = path.join(homedir(), '.omc', 'state', 'backfill-index.json');
/**
 * BackfillDedup provides fast deduplication for backfill operations.
 *
 * Uses in-memory Set for O(1) lookups and persists state to disk.
 * Loads existing entries from token-tracking.jsonl on initialization.
 */
export class BackfillDedup {
    processedSet = new Set();
    totalProcessed = 0;
    lastBackfillTime = new Date().toISOString();
    /**
     * Load existing processed IDs from backfill-index.json and scan token-tracking.jsonl
     */
    async load() {
        // Load persisted index first
        try {
            const indexContent = await fs.readFile(DEDUP_INDEX_FILE, 'utf-8');
            const index = JSON.parse(indexContent);
            this.processedSet = new Set(index.processedIds);
            this.totalProcessed = index.totalProcessed;
            this.lastBackfillTime = index.lastBackfillTime;
        }
        catch (error) {
            // Index doesn't exist yet, will be created on save
        }
        // Scan token-tracking.jsonl to ensure all existing entries are marked
        try {
            const logContent = await fs.readFile(TOKEN_LOG_FILE, 'utf-8');
            const lines = logContent.trim().split('\n').filter(line => line.length > 0);
            for (const line of lines) {
                try {
                    const record = JSON.parse(line);
                    const entryId = this.generateEntryId(record);
                    if (!this.processedSet.has(entryId)) {
                        this.processedSet.add(entryId);
                        this.totalProcessed++;
                    }
                }
                catch (parseError) {
                    // Skip malformed lines
                }
            }
        }
        catch (error) {
            // Log file doesn't exist yet, which is fine
        }
    }
    /**
     * Generate unique ID for a token usage entry
     * Uses SHA256 hash to match transcript-token-extractor.ts format
     */
    generateEntryId(record) {
        const hash = createHash('sha256');
        hash.update(`${record.sessionId}:${record.timestamp}:${record.modelName}`);
        return hash.digest('hex');
    }
    /**
     * Check if an entry ID has already been processed
     */
    isProcessed(entryId) {
        return this.processedSet.has(entryId);
    }
    /**
     * Mark an entry ID as processed
     */
    markProcessed(entryId) {
        if (!this.processedSet.has(entryId)) {
            this.processedSet.add(entryId);
            this.totalProcessed++;
        }
    }
    /**
     * Persist deduplication state to backfill-index.json
     */
    async save() {
        const indexDir = path.dirname(DEDUP_INDEX_FILE);
        await fs.mkdir(indexDir, { recursive: true });
        const index = {
            processedIds: Array.from(this.processedSet),
            lastBackfillTime: new Date().toISOString(),
            totalProcessed: this.totalProcessed
        };
        await fs.writeFile(DEDUP_INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
    }
    /**
     * Clear all processed entries and delete index file
     */
    async reset() {
        this.processedSet.clear();
        this.totalProcessed = 0;
        this.lastBackfillTime = new Date().toISOString();
        try {
            await fs.unlink(DEDUP_INDEX_FILE);
        }
        catch (error) {
            // File might not exist, which is fine
        }
    }
    /**
     * Get current statistics
     */
    getStats() {
        return {
            totalProcessed: this.totalProcessed,
            lastBackfillTime: this.lastBackfillTime
        };
    }
}
//# sourceMappingURL=backfill-dedup.js.map
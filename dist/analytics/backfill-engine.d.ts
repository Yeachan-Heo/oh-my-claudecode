import { EventEmitter } from 'events';
export interface BackfillOptions {
    projectFilter?: string;
    dateFrom?: Date;
    dateTo?: Date;
    dryRun?: boolean;
    verbose?: boolean;
}
export interface BackfillResult {
    filesProcessed: number;
    entriesAdded: number;
    duplicatesSkipped: number;
    errorsEncountered: number;
    totalCostDiscovered: number;
    timeElapsed: number;
}
export interface BackfillProgress {
    currentFile: string;
    filesProcessed: number;
    totalFiles: number;
    entriesAdded: number;
    duplicatesSkipped: number;
    currentCost: number;
}
/**
 * BackfillEngine orchestrates the offline transcript analysis pipeline.
 *
 * Pipeline:
 * 1. Scan for transcripts
 * 2. Parse each transcript file (streaming)
 * 3. Extract token usage from entries
 * 4. Deduplicate
 * 5. Write to token-tracking.jsonl (batch)
 *
 * Emits 'progress' events during execution.
 */
export declare class BackfillEngine extends EventEmitter {
    private aborted;
    private dedup;
    private tracker;
    constructor();
    /**
     * Abort the backfill operation
     */
    abort(): void;
    /**
     * Run the backfill process
     */
    run(options?: BackfillOptions): Promise<BackfillResult>;
    /**
     * Process a single transcript file
     */
    private processTranscript;
    /**
     * Write a batch of token usage entries to the tracker
     */
    private flushBatch;
}
//# sourceMappingURL=backfill-engine.d.ts.map
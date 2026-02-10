import { EventEmitter } from 'events';
import * as path from 'path';
import { scanTranscripts } from './transcript-scanner.js';
import { parseTranscript } from './transcript-parser.js';
import { BackfillDedup } from './backfill-dedup.js';
import { getTokenTracker } from './token-tracker.js';
import { calculateCost } from './cost-estimator.js';
import { extractTokenUsage, extractTaskSpawns } from './transcript-token-extractor.js';
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
export class BackfillEngine extends EventEmitter {
    aborted = false;
    dedup;
    tracker;
    constructor() {
        super();
        this.dedup = new BackfillDedup();
        this.tracker = getTokenTracker();
    }
    /**
     * Abort the backfill operation
     */
    abort() {
        this.aborted = true;
    }
    /**
     * Run the backfill process
     */
    async run(options = {}) {
        const startTime = Date.now();
        this.aborted = false;
        // Load deduplication state
        await this.dedup.load();
        // Scan for transcripts
        const scanResult = await scanTranscripts({
            projectFilter: options.projectFilter,
            minDate: options.dateFrom,
        });
        const result = {
            filesProcessed: 0,
            entriesAdded: 0,
            duplicatesSkipped: 0,
            errorsEncountered: 0,
            totalCostDiscovered: 0,
            timeElapsed: 0,
        };
        const totalFiles = scanResult.transcripts.length;
        // Process each transcript file
        for (const transcript of scanResult.transcripts) {
            if (this.aborted) {
                break;
            }
            // Filter by date range if specified
            if (options.dateTo && transcript.modifiedTime > options.dateTo) {
                continue;
            }
            try {
                await this.processTranscript(transcript, options, result, totalFiles);
            }
            catch (error) {
                result.errorsEncountered++;
                if (options.verbose) {
                    console.error(`Error processing ${transcript.filePath}:`, error);
                }
            }
            result.filesProcessed++;
        }
        // Save deduplication state
        if (!options.dryRun) {
            await this.dedup.save();
        }
        result.timeElapsed = Date.now() - startTime;
        return result;
    }
    /**
     * Process a single transcript file
     */
    async processTranscript(transcript, options, result, totalFiles) {
        const batch = [];
        const BATCH_SIZE = 100;
        // Build a lookup of toolUseId → agentType for attributing progress entries
        // This is populated as we encounter assistant entries with Task tool calls
        const agentLookup = new Map();
        // Emit progress
        this.emit('progress', {
            currentFile: path.basename(transcript.filePath),
            filesProcessed: result.filesProcessed,
            totalFiles,
            entriesAdded: result.entriesAdded,
            duplicatesSkipped: result.duplicatesSkipped,
            currentCost: result.totalCostDiscovered,
        });
        // Parse transcript (streaming)
        for await (const entry of parseTranscript(transcript.filePath, {
            onParseError: (line, error) => {
                result.errorsEncountered++;
                if (options.verbose) {
                    console.warn(`Parse error in ${transcript.filePath}: ${error.message}`);
                }
            },
        })) {
            if (this.aborted) {
                break;
            }
            // Extract Task tool spawns from assistant entries to build agent lookup
            // This must happen BEFORE extractTokenUsage so progress entries can look up their parent
            const spawns = extractTaskSpawns(entry);
            for (const spawn of spawns) {
                agentLookup.set(spawn.toolUseId, spawn.agentType);
            }
            // Extract token usage (passing agentLookup for progress entry attribution)
            const extracted = extractTokenUsage(entry, transcript.sessionId, transcript.filePath, agentLookup);
            if (!extracted) {
                continue; // Skip entries without usage data
            }
            // Check deduplication
            if (this.dedup.isProcessed(extracted.entryId)) {
                result.duplicatesSkipped++;
                continue;
            }
            // Calculate cost
            const cost = calculateCost({
                modelName: extracted.usage.modelName,
                inputTokens: extracted.usage.inputTokens,
                outputTokens: extracted.usage.outputTokens,
                cacheCreationTokens: extracted.usage.cacheCreationTokens,
                cacheReadTokens: extracted.usage.cacheReadTokens,
            });
            result.totalCostDiscovered += cost.totalCost;
            // Add to batch
            batch.push(extracted.usage);
            this.dedup.markProcessed(extracted.entryId);
            result.entriesAdded++;
            // Flush batch if full
            if (batch.length >= BATCH_SIZE && !options.dryRun) {
                await this.flushBatch(batch);
            }
        }
        // Flush remaining entries
        if (batch.length > 0 && !options.dryRun) {
            await this.flushBatch(batch);
        }
    }
    /**
     * Write a batch of token usage entries to the tracker
     */
    async flushBatch(batch) {
        for (const usage of batch) {
            await this.tracker.recordTokenUsage({
                modelName: usage.modelName,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                cacheReadTokens: usage.cacheReadTokens,
                agentName: usage.agentName,
                isEstimated: usage.isEstimated,
            });
        }
        batch.length = 0; // Clear batch
    }
}
//# sourceMappingURL=backfill-engine.js.map
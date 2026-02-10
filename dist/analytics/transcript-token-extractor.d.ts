import type { TokenUsage, TranscriptEntry } from './types.js';
/**
 * Extracted usage with metadata
 */
export interface ExtractedUsage {
    usage: TokenUsage;
    entryId: string;
    sourceFile: string;
}
/**
 * Task spawn info extracted from assistant entries
 */
export interface TaskSpawnInfo {
    toolUseId: string;
    agentType: string;
}
/**
 * Extract Task tool spawn info from an assistant entry.
 * Returns all Task tool calls with their toolUseId and agentType.
 *
 * This is used to build a lookup table for attributing progress entries
 * to the correct agent.
 */
export declare function extractTaskSpawns(entry: TranscriptEntry): TaskSpawnInfo[];
/**
 * Extract token usage from transcript entry
 *
 * @param entry - Transcript entry from JSONL file
 * @param sessionId - Session ID (override if not in entry)
 * @param sourceFile - Source file path for tracking
 * @param agentLookup - Map of toolUseId → agentType for attributing progress entries
 * @returns ExtractedUsage or null if entry has no usage data
 */
export declare function extractTokenUsage(entry: TranscriptEntry, sessionId: string, sourceFile: string, agentLookup?: Map<string, string>): ExtractedUsage | null;
//# sourceMappingURL=transcript-token-extractor.d.ts.map
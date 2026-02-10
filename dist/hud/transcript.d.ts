/**
 * OMC HUD - Transcript Parser
 *
 * Parse JSONL transcript from Claude Code to extract agents and todos.
 * Based on claude-hud reference implementation.
 *
 * Performance optimizations:
 * - Tail-based parsing: reads only the last ~500KB of large transcripts
 * - Bounded agent map: caps at 50 agents during parsing
 * - Early termination: stops when enough running agents found
 */
import type { TranscriptData, ActiveAgent, TodoItem } from "./types.js";
/**
 * Parse a Claude Code transcript JSONL file.
 * Extracts running agents and latest todo list.
 *
 * For large files (>500KB), only parses the tail portion for performance.
 */
export interface ParseTranscriptOptions {
    staleTaskThresholdMinutes?: number;
}
export declare function parseTranscript(transcriptPath: string | undefined, options?: ParseTranscriptOptions): Promise<TranscriptData>;
/**
 * Get count of running agents
 */
export declare function getRunningAgentCount(agents: ActiveAgent[]): number;
/**
 * Get todo completion stats
 */
export declare function getTodoStats(todos: TodoItem[]): {
    completed: number;
    total: number;
    inProgress: number;
};
//# sourceMappingURL=transcript.d.ts.map
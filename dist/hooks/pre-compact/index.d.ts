/**
 * PreCompact Hook - State Preservation Before Context Compaction
 *
 * Creates checkpoints before compaction to preserve critical state including:
 * - Active mode states (autopilot, ralph, ultrawork)
 * - TODO summary
 * - Wisdom from notepads
 *
 * This ensures no critical information is lost during context window compaction.
 */
export interface PreCompactInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: "PreCompact";
    trigger: "manual" | "auto";
    custom_instructions?: string;
}
export interface CompactCheckpoint {
    created_at: string;
    trigger: "manual" | "auto";
    active_modes: {
        autopilot?: {
            phase: string;
            originalIdea: string;
        };
        ralph?: {
            iteration: number;
            prompt: string;
        };
        ultrawork?: {
            original_prompt: string;
        };
        ultraqa?: {
            cycle: number;
            prompt: string;
        };
    };
    todo_summary: {
        pending: number;
        in_progress: number;
        completed: number;
    };
    wisdom_exported: boolean;
    background_jobs?: {
        active: Array<{
            jobId: string;
            provider: string;
            model: string;
            agentRole: string;
            spawnedAt: string;
        }>;
        recent: Array<{
            jobId: string;
            provider: string;
            status: string;
            agentRole: string;
            completedAt?: string;
        }>;
        stats: {
            total: number;
            active: number;
            completed: number;
            failed: number;
        } | null;
    };
}
export interface HookOutput {
    continue: boolean;
    /** System message for context injection (Claude Code compatible) */
    systemMessage?: string;
}
/**
 * Get the checkpoint directory path
 */
export declare function getCheckpointPath(directory: string): string;
/**
 * Export wisdom from notepads to checkpoint
 */
export declare function exportWisdomToNotepad(directory: string): Promise<{
    wisdom: string;
    exported: boolean;
}>;
/**
 * Save summary of active modes
 */
export declare function saveModeSummary(directory: string): Promise<Record<string, unknown>>;
/**
 * Create a compact checkpoint
 */
export declare function createCompactCheckpoint(directory: string, trigger: "manual" | "auto"): Promise<CompactCheckpoint>;
/**
 * Format checkpoint summary for context injection
 */
export declare function formatCompactSummary(checkpoint: CompactCheckpoint): string;
/**
 * Main handler for PreCompact hook.
 *
 * Uses a per-directory mutex to prevent concurrent compaction.
 * When multiple subagent results arrive simultaneously (ultrawork/team),
 * only the first call runs the compaction; subsequent calls await
 * the in-flight result. This fixes issue #453.
 */
export declare function processPreCompact(input: PreCompactInput): Promise<HookOutput>;
/**
 * Check if compaction is currently in progress for a directory.
 * Useful for diagnostics and testing.
 */
export declare function isCompactionInProgress(directory: string): boolean;
/**
 * Get the number of callers queued behind an in-flight compaction.
 * Returns 0 if no compaction is in progress.
 */
export declare function getCompactionQueueDepth(directory: string): number;
export default processPreCompact;
//# sourceMappingURL=index.d.ts.map
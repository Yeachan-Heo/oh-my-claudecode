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
    session_id?: string;
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
    /**
     * Durable plan anchors captured at compaction time (issue #3730).
     *
     * These are references to already-persisted OMC plan artifacts — a PRD
     * (ralph PRD mode) and/or the boulder plan — plus bounded counts. They are
     * pointers, not a copy of plan content, and never conversation data.
     */
    plan_refs?: {
        prd?: {
            path: string;
            title: string;
            status: string;
            stories_total: number;
            stories_completed: number;
        };
        boulder?: {
            active_plan: string;
            plan_name: string;
            progress: {
                total: number;
                completed: number;
                isComplete: boolean;
            };
        };
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
 * Collect durable plan anchors (issue #3730).
 *
 * Captures references to already-persisted plan artifacts so a restored
 * checkpoint can point the post-compaction session back at its plan:
 * - the active PRD (ralph PRD mode), via findPrdPath
 * - the active boulder plan (OMC orchestrator)
 *
 * Only pointers and bounded counts are recorded. Plan file contents are
 * never copied into the checkpoint.
 */
export declare function collectPlanRefs(directory: string, sessionId?: string): CompactCheckpoint["plan_refs"];
/**
 * Create a compact checkpoint
 */
export declare function createCompactCheckpoint(directory: string, trigger: "manual" | "auto", sessionId?: string): Promise<CompactCheckpoint>;
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
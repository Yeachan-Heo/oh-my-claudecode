/**
 * Subagent Tracker Hook Module
 *
 * Tracks SubagentStart and SubagentStop events for comprehensive agent monitoring.
 * Features:
 * - Track all spawned agents with parent mode context
 * - Detect stuck/stale agents (>5 min without progress)
 * - HUD integration for agent status display
 * - Automatic cleanup of orphaned agent state
 */
export interface SubagentInfo {
    agent_id: string;
    agent_type: string;
    started_at: string;
    parent_mode: string;
    task_description?: string;
    file_ownership?: string[];
    status: "running" | "completed" | "failed";
    completed_at?: string;
    duration_ms?: number;
    output_summary?: string;
    tool_usage?: ToolUsageEntry[];
    token_usage?: TokenUsage;
    model?: string;
}
export interface ToolUsageEntry {
    tool_name: string;
    timestamp: string;
    duration_ms?: number;
    success?: boolean;
}
export interface ToolTimingStats {
    count: number;
    avg_ms: number;
    max_ms: number;
    total_ms: number;
    failures: number;
}
export interface AgentPerformance {
    agent_id: string;
    tool_timings: Record<string, ToolTimingStats>;
    token_usage: TokenUsage;
    bottleneck?: string;
    parallel_efficiency?: number;
}
export interface TokenUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
}
export interface SubagentTrackingState {
    agents: SubagentInfo[];
    total_spawned: number;
    total_completed: number;
    total_failed: number;
    last_updated: string;
}
export interface SubagentStartInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: "SubagentStart";
    agent_id: string;
    agent_type: string;
    prompt?: string;
    model?: string;
}
export interface SubagentStopInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: "SubagentStop";
    agent_id: string;
    agent_type: string;
    output?: string;
    /** @deprecated The SDK does not provide a success field. Use inferred status instead. */
    success?: boolean;
}
export interface HookOutput {
    continue: boolean;
    hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
        agent_count?: number;
        stale_agents?: string[];
    };
}
export interface AgentIntervention {
    type: "timeout" | "deadlock" | "excessive_cost" | "file_conflict";
    agent_id: string;
    agent_type: string;
    reason: string;
    suggested_action: "kill" | "restart" | "warn" | "skip";
    auto_execute: boolean;
}
export declare const COST_LIMIT_USD = 1;
export declare const DEADLOCK_CHECK_THRESHOLD = 3;
/**
 * Merge two tracker states with deterministic semantics.
 * Used by debounced flush to combine disk state with in-memory pending state.
 *
 * Merge rules:
 * - Counters (total_spawned, total_completed, total_failed): Math.max
 * - Agents: union by agent_id; if same ID exists in both, newer timestamp wins
 * - last_updated: Math.max of both timestamps
 */
export declare function mergeTrackerStates(diskState: SubagentTrackingState, pendingState: SubagentTrackingState): SubagentTrackingState;
/**
 * Get the state file path
 */
export declare function getStateFilePath(directory: string): string;
/**
 * Read tracking state directly from disk, bypassing the pending writes cache.
 * Used during flush to get the latest on-disk state for merging.
 */
export declare function readDiskState(directory: string): SubagentTrackingState;
/**
 * Read tracking state from file.
 * If there's a pending write for this directory, returns it instead of reading disk.
 */
export declare function readTrackingState(directory: string): SubagentTrackingState;
/**
 * Execute the flush: lock -> re-read disk -> merge -> write -> unlock.
 * Returns true on success, false if lock could not be acquired.
 */
export declare function executeFlush(directory: string, pendingState: SubagentTrackingState): boolean;
/**
 * Write tracking state with debouncing to reduce I/O.
 * The flush callback acquires the lock, re-reads disk state, merges with
 * the pending in-memory delta, and writes atomically.
 * If the lock cannot be acquired, retries with exponential backoff (max 3 retries).
 */
export declare function writeTrackingState(directory: string, state: SubagentTrackingState): void;
/**
 * Flush any pending debounced writes immediately using the merge-aware path.
 * Call this in tests before cleanup to ensure state is persisted.
 */
export declare function flushPendingWrites(): void;
/**
 * Get list of stale agents (running for too long)
 */
export declare function getStaleAgents(state: SubagentTrackingState): SubagentInfo[];
/**
 * Process SubagentStart event
 */
export declare function processSubagentStart(input: SubagentStartInput): HookOutput;
/**
 * Process SubagentStop event
 */
export declare function processSubagentStop(input: SubagentStopInput): HookOutput;
/**
 * Cleanup stale agents (mark as failed)
 */
export declare function cleanupStaleAgents(directory: string): number;
/**
 * Get count of active (running) agents
 */
export declare function getActiveAgentCount(directory: string): number;
/**
 * Get agents by type
 */
export declare function getAgentsByType(directory: string, agentType: string): SubagentInfo[];
/**
 * Get all running agents
 */
export declare function getRunningAgents(directory: string): SubagentInfo[];
/**
 * Get tracking stats
 */
export declare function getTrackingStats(directory: string): {
    running: number;
    completed: number;
    failed: number;
    total: number;
};
/**
 * Record a tool usage event for a specific agent
 * Called from PreToolUse/PostToolUse hooks to track which agent uses which tool
 */
export declare function recordToolUsage(directory: string, agentId: string, toolName: string, success?: boolean): void;
/**
 * Record tool usage with timing data
 * Called from PostToolUse hook with duration information
 */
export declare function recordToolUsageWithTiming(directory: string, agentId: string, toolName: string, durationMs: number, success: boolean): void;
/**
 * Generate a formatted dashboard of all running agents
 * Used for debugging parallel agent execution in ultrawork mode
 */
export declare function getAgentDashboard(directory: string): string;
/**
 * Generate a rich observatory view of all running agents
 * Includes: performance metrics, token usage, file ownership, bottlenecks
 * For HUD integration and debugging parallel agent execution
 */
export declare function getAgentObservatory(directory: string): {
    header: string;
    lines: string[];
    summary: {
        total_agents: number;
        total_cost_usd: number;
        efficiency: number;
        interventions: number;
    };
};
/**
 * Suggest interventions for problematic agents
 * Checks for: stale agents, cost limit exceeded, file conflicts
 */
export declare function suggestInterventions(directory: string): AgentIntervention[];
/**
 * Calculate parallel efficiency score (0-100)
 * 100 = all agents actively running, 0 = all stale/waiting
 */
export declare function calculateParallelEfficiency(directory: string): {
    score: number;
    active: number;
    stale: number;
    total: number;
};
/**
 * Record file ownership when an agent modifies a file
 * Called from PreToolUse hook when Edit/Write tools are used
 */
export declare function recordFileOwnership(directory: string, agentId: string, filePath: string): void;
/**
 * Check for file conflicts between running agents
 * Returns files being modified by more than one agent
 */
export declare function detectFileConflicts(directory: string): Array<{
    file: string;
    agents: string[];
}>;
/**
 * Get all file ownership for running agents
 */
export declare function getFileOwnershipMap(directory: string): Map<string, string>;
/**
 * Get performance metrics for a specific agent
 */
export declare function getAgentPerformance(directory: string, agentId: string): AgentPerformance | null;
/**
 * Get performance for all running agents
 */
export declare function getAllAgentPerformance(directory: string): AgentPerformance[];
/**
 * Update token usage for an agent (called from SubagentStop)
 */
export declare function updateTokenUsage(directory: string, agentId: string, tokens: Partial<TokenUsage>): void;
/**
 * Handle SubagentStart hook
 */
export declare function handleSubagentStart(input: SubagentStartInput): Promise<HookOutput>;
/**
 * Handle SubagentStop hook
 */
export declare function handleSubagentStop(input: SubagentStopInput): Promise<HookOutput>;
/**
 * Clear all tracking state (for testing or cleanup)
 */
export declare function clearTrackingState(directory: string): void;
//# sourceMappingURL=index.d.ts.map
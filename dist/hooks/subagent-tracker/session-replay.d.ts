/**
 * Session Replay Module
 *
 * Records agent lifecycle events as JSONL for timeline visualization
 * and post-session bottleneck analysis.
 *
 * Events are appended to: .omc/state/agent-replay-{sessionId}.jsonl
 */
export type ReplayEventType = 'agent_start' | 'agent_stop' | 'tool_start' | 'tool_end' | 'file_touch' | 'intervention' | 'error' | 'hook_fire' | 'hook_result' | 'keyword_detected' | 'skill_activated' | 'skill_invoked' | 'mode_change';
export interface ReplayEvent {
    /** Seconds since session start */
    t: number;
    /** Agent ID (short) */
    agent: string;
    /** Agent type (without prefix) */
    agent_type?: string;
    /** Event type */
    event: ReplayEventType;
    /** Event-specific data */
    tool?: string;
    file?: string;
    duration_ms?: number;
    task?: string;
    success?: boolean;
    reason?: string;
    parent_mode?: string;
    model?: string;
    /** Hook name (e.g., "keyword-detector") */
    hook?: string;
    /** Claude Code event (e.g., "UserPromptSubmit") */
    hook_event?: string;
    /** Detected keyword */
    keyword?: string;
    /** Activated skill name */
    skill_name?: string;
    /** Skill source */
    skill_source?: string;
    /** Previous mode */
    mode_from?: string;
    /** New mode */
    mode_to?: string;
    /** Whether context was injected */
    context_injected?: boolean;
    /** Injected context size (bytes) */
    context_length?: number;
}
export interface AgentBreakdown {
    type: string;
    count: number;
    total_ms: number;
    avg_ms: number;
    models: string[];
}
export interface ReplaySummary {
    session_id: string;
    duration_seconds: number;
    total_events: number;
    agents_spawned: number;
    agents_completed: number;
    agents_failed: number;
    tool_summary: Record<string, {
        count: number;
        total_ms: number;
        avg_ms: number;
        max_ms: number;
    }>;
    bottlenecks: Array<{
        tool: string;
        agent: string;
        avg_ms: number;
    }>;
    timeline_range: {
        start: number;
        end: number;
    };
    files_touched: string[];
    hooks_fired?: number;
    keywords_detected?: string[];
    skills_activated?: string[];
    skills_invoked?: string[];
    mode_transitions?: Array<{
        from: string;
        to: string;
        at: number;
    }>;
    agent_breakdown?: AgentBreakdown[];
    cycle_count?: number;
    cycle_pattern?: string;
}
/**
 * Get the replay file path for a session
 */
export declare function getReplayFilePath(directory: string, sessionId: string): string;
/**
 * Append a replay event to the JSONL file
 */
export declare function appendReplayEvent(directory: string, sessionId: string, event: Omit<ReplayEvent, 't'>): void;
/**
 * Record agent start event
 */
export declare function recordAgentStart(directory: string, sessionId: string, agentId: string, agentType: string, task?: string, parentMode?: string, model?: string): void;
/**
 * Record agent stop event
 */
export declare function recordAgentStop(directory: string, sessionId: string, agentId: string, agentType: string, success: boolean, durationMs?: number): void;
/**
 * Record tool execution event
 */
export declare function recordToolEvent(directory: string, sessionId: string, agentId: string, toolName: string, eventType: 'tool_start' | 'tool_end', durationMs?: number, success?: boolean): void;
/**
 * Record file touch event
 */
export declare function recordFileTouch(directory: string, sessionId: string, agentId: string, filePath: string): void;
/**
 * Record intervention event
 */
export declare function recordIntervention(directory: string, sessionId: string, agentId: string, reason: string): void;
/**
 * Read all events from a replay file
 */
export declare function readReplayEvents(directory: string, sessionId: string): ReplayEvent[];
/**
 * Detect repeating cycles in an agent type sequence.
 * E.g., [planner, critic, planner, critic] → 2 cycles of "planner/critic"
 * Tries pattern lengths from 2 up to half the sequence length.
 */
export declare function detectCycles(sequence: string[]): {
    cycles: number;
    pattern: string;
};
/**
 * Generate a summary of a replay session for bottleneck analysis
 */
export declare function getReplaySummary(directory: string, sessionId: string): ReplaySummary;
/**
 * Clean up old replay files, keeping only the most recent ones
 */
export declare function cleanupReplayFiles(directory: string): number;
/**
 * Reset session start time cache (for testing)
 */
export declare function resetSessionStartTimes(): void;
//# sourceMappingURL=session-replay.d.ts.map
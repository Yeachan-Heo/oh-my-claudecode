/**
 * Background Agent Types
 *
 * Type definitions for background task management.
 *
 * Adapted from oh-my-opencode's background-agent feature.
 */
/**
 * Status of a background task
 */
export type BackgroundTaskStatus = 'queued' | 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
/**
 * Progress tracking for a background task
 */
export interface TaskProgress {
    /** Number of tool calls made */
    toolCalls: number;
    /** Last tool used */
    lastTool?: string;
    /** Last update timestamp */
    lastUpdate: Date;
    /** Last message content (truncated) */
    lastMessage?: string;
    /** Last message timestamp */
    lastMessageAt?: Date;
}
/**
 * A background task being managed
 */
export interface BackgroundTask {
    /** Unique task identifier */
    id: string;
    /** Session ID for this task */
    sessionId: string;
    /** Parent session that launched this task */
    parentSessionId: string;
    /** Short description of the task */
    description: string;
    /** Original prompt for the task */
    prompt: string;
    /** Agent handling the task */
    agent: string;
    /** Current status */
    status: BackgroundTaskStatus;
    /** When the task was queued (waiting for concurrency) */
    queuedAt?: Date;
    /** When the task started */
    startedAt: Date;
    /** When the task completed (if completed) */
    completedAt?: Date;
    /** Result output (if completed) */
    result?: string;
    /** Error message (if failed) */
    error?: string;
    /** Progress tracking */
    progress?: TaskProgress;
    /** Key for concurrency tracking */
    concurrencyKey?: string;
    /** Parent model (preserved from launch input) */
    parentModel?: string;
}
/**
 * Input for launching a new background task
 */
export interface LaunchInput {
    /** Short description of the task */
    description: string;
    /** Prompt for the task */
    prompt: string;
    /** Agent to handle the task */
    agent: string;
    /** Parent session ID */
    parentSessionId: string;
    /** Model configuration (optional) */
    model?: string;
}
/**
 * Input for resuming a background task
 */
export interface ResumeInput {
    /** Session ID to resume */
    sessionId: string;
    /** New prompt to send */
    prompt: string;
    /** Parent session ID */
    parentSessionId: string;
}
/**
 * Context for resuming a background task
 */
export interface ResumeContext {
    /** Session ID of the task */
    sessionId: string;
    /** Original prompt for the task */
    previousPrompt: string;
    /** Number of tool calls made so far */
    toolCallCount: number;
    /** Last tool used (if any) */
    lastToolUsed?: string;
    /** Summary of last output (truncated) */
    lastOutputSummary?: string;
    /** When the task started */
    startedAt: Date;
    /** When the task was last active */
    lastActivityAt: Date;
}
/**
 * Configuration for background task concurrency
 */
export interface BackgroundTaskConfig {
    /** Default concurrency limit (0 = unlimited) */
    defaultConcurrency?: number;
    /** Per-model concurrency limits */
    modelConcurrency?: Record<string, number>;
    /** Per-provider concurrency limits */
    providerConcurrency?: Record<string, number>;
    /** Maximum total background tasks */
    maxTotalTasks?: number;
    /** Task timeout in milliseconds */
    taskTimeoutMs?: number;
    /** Maximum queue size (tasks waiting for slot). If not set, uses maxTotalTasks - running as implicit limit */
    maxQueueSize?: number;
    /** Threshold in ms for detecting stale sessions (default: 5 min) */
    staleThresholdMs?: number;
    /** Callback when stale session detected */
    onStaleSession?: (task: BackgroundTask) => void;
}
//# sourceMappingURL=types.d.ts.map
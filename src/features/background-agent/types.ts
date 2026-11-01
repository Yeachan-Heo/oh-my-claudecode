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
export type BackgroundTaskStatus =
  | 'queued'      // Waiting for concurrency slot
  | 'pending'     // @deprecated Use 'queued' instead. Kept for backward compatibility.
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled';

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

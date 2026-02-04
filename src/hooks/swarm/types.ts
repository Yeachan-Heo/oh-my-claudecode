/**
 * Swarm Coordination Types
 *
 * Type definitions for the SQLite-based swarm coordination system.
 * Swarm enables multiple agents to claim and work on tasks atomically
 * with lease-based ownership and heartbeat monitoring.
 */

/**
 * A task in the swarm task pool
 */
export interface SwarmTask {
  /** Unique task identifier */
  id: string;
  /** Human-readable task description */
  description: string;
  /** Current task status */
  status: 'pending' | 'claimed' | 'done' | 'failed';
  /** Agent ID that claimed this task (null if unclaimed) */
  claimedBy: string | null;
  /** Unix timestamp when task was claimed (null if unclaimed) */
  claimedAt: number | null;
  /** Unix timestamp when task was completed (null if incomplete) */
  completedAt: number | null;
  /** Error message if task failed */
  error?: string;
  /** Result/output from completed task */
  result?: string;
  /** Priority for task ordering (lower = higher priority) */
  priority?: number;
  /** Wave number this task belongs to */
  wave?: number;
  /** Files this task owns (advisory, for conflict prevention) */
  ownedFiles?: string[];
  /** Glob patterns for files this task may modify */
  filePatterns?: string[];
}

/**
 * Overall swarm state
 */
export interface SwarmState {
  /** Whether swarm is currently active */
  active: boolean;
  /** Unique session identifier */
  sessionId: string;
  /** Number of agents participating in the swarm */
  agentCount: number;
  /** All tasks in the swarm */
  tasks: SwarmTask[];
  /** Timestamp when swarm was started */
  startedAt: number;
  /** Timestamp when swarm completed (null if still running) */
  completedAt: number | null;
}

/**
 * Result of attempting to claim a task
 */
export interface ClaimResult {
  /** Whether the claim was successful */
  success: boolean;
  /** ID of the claimed task (null if claim failed) */
  taskId: string | null;
  /** Task description (for convenience) */
  description?: string;
  /** Reason for failure if claim was unsuccessful */
  reason?: string;
}

/**
 * Configuration for swarm initialization
 */
export interface SwarmConfig {
  /** Number of agents to spawn */
  agentCount: number;
  /** Task descriptions to add to the pool */
  tasks: string[];
  /** Agent type/model to use (default: executor) */
  agentType?: string;
  /** Lease timeout in milliseconds (default: 5 minutes) */
  leaseTimeout?: number;
  /** Heartbeat interval in milliseconds (default: 60 seconds) */
  heartbeatInterval?: number;
  /** Working directory */
  cwd?: string;
}

/**
 * Extended configuration for aggressive swarm mode
 * Enables wave-based spawning with many more tasks than concurrent agents
 */
export interface AggressiveSwarmConfig extends SwarmConfig {
  /** Maximum concurrent agents (respects OMC configurable limit, default 5) */
  maxConcurrent?: number;
  /** Total tasks to process (can exceed maxConcurrent) */
  totalTasks?: number;
  /** Enable wave-based spawning (default: true when tasks.length > agentCount) */
  waveMode?: boolean;
  /** Polling interval for wave management in ms (default: 5000) */
  wavePollingInterval?: number;
}

/**
 * Agent heartbeat record
 */
export interface AgentHeartbeat {
  /** Agent identifier */
  agentId: string;
  /** Unix timestamp of last heartbeat */
  lastHeartbeat: number;
  /** Task currently being worked on (null if idle) */
  currentTaskId: string | null;
}

/**
 * Swarm statistics
 */
export interface SwarmStats {
  /** Total number of tasks */
  totalTasks: number;
  /** Number of pending tasks */
  pendingTasks: number;
  /** Number of claimed/in-progress tasks */
  claimedTasks: number;
  /** Number of completed tasks */
  doneTasks: number;
  /** Number of failed tasks */
  failedTasks: number;
  /** Number of active agents */
  activeAgents: number;
  /** Elapsed time in milliseconds */
  elapsedTime: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_SWARM_CONFIG: Required<Omit<SwarmConfig, 'tasks' | 'cwd'>> & { tasks: string[] } = {
  agentCount: 3,
  tasks: [],
  agentType: 'executor',
  leaseTimeout: 5 * 60 * 1000, // 5 minutes
  heartbeatInterval: 60 * 1000 // 60 seconds
};

/**
 * Database schema version for migrations
 */
export const DB_SCHEMA_VERSION = 2;

/**
 * Swarm Coordination System
 *
 * SQLite-based multi-agent task coordination.
 * Enables N agents to claim and work on tasks from a shared pool
 * with atomic claiming, lease-based ownership, and heartbeat monitoring.
 *
 * Usage:
 * ```typescript
 * import { startSwarm, claimTask, completeTask, stopSwarm } from './swarm';
 *
 * // Initialize swarm with tasks
 * await startSwarm({
 *   agentCount: 5,
 *   tasks: ['fix error in auth.ts', 'add tests for api.ts', ...],
 *   cwd: process.cwd()
 * });
 *
 * // Each agent claims and works on tasks
 * const claim = claimTask('agent-1');
 * if (claim.success) {
 *   // Do work...
 *   completeTask('agent-1', claim.taskId!, 'Fixed the bug');
 * }
 *
 * // Check status
 * const status = getSwarmStatus();
 *
 * // Clean up when done
 * stopSwarm();
 * ```
 */
import type { SwarmConfig, SwarmState, SwarmTask, SwarmStats, ClaimResult, AgentHeartbeat } from './types.js';
/**
 * Start a new swarm session
 *
 * Initializes the SQLite database, creates the task pool,
 * and starts the stale claim cleanup timer.
 *
 * @param config - Swarm configuration
 * @returns true if swarm was started successfully
 */
export declare function startSwarm(config: SwarmConfig): Promise<boolean>;
/**
 * Stop the swarm and clean up resources
 *
 * Stops the cleanup timer and optionally deletes the database.
 *
 * @param deleteDatabase - Whether to delete the database file (default: false)
 * @returns true if swarm was stopped successfully
 */
export declare function stopSwarm(deleteDatabase?: boolean): boolean;
/**
 * Get the current swarm status
 *
 * @returns SwarmState or null if swarm is not active
 */
export declare function getSwarmStatus(): SwarmState | null;
/**
 * Get swarm statistics
 *
 * @returns SwarmStats with task counts and timing info
 */
export declare function getSwarmStats(): SwarmStats | null;
/**
 * Claim the next available task
 *
 * @param agentId - Unique identifier for the claiming agent
 * @returns ClaimResult with success status and task details
 */
export declare function claimTask(agentId: string): ClaimResult;
/**
 * Release a claimed task back to the pool
 *
 * @param agentId - Agent releasing the task
 * @param taskId - Task to release
 * @returns true if release was successful
 */
export declare function releaseTask(agentId: string, taskId: string): boolean;
/**
 * Mark a task as completed
 *
 * @param agentId - Agent that completed the task
 * @param taskId - Completed task ID
 * @param result - Optional result/output from the task
 * @returns true if completion was recorded
 */
export declare function completeTask(agentId: string, taskId: string, result?: string): boolean;
/**
 * Mark a task as failed
 *
 * @param agentId - Agent that failed the task
 * @param taskId - Failed task ID
 * @param error - Error message/reason for failure
 * @returns true if failure was recorded
 */
export declare function failTask(agentId: string, taskId: string, error: string): boolean;
/**
 * Send a heartbeat to indicate the agent is still alive
 *
 * Agents should call this every 60 seconds while working on tasks.
 *
 * @param agentId - Agent sending heartbeat
 * @returns true if heartbeat was recorded
 */
export declare function heartbeat(agentId: string): boolean;
/**
 * Clean up stale claims from dead agents
 *
 * Called automatically by the cleanup timer, but can also be called manually.
 *
 * @param leaseTimeout - Lease timeout in milliseconds (default: 5 minutes)
 * @returns Number of tasks released
 */
export declare function cleanupStaleClaims(leaseTimeout?: number): number;
/**
 * Check if there are pending tasks
 *
 * @returns true if there are tasks waiting to be claimed
 */
export declare function hasPendingWork(): boolean;
/**
 * Check if all tasks are complete
 *
 * @returns true if all tasks are done or failed
 */
export declare function isSwarmComplete(): boolean;
/**
 * Get the number of active agents
 *
 * @returns Number of agents with recent heartbeats
 */
export declare function getActiveAgents(): number;
/**
 * Get all tasks
 *
 * @returns Array of all tasks in the swarm
 */
export declare function getAllTasks(): SwarmTask[];
/**
 * Get tasks by status
 *
 * @param status - Task status to filter by
 * @returns Array of tasks with the given status
 */
export declare function getTasksWithStatus(status: SwarmTask['status']): SwarmTask[];
/**
 * Get a specific task
 *
 * @param taskId - Task ID to retrieve
 * @returns Task or null if not found
 */
export declare function getTaskById(taskId: string): SwarmTask | null;
/**
 * Get tasks claimed by a specific agent
 *
 * @param agentId - Agent to query
 * @returns Array of tasks claimed by the agent
 */
export declare function getAgentTasks(agentId: string): SwarmTask[];
/**
 * Get all agent heartbeats
 *
 * @returns Array of agent heartbeat records
 */
export declare function getAllHeartbeats(): AgentHeartbeat[];
/**
 * Retry a failed task
 *
 * @param agentId - Agent attempting to retry
 * @param taskId - Failed task to retry
 * @returns ClaimResult
 */
export declare function retryTask(agentId: string, taskId: string): ClaimResult;
/**
 * Claim a task matching the agent's file scope
 *
 * @param agentId - Agent claiming the task
 * @param agentFilePatterns - Glob patterns for files this agent handles
 * @returns ClaimResult
 */
export declare function claimTaskForFiles(agentId: string, agentFilePatterns: string[]): ClaimResult;
/**
 * Add additional tasks to a running swarm
 * Used for dynamic task addition during wave-based execution
 *
 * @param tasks - Array of task definitions with optional metadata
 * @returns Object with count of added tasks and starting ID
 */
export declare function addMoreTasks(tasks: Array<{
    description: string;
    priority?: number;
    wave?: number;
    ownedFiles?: string[];
    filePatterns?: string[];
}>): {
    added: number;
    startingId: number;
};
/**
 * Get available slots for spawning new agents
 * Simple calculation from existing stats
 *
 * @param maxConcurrent - Maximum concurrent agents (default: 5)
 * @returns Number of available slots
 */
export declare function getAvailableSlots(maxConcurrent?: number): number;
/**
 * Get tasks for a specific wave
 *
 * @param wave - Wave number to filter by
 * @returns Array of tasks in that wave
 */
export declare function getTasksForWave(wave: number): SwarmTask[];
/**
 * Check if swarm database is initialized
 *
 * @returns true if database is ready
 */
export declare function isSwarmReady(): boolean;
/**
 * Initialize database without starting a swarm
 *
 * Useful for agents that join an existing swarm.
 *
 * @param cwd - Working directory
 * @returns true if database was initialized
 */
export declare function connectToSwarm(cwd: string): Promise<boolean>;
/**
 * Disconnect from swarm without stopping it
 *
 * @returns true if disconnected successfully
 */
export declare function disconnectFromSwarm(): boolean;
/**
 * Check if swarm is currently active
 *
 * Used by cancel skill to detect active swarm.
 * Checks if database exists and session is active.
 *
 * @param cwd - Working directory to check
 * @returns true if swarm is active
 */
export declare function isSwarmActive(cwd: string): boolean;
/**
 * Cancel active swarm
 *
 * Used by cancel skill to stop swarm cleanly.
 *
 * @param cwd - Working directory
 * @returns CancelResult with success status and message
 */
export declare function cancelSwarm(cwd: string): Promise<{
    success: boolean;
    message: string;
    stats?: SwarmStats | null;
}>;
export type { SwarmTask, SwarmState, SwarmConfig, AggressiveSwarmConfig, SwarmStats, ClaimResult, AgentHeartbeat } from './types.js';
export { DEFAULT_SWARM_CONFIG } from './types.js';
//# sourceMappingURL=index.d.ts.map
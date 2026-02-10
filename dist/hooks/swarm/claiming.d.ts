/**
 * Swarm Task Claiming
 *
 * Atomic task claiming with lease-based ownership.
 * Uses SQLite transactions to ensure only one agent can claim a task.
 * Implements 5-minute lease timeout and heartbeat monitoring.
 */
import type { ClaimResult, SwarmTask } from './types.js';
/**
 * Set the current working directory for summary writes
 * Called by the main swarm module when starting/connecting
 */
export declare function setSwarmCwd(cwd: string): void;
/**
 * Get the current working directory
 */
export declare function getSwarmCwd(): string | null;
/**
 * Atomically claim the next available task
 *
 * Uses a transaction to ensure only one agent can claim a task.
 * Claims are lease-based with a 5-minute timeout.
 *
 * @param agentId - Unique identifier for the claiming agent
 * @returns ClaimResult indicating success/failure and task details
 */
export declare function claimTask(agentId: string): ClaimResult;
/**
 * Release a claimed task back to the pending pool
 *
 * Used when an agent fails to complete a task or wants to give it up.
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
export declare function completeTask(agentId: string, taskId: string, taskResult?: string): boolean;
/**
 * Mark a task as failed
 *
 * @param agentId - Agent that failed the task
 * @param taskId - Failed task ID
 * @param error - Error message/reason for failure
 * @returns true if failure was recorded
 */
export declare function failTask(agentId: string, taskId: string, errorMessage: string): boolean;
/**
 * Record agent heartbeat
 *
 * Agents should call this every 60 seconds to indicate they're still alive.
 * Used by cleanupStaleClaims to detect dead agents.
 *
 * @param agentId - Agent sending heartbeat
 * @returns true if heartbeat was recorded
 */
export declare function heartbeat(agentId: string): boolean;
/**
 * Clean up stale claims from dead agents
 *
 * Releases tasks that have been claimed for longer than the lease timeout
 * (default 5 minutes) by agents that haven't sent a heartbeat.
 *
 * @param leaseTimeout - Lease timeout in milliseconds (default: 5 minutes)
 * @returns Number of tasks released
 */
export declare function cleanupStaleClaims(leaseTimeout?: number): number;
/**
 * Get tasks claimed by a specific agent
 *
 * @param agentId - Agent to query
 * @returns Array of tasks claimed by the agent
 */
export declare function getTasksClaimedBy(agentId: string): SwarmTask[];
/**
 * Check if there are any pending tasks
 *
 * @returns true if there are pending tasks
 */
export declare function hasPendingTasks(): boolean;
/**
 * Check if all tasks are complete (done or failed)
 *
 * @returns true if all tasks are complete
 */
export declare function allTasksComplete(): boolean;
/**
 * Get the number of active agents (with recent heartbeats)
 *
 * @param heartbeatTimeout - How old a heartbeat can be to still be considered active
 * @returns Number of active agents
 */
export declare function getActiveAgentCount(heartbeatTimeout?: number): number;
/**
 * Attempt to reclaim a failed task
 *
 * @param agentId - Agent attempting to reclaim
 * @param taskId - Task to reclaim
 * @returns ClaimResult
 */
export declare function reclaimFailedTask(agentId: string, taskId: string): ClaimResult;
/**
 * Claim a task that matches the agent's file scope
 * Used when agents are assigned to specific file patterns.
 *
 * Fetches all pending tasks and filters in TypeScript using
 * simple glob matching. Falls back to regular claimTask if
 * no scope-matched task is found.
 *
 * @param agentId - Agent claiming the task
 * @param agentFilePatterns - Glob patterns for files this agent handles
 * @returns ClaimResult
 */
export declare function claimTaskForFiles(agentId: string, agentFilePatterns: string[]): ClaimResult;
//# sourceMappingURL=claiming.d.ts.map
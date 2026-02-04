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

import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type {
  SwarmConfig,
  SwarmState,
  SwarmTask,
  SwarmStats,
  ClaimResult,
  AgentHeartbeat
} from './types.js';
import { DEFAULT_SWARM_CONFIG } from './types.js';
import {
  initDb,
  closeDb,
  deleteDb,
  isDbInitialized,
  initSession,
  loadState,
  saveState,
  addTasks,
  getTasks,
  getTasksByStatus,
  getTasksByWave,
  getTask,
  getStats,
  getHeartbeats,
  clearAllData,
  writeSwarmSummary,
  getNextTaskId
} from './state.js';
import {
  claimTask as claimTaskInternal,
  releaseTask as releaseTaskInternal,
  completeTask as completeTaskInternal,
  failTask as failTaskInternal,
  heartbeat as heartbeatInternal,
  cleanupStaleClaims as cleanupStaleClaimsInternal,
  getTasksClaimedBy,
  hasPendingTasks,
  allTasksComplete,
  getActiveAgentCount,
  reclaimFailedTask,
  setSwarmCwd,
  claimTaskForFiles as claimTaskForFilesInternal
} from './claiming.js';
import { canStartMode, createModeMarker, removeModeMarker } from '../mode-registry/index.js';

// Current working directory for the swarm
let currentCwd: string | null = null;

// Cleanup interval handle
let cleanupIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Clean up resources on initialization failure
 * Called when startSwarm fails after partial initialization
 */
function cleanupOnFailure(cwd: string): void {
  // Stop cleanup timer if started
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }
  // Close database
  closeDb();
  // Remove marker file
  removeModeMarker('swarm', cwd);
  // Reset state
  currentCwd = null;
}

/**
 * Start a new swarm session
 *
 * Initializes the SQLite database, creates the task pool,
 * and starts the stale claim cleanup timer.
 *
 * @param config - Swarm configuration
 * @returns true if swarm was started successfully
 */
export async function startSwarm(config: SwarmConfig): Promise<boolean> {
  const {
    agentCount,
    tasks,
    cwd = process.cwd(),
    leaseTimeout = DEFAULT_SWARM_CONFIG.leaseTimeout
  } = config;

  if (tasks.length === 0) {
    console.error('Cannot start swarm with no tasks');
    return false;
  }

  if (agentCount < 1) {
    console.error('Agent count must be at least 1');
    return false;
  }

  // Mutual exclusion check via mode-registry
  const canStart = canStartMode('swarm', cwd);
  if (!canStart.allowed) {
    console.error(canStart.message);
    return false;
  }

  // Initialize database
  const dbInitialized = await initDb(cwd);
  if (!dbInitialized) {
    console.error('Failed to initialize swarm database');
    return false;
  }

  // Create marker file to indicate swarm is active
  createModeMarker('swarm', cwd, {
    agentCount,
    taskCount: tasks.length
  });

  currentCwd = cwd;

  // Set cwd in claiming module for summary writes
  setSwarmCwd(cwd);

  // Clear any existing data
  clearAllData();

  // Create session
  const sessionId = randomUUID();
  if (!initSession(sessionId, agentCount)) {
    console.error('Failed to initialize swarm session');
    cleanupOnFailure(cwd);
    return false;
  }

  // Add tasks to pool
  const taskRecords = tasks.map((description, index) => ({
    id: `task-${index + 1}`,
    description
  }));

  if (!addTasks(taskRecords)) {
    console.error('Failed to add tasks to pool');
    cleanupOnFailure(cwd);
    return false;
  }

  // Start cleanup timer (runs every minute)
  cleanupIntervalHandle = setInterval(() => {
    cleanupStaleClaimsInternal(leaseTimeout);
  }, 60 * 1000);

  // Write initial summary
  writeSwarmSummary(cwd);

  return true;
}

/**
 * Stop the swarm and clean up resources
 *
 * Stops the cleanup timer and optionally deletes the database.
 *
 * @param deleteDatabase - Whether to delete the database file (default: false)
 * @returns true if swarm was stopped successfully
 */
export function stopSwarm(deleteDatabase: boolean = false): boolean {
  // Stop cleanup timer
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }

  // Mark session as inactive
  saveState({ active: false, completedAt: Date.now() });

  // Write final summary
  if (currentCwd) {
    writeSwarmSummary(currentCwd);
  }

  // Close database
  closeDb();

  // Optionally delete database
  if (deleteDatabase && currentCwd) {
    deleteDb(currentCwd);
  }

  // Remove marker file
  if (currentCwd) {
    removeModeMarker('swarm', currentCwd);
  }

  currentCwd = null;
  return true;
}

/**
 * Get the current swarm status
 *
 * @returns SwarmState or null if swarm is not active
 */
export function getSwarmStatus(): SwarmState | null {
  return loadState();
}

/**
 * Get swarm statistics
 *
 * @returns SwarmStats with task counts and timing info
 */
export function getSwarmStats(): SwarmStats | null {
  return getStats();
}

/**
 * Claim the next available task
 *
 * @param agentId - Unique identifier for the claiming agent
 * @returns ClaimResult with success status and task details
 */
export function claimTask(agentId: string): ClaimResult {
  return claimTaskInternal(agentId);
}

/**
 * Release a claimed task back to the pool
 *
 * @param agentId - Agent releasing the task
 * @param taskId - Task to release
 * @returns true if release was successful
 */
export function releaseTask(agentId: string, taskId: string): boolean {
  return releaseTaskInternal(agentId, taskId);
}

/**
 * Mark a task as completed
 *
 * @param agentId - Agent that completed the task
 * @param taskId - Completed task ID
 * @param result - Optional result/output from the task
 * @returns true if completion was recorded
 */
export function completeTask(agentId: string, taskId: string, result?: string): boolean {
  const success = completeTaskInternal(agentId, taskId, result);

  // Check if all tasks are complete
  if (success && allTasksComplete()) {
    saveState({ completedAt: Date.now() });
  }

  return success;
}

/**
 * Mark a task as failed
 *
 * @param agentId - Agent that failed the task
 * @param taskId - Failed task ID
 * @param error - Error message/reason for failure
 * @returns true if failure was recorded
 */
export function failTask(agentId: string, taskId: string, error: string): boolean {
  return failTaskInternal(agentId, taskId, error);
}

/**
 * Send a heartbeat to indicate the agent is still alive
 *
 * Agents should call this every 60 seconds while working on tasks.
 *
 * @param agentId - Agent sending heartbeat
 * @returns true if heartbeat was recorded
 */
export function heartbeat(agentId: string): boolean {
  return heartbeatInternal(agentId);
}

/**
 * Clean up stale claims from dead agents
 *
 * Called automatically by the cleanup timer, but can also be called manually.
 *
 * @param leaseTimeout - Lease timeout in milliseconds (default: 5 minutes)
 * @returns Number of tasks released
 */
export function cleanupStaleClaims(leaseTimeout?: number): number {
  return cleanupStaleClaimsInternal(leaseTimeout);
}

/**
 * Check if there are pending tasks
 *
 * @returns true if there are tasks waiting to be claimed
 */
export function hasPendingWork(): boolean {
  return hasPendingTasks();
}

/**
 * Check if all tasks are complete
 *
 * @returns true if all tasks are done or failed
 */
export function isSwarmComplete(): boolean {
  return allTasksComplete();
}

/**
 * Get the number of active agents
 *
 * @returns Number of agents with recent heartbeats
 */
export function getActiveAgents(): number {
  return getActiveAgentCount();
}

/**
 * Get all tasks
 *
 * @returns Array of all tasks in the swarm
 */
export function getAllTasks(): SwarmTask[] {
  return getTasks();
}

/**
 * Get tasks by status
 *
 * @param status - Task status to filter by
 * @returns Array of tasks with the given status
 */
export function getTasksWithStatus(status: SwarmTask['status']): SwarmTask[] {
  return getTasksByStatus(status);
}

/**
 * Get a specific task
 *
 * @param taskId - Task ID to retrieve
 * @returns Task or null if not found
 */
export function getTaskById(taskId: string): SwarmTask | null {
  return getTask(taskId);
}

/**
 * Get tasks claimed by a specific agent
 *
 * @param agentId - Agent to query
 * @returns Array of tasks claimed by the agent
 */
export function getAgentTasks(agentId: string): SwarmTask[] {
  return getTasksClaimedBy(agentId);
}

/**
 * Get all agent heartbeats
 *
 * @returns Array of agent heartbeat records
 */
export function getAllHeartbeats(): AgentHeartbeat[] {
  return getHeartbeats();
}

/**
 * Retry a failed task
 *
 * @param agentId - Agent attempting to retry
 * @param taskId - Failed task to retry
 * @returns ClaimResult
 */
export function retryTask(agentId: string, taskId: string): ClaimResult {
  return reclaimFailedTask(agentId, taskId);
}

/**
 * Claim a task matching the agent's file scope
 *
 * @param agentId - Agent claiming the task
 * @param agentFilePatterns - Glob patterns for files this agent handles
 * @returns ClaimResult
 */
export function claimTaskForFiles(agentId: string, agentFilePatterns: string[]): ClaimResult {
  return claimTaskForFilesInternal(agentId, agentFilePatterns);
}

/**
 * Add additional tasks to a running swarm
 * Used for dynamic task addition during wave-based execution
 *
 * @param tasks - Array of task definitions with optional metadata
 * @returns Object with count of added tasks and starting ID
 */
export function addMoreTasks(
  tasks: Array<{ description: string; priority?: number; wave?: number; ownedFiles?: string[]; filePatterns?: string[] }>
): { added: number; startingId: number } {
  if (!isDbInitialized()) {
    return { added: 0, startingId: -1 };
  }

  // Get the highest existing task ID number from database
  const startingId = getNextTaskId();

  const taskRecords = tasks.map((task, index) => ({
    id: `task-${startingId + index}`,
    description: task.description,
    priority: task.priority,
    wave: task.wave,
    ownedFiles: task.ownedFiles,
    filePatterns: task.filePatterns,
  }));

  const success = addTasks(taskRecords);
  if (!success) {
    return { added: 0, startingId: -1 };
  }

  // Write updated summary
  if (currentCwd) {
    writeSwarmSummary(currentCwd);
  }

  return { added: tasks.length, startingId };
}

/**
 * Get available slots for spawning new agents
 * Simple calculation from existing stats
 *
 * @param maxConcurrent - Maximum concurrent agents (default: 5)
 * @returns Number of available slots
 */
export function getAvailableSlots(maxConcurrent: number = 5): number {
  const stats = getSwarmStats();
  if (!stats) return 0;
  return Math.max(0, maxConcurrent - stats.claimedTasks);
}

/**
 * Get tasks for a specific wave
 *
 * @param wave - Wave number to filter by
 * @returns Array of tasks in that wave
 */
export function getTasksForWave(wave: number): SwarmTask[] {
  return getTasksByWave(wave);
}

/**
 * Check if swarm database is initialized
 *
 * @returns true if database is ready
 */
export function isSwarmReady(): boolean {
  return isDbInitialized();
}

/**
 * Initialize database without starting a swarm
 *
 * Useful for agents that join an existing swarm.
 *
 * @param cwd - Working directory
 * @returns true if database was initialized
 */
export async function connectToSwarm(cwd: string): Promise<boolean> {
  if (isDbInitialized()) {
    return true;
  }

  const success = await initDb(cwd);
  if (success) {
    currentCwd = cwd;
    setSwarmCwd(cwd);
  }
  return success;
}

/**
 * Disconnect from swarm without stopping it
 *
 * @returns true if disconnected successfully
 */
export function disconnectFromSwarm(): boolean {
  closeDb();
  currentCwd = null;
  return true;
}

/**
 * Check if swarm is currently active
 *
 * Used by cancel skill to detect active swarm.
 * Checks if database exists and session is active.
 *
 * @param cwd - Working directory to check
 * @returns true if swarm is active
 */
export function isSwarmActive(cwd: string): boolean {
  // If database is already connected, check state directly
  if (isDbInitialized()) {
    const state = loadState();
    return state !== null && state.active === true;
  }

  // Otherwise, check if database file exists and is non-empty
  const dbPath = join(cwd, '.omc', 'state', 'swarm.db');
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    const stats = statSync(dbPath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Cancel active swarm
 *
 * Used by cancel skill to stop swarm cleanly.
 *
 * @param cwd - Working directory
 * @returns CancelResult with success status and message
 */
export async function cancelSwarm(cwd: string): Promise<{
  success: boolean;
  message: string;
  stats?: SwarmStats | null;
}> {
  // Connect if not already connected
  if (!isDbInitialized()) {
    const connected = await connectToSwarm(cwd);
    if (!connected) {
      return {
        success: false,
        message: 'Failed to connect to swarm database'
      };
    }
  }

  const state = getSwarmStatus();
  if (!state || !state.active) {
    return {
      success: false,
      message: 'No active swarm session found'
    };
  }

  const stats = getSwarmStats();

  // Stop the swarm (preserves database for analysis)
  stopSwarm(false);

  return {
    success: true,
    message: `Swarm cancelled. ${stats?.doneTasks ?? 0}/${stats?.totalTasks ?? 0} tasks completed.`,
    stats
  };
}

// Re-export types
export type {
  SwarmTask,
  SwarmState,
  SwarmConfig,
  AggressiveSwarmConfig,
  SwarmStats,
  ClaimResult,
  AgentHeartbeat
} from './types.js';

export { DEFAULT_SWARM_CONFIG } from './types.js';

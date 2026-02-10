/**
 * Swarm State Management
 *
 * SQLite-based persistent state for swarm coordination.
 * Uses better-sqlite3 for synchronous operations with transaction support.
 * All state is stored in .omc/state/swarm.db
 */
import type BetterSqlite3 from "better-sqlite3";
import type { SwarmTask, SwarmState, AgentHeartbeat, SwarmStats } from "./types.js";
/**
 * SwarmSummary interface for the JSON sidecar
 */
export interface SwarmSummary {
    session_id: string;
    started_at: string;
    updated_at: string;
    task_count: number;
    tasks_pending: number;
    tasks_claimed: number;
    tasks_done: number;
    active: boolean;
    project_path?: string;
}
/**
 * Initialize the SQLite database
 * Creates tables if they don't exist
 */
export declare function initDb(cwd: string): Promise<boolean>;
/**
 * Close the database connection
 */
export declare function closeDb(): void;
/**
 * Delete the database file (for cleanup)
 */
export declare function deleteDb(cwd: string): boolean;
/**
 * Check if database is initialized and connected
 */
export declare function isDbInitialized(): boolean;
/**
 * Initialize a new swarm session
 */
export declare function initSession(sessionId: string, agentCount: number): boolean;
/**
 * Load the current swarm state
 */
export declare function loadState(): SwarmState | null;
/**
 * Save swarm state (updates session info only, tasks are updated individually)
 */
export declare function saveState(state: Partial<SwarmState>): boolean;
/**
 * Add a task to the pool
 */
export declare function addTask(id: string, description: string, options?: {
    priority?: number;
    wave?: number;
    ownedFiles?: string[];
    filePatterns?: string[];
}): boolean;
/**
 * Add multiple tasks in a transaction
 */
export declare function addTasks(tasks: Array<{
    id: string;
    description: string;
    priority?: number;
    wave?: number;
    ownedFiles?: string[];
    filePatterns?: string[];
}>): boolean;
/**
 * Get all tasks
 */
export declare function getTasks(): SwarmTask[];
/**
 * Get tasks by status
 */
export declare function getTasksByStatus(status: SwarmTask["status"]): SwarmTask[];
/**
 * Get tasks by wave number
 */
export declare function getTasksByWave(wave: number): SwarmTask[];
/**
 * Get the next available task ID number
 * Uses MAX(id) from database to prevent ID collisions after deletions
 */
export declare function getNextTaskId(): number;
/**
 * Get a specific task by ID
 */
export declare function getTask(taskId: string): SwarmTask | null;
/**
 * Update a task's status and metadata
 */
export declare function updateTask(taskId: string, updates: Partial<Omit<SwarmTask, "id" | "description">>): boolean;
/**
 * Get swarm statistics
 */
export declare function getStats(): SwarmStats | null;
/**
 * Record an agent heartbeat
 */
export declare function recordHeartbeat(agentId: string, currentTaskId: string | null): boolean;
/**
 * Get all agent heartbeats
 */
export declare function getHeartbeats(): AgentHeartbeat[];
/**
 * Remove an agent's heartbeat record
 */
export declare function removeHeartbeat(agentId: string): boolean;
/**
 * Clear all data (for reset)
 */
export declare function clearAllData(): boolean;
/**
 * Run a function within a transaction
 */
export declare function runTransaction<T>(fn: () => T): T | null;
/**
 * Get the raw database instance (for advanced use)
 */
export declare function getDb(): BetterSqlite3.Database | null;
/**
 * Write swarm summary to .omc/state/swarm-summary.json
 * This provides a lightweight JSON sidecar for external monitoring
 */
export declare function writeSwarmSummary(cwd: string): boolean;
//# sourceMappingURL=state.d.ts.map
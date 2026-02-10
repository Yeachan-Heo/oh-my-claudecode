/**
 * Swarm Task Claiming
 *
 * Atomic task claiming with lease-based ownership.
 * Uses SQLite transactions to ensure only one agent can claim a task.
 * Implements 5-minute lease timeout and heartbeat monitoring.
 */
import { DEFAULT_SWARM_CONFIG } from './types.js';
import { getDb, recordHeartbeat, writeSwarmSummary } from './state.js';
// Store current working directory for summary writes
let currentCwd = null;
/**
 * Set the current working directory for summary writes
 * Called by the main swarm module when starting/connecting
 */
export function setSwarmCwd(cwd) {
    currentCwd = cwd;
}
/**
 * Get the current working directory
 */
export function getSwarmCwd() {
    return currentCwd;
}
/**
 * Atomically claim the next available task
 *
 * Uses a transaction to ensure only one agent can claim a task.
 * Claims are lease-based with a 5-minute timeout.
 *
 * @param agentId - Unique identifier for the claiming agent
 * @returns ClaimResult indicating success/failure and task details
 */
export function claimTask(agentId) {
    const db = getDb();
    if (!db) {
        return {
            success: false,
            taskId: null,
            reason: 'Database not initialized'
        };
    }
    try {
        // Use a transaction for atomic claim
        const claimTransaction = db.transaction(() => {
            // Find the first pending task (ordered by priority, then id)
            const findStmt = db.prepare(`
        SELECT id, description FROM tasks
        WHERE status = 'pending'
        ORDER BY priority ASC, id ASC
        LIMIT 1
      `);
            const task = findStmt.get();
            if (!task) {
                return {
                    success: false,
                    taskId: null,
                    reason: 'No pending tasks available'
                };
            }
            // Claim the task
            const claimStmt = db.prepare(`
        UPDATE tasks
        SET status = 'claimed', claimed_by = ?, claimed_at = ?
        WHERE id = ? AND status = 'pending'
      `);
            const result = claimStmt.run(agentId, Date.now(), task.id);
            if (result.changes === 0) {
                // Task was claimed by another agent between SELECT and UPDATE
                return {
                    success: false,
                    taskId: null,
                    reason: 'Task was claimed by another agent'
                };
            }
            // Update heartbeat
            const heartbeatStmt = db.prepare(`
        INSERT OR REPLACE INTO heartbeats (agent_id, last_heartbeat, current_task_id)
        VALUES (?, ?, ?)
      `);
            heartbeatStmt.run(agentId, Date.now(), task.id);
            return {
                success: true,
                taskId: task.id,
                description: task.description
            };
        });
        const result = claimTransaction.immediate();
        // Write summary after successful claim
        if (result.success && currentCwd) {
            writeSwarmSummary(currentCwd);
        }
        return result;
    }
    catch (error) {
        return {
            success: false,
            taskId: null,
            reason: `Claim failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
/**
 * Release a claimed task back to the pending pool
 *
 * Used when an agent fails to complete a task or wants to give it up.
 *
 * @param agentId - Agent releasing the task
 * @param taskId - Task to release
 * @returns true if release was successful
 */
export function releaseTask(agentId, taskId) {
    const db = getDb();
    if (!db)
        return false;
    try {
        const releaseTransaction = db.transaction(() => {
            // Verify the agent owns this task
            const verifyStmt = db.prepare(`
        SELECT claimed_by FROM tasks WHERE id = ?
      `);
            const task = verifyStmt.get(taskId);
            if (!task || task.claimed_by !== agentId) {
                return false;
            }
            // Release the task
            const releaseStmt = db.prepare(`
        UPDATE tasks
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL
        WHERE id = ? AND claimed_by = ?
      `);
            releaseStmt.run(taskId, agentId);
            // Update heartbeat to show no current task
            const heartbeatStmt = db.prepare(`
        UPDATE heartbeats SET current_task_id = NULL WHERE agent_id = ?
      `);
            heartbeatStmt.run(agentId);
            return true;
        });
        return releaseTransaction.immediate();
    }
    catch (error) {
        console.error('Failed to release task:', error);
        return false;
    }
}
/**
 * Mark a task as completed
 *
 * @param agentId - Agent that completed the task
 * @param taskId - Completed task ID
 * @param result - Optional result/output from the task
 * @returns true if completion was recorded
 */
export function completeTask(agentId, taskId, taskResult) {
    const db = getDb();
    if (!db)
        return false;
    try {
        const completeTransaction = db.transaction(() => {
            // Verify the agent owns this task
            const verifyStmt = db.prepare(`
        SELECT claimed_by FROM tasks WHERE id = ?
      `);
            const task = verifyStmt.get(taskId);
            if (!task || task.claimed_by !== agentId) {
                return false;
            }
            // Mark task as done
            const completeStmt = db.prepare(`
        UPDATE tasks
        SET status = 'done', completed_at = ?, result = ?
        WHERE id = ? AND claimed_by = ?
      `);
            completeStmt.run(Date.now(), taskResult ?? null, taskId, agentId);
            // Update heartbeat to show no current task
            const heartbeatStmt = db.prepare(`
        UPDATE heartbeats SET current_task_id = NULL WHERE agent_id = ?
      `);
            heartbeatStmt.run(agentId);
            return true;
        });
        const success = completeTransaction.immediate();
        // Write summary after completion
        if (success && currentCwd) {
            writeSwarmSummary(currentCwd);
        }
        return success;
    }
    catch (error) {
        console.error('Failed to complete task:', error);
        return false;
    }
}
/**
 * Mark a task as failed
 *
 * @param agentId - Agent that failed the task
 * @param taskId - Failed task ID
 * @param error - Error message/reason for failure
 * @returns true if failure was recorded
 */
export function failTask(agentId, taskId, errorMessage) {
    const db = getDb();
    if (!db)
        return false;
    try {
        const failTransaction = db.transaction(() => {
            // Verify the agent owns this task
            const verifyStmt = db.prepare(`
        SELECT claimed_by FROM tasks WHERE id = ?
      `);
            const task = verifyStmt.get(taskId);
            if (!task || task.claimed_by !== agentId) {
                return false;
            }
            // Mark task as failed
            const failStmt = db.prepare(`
        UPDATE tasks
        SET status = 'failed', completed_at = ?, error = ?
        WHERE id = ? AND claimed_by = ?
      `);
            failStmt.run(Date.now(), errorMessage, taskId, agentId);
            // Update heartbeat to show no current task
            const heartbeatStmt = db.prepare(`
        UPDATE heartbeats SET current_task_id = NULL WHERE agent_id = ?
      `);
            heartbeatStmt.run(agentId);
            return true;
        });
        return failTransaction.immediate();
    }
    catch (err) {
        console.error('Failed to fail task:', err);
        return false;
    }
}
/**
 * Record agent heartbeat
 *
 * Agents should call this every 60 seconds to indicate they're still alive.
 * Used by cleanupStaleClaims to detect dead agents.
 *
 * @param agentId - Agent sending heartbeat
 * @returns true if heartbeat was recorded
 */
export function heartbeat(agentId) {
    const db = getDb();
    if (!db)
        return false;
    try {
        // Get current task for this agent
        const taskStmt = db.prepare(`
      SELECT id FROM tasks WHERE claimed_by = ? AND status = 'claimed'
    `);
        const task = taskStmt.get(agentId);
        return recordHeartbeat(agentId, task?.id ?? null);
    }
    catch (error) {
        console.error('Failed to record heartbeat:', error);
        return false;
    }
}
/**
 * Clean up stale claims from dead agents
 *
 * Releases tasks that have been claimed for longer than the lease timeout
 * (default 5 minutes) by agents that haven't sent a heartbeat.
 *
 * @param leaseTimeout - Lease timeout in milliseconds (default: 5 minutes)
 * @returns Number of tasks released
 */
export function cleanupStaleClaims(leaseTimeout = DEFAULT_SWARM_CONFIG.leaseTimeout) {
    const db = getDb();
    if (!db)
        return 0;
    try {
        const cutoffTime = Date.now() - leaseTimeout;
        const cleanupTransaction = db.transaction(() => {
            // Find tasks claimed longer than the timeout
            // Only release if the agent hasn't sent a heartbeat recently
            const findStaleStmt = db.prepare(`
        SELECT t.id, t.claimed_by
        FROM tasks t
        LEFT JOIN heartbeats h ON t.claimed_by = h.agent_id
        WHERE t.status = 'claimed'
          AND t.claimed_at < ?
          AND (h.last_heartbeat IS NULL OR h.last_heartbeat < ?)
      `);
            const staleTasks = findStaleStmt.all(cutoffTime, cutoffTime);
            if (staleTasks.length === 0) {
                return 0;
            }
            // Release stale tasks
            const releaseStmt = db.prepare(`
        UPDATE tasks
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL
        WHERE id = ?
      `);
            // Remove stale heartbeats
            const removeHeartbeatStmt = db.prepare(`
        DELETE FROM heartbeats WHERE agent_id = ?
      `);
            const staleAgents = new Set();
            for (const task of staleTasks) {
                releaseStmt.run(task.id);
                if (task.claimed_by) {
                    staleAgents.add(task.claimed_by);
                }
            }
            for (const agentId of staleAgents) {
                removeHeartbeatStmt.run(agentId);
            }
            return staleTasks.length;
        });
        return cleanupTransaction.immediate();
    }
    catch (error) {
        console.error('Failed to cleanup stale claims:', error);
        return 0;
    }
}
/**
 * Get tasks claimed by a specific agent
 *
 * @param agentId - Agent to query
 * @returns Array of tasks claimed by the agent
 */
export function getTasksClaimedBy(agentId) {
    const db = getDb();
    if (!db)
        return [];
    try {
        const stmt = db.prepare(`
      SELECT * FROM tasks WHERE claimed_by = ? AND status = 'claimed'
    `);
        const rows = stmt.all(agentId);
        return rows.map(row => ({
            id: row.id,
            description: row.description,
            status: row.status,
            claimedBy: row.claimed_by,
            claimedAt: row.claimed_at,
            completedAt: row.completed_at,
            error: row.error ?? undefined,
            result: row.result ?? undefined
        }));
    }
    catch (error) {
        console.error('Failed to get tasks claimed by agent:', error);
        return [];
    }
}
/**
 * Check if there are any pending tasks
 *
 * @returns true if there are pending tasks
 */
export function hasPendingTasks() {
    const db = getDb();
    if (!db)
        return false;
    try {
        const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'
    `);
        const result = stmt.get();
        return result.count > 0;
    }
    catch (error) {
        console.error('Failed to check pending tasks:', error);
        return false;
    }
}
/**
 * Check if all tasks are complete (done or failed)
 *
 * @returns true if all tasks are complete
 */
export function allTasksComplete() {
    const db = getDb();
    if (!db)
        return false;
    try {
        const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'claimed')
    `);
        const result = stmt.get();
        return result.count === 0;
    }
    catch (error) {
        console.error('Failed to check if all tasks complete:', error);
        return false;
    }
}
/**
 * Get the number of active agents (with recent heartbeats)
 *
 * @param heartbeatTimeout - How old a heartbeat can be to still be considered active
 * @returns Number of active agents
 */
export function getActiveAgentCount(heartbeatTimeout = DEFAULT_SWARM_CONFIG.leaseTimeout) {
    const db = getDb();
    if (!db)
        return 0;
    try {
        const cutoffTime = Date.now() - heartbeatTimeout;
        const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM heartbeats WHERE last_heartbeat > ?
    `);
        const result = stmt.get(cutoffTime);
        return result.count;
    }
    catch (error) {
        console.error('Failed to get active agent count:', error);
        return 0;
    }
}
/**
 * Attempt to reclaim a failed task
 *
 * @param agentId - Agent attempting to reclaim
 * @param taskId - Task to reclaim
 * @returns ClaimResult
 */
export function reclaimFailedTask(agentId, taskId) {
    const db = getDb();
    if (!db) {
        return {
            success: false,
            taskId: null,
            reason: 'Database not initialized'
        };
    }
    try {
        const reclaimTransaction = db.transaction(() => {
            // Check if task is failed
            const checkStmt = db.prepare(`
        SELECT id, description, status FROM tasks WHERE id = ?
      `);
            const task = checkStmt.get(taskId);
            if (!task) {
                return {
                    success: false,
                    taskId: null,
                    reason: 'Task not found'
                };
            }
            if (task.status !== 'failed') {
                return {
                    success: false,
                    taskId: null,
                    reason: `Task is ${task.status}, not failed`
                };
            }
            // Reclaim the task
            const reclaimStmt = db.prepare(`
        UPDATE tasks
        SET status = 'claimed', claimed_by = ?, claimed_at = ?, error = NULL
        WHERE id = ?
      `);
            reclaimStmt.run(agentId, Date.now(), taskId);
            // Update heartbeat
            const heartbeatStmt = db.prepare(`
        INSERT OR REPLACE INTO heartbeats (agent_id, last_heartbeat, current_task_id)
        VALUES (?, ?, ?)
      `);
            heartbeatStmt.run(agentId, Date.now(), taskId);
            return {
                success: true,
                taskId: task.id,
                description: task.description
            };
        });
        return reclaimTransaction.immediate();
    }
    catch (error) {
        return {
            success: false,
            taskId: null,
            reason: `Reclaim failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
/**
 * Simple glob matching for file patterns
 * Supports * (any chars except /) and ** (any path segments)
 */
function simpleGlobMatch(pattern, filePath) {
    // Normalize separators
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const normalizedPath = filePath.replace(/\\/g, '/');
    // Reject patterns that could cause ReDoS
    if (normalizedPattern.length > 500 || /\*{3,}/.test(normalizedPattern)) {
        return normalizedPattern === normalizedPath;
    }
    // Convert glob to regex safely
    const regexStr = normalizedPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars (except * and ?)
        .replace(/\*\*/g, '{{GLOBSTAR}}') // Placeholder for **
        .replace(/\*/g, '[^/]*') // * matches anything except /
        .replace(/\?/g, '[^/]') // ? matches single char except /
        .replace(/\{\{GLOBSTAR\}\}/g, '.*'); // ** matches anything including /
    try {
        return new RegExp(`^${regexStr}$`).test(normalizedPath);
    }
    catch {
        return normalizedPattern === normalizedPath;
    }
}
/**
 * Claim a specific task by ID (internal helper)
 * Atomically claims a task if it's still pending
 */
function claimSpecificTask(agentId, taskId) {
    const db = getDb();
    if (!db) {
        return { success: false, taskId: null, reason: 'Database not initialized' };
    }
    try {
        const claimTransaction = db.transaction(() => {
            // Get task description and verify it's still pending
            const findStmt = db.prepare(`
        SELECT id, description FROM tasks
        WHERE id = ? AND status = 'pending'
      `);
            const task = findStmt.get(taskId);
            if (!task) {
                return {
                    success: false,
                    taskId: null,
                    reason: 'Task not available'
                };
            }
            // Claim the task
            const claimStmt = db.prepare(`
        UPDATE tasks
        SET status = 'claimed', claimed_by = ?, claimed_at = ?
        WHERE id = ? AND status = 'pending'
      `);
            const result = claimStmt.run(agentId, Date.now(), task.id);
            if (result.changes === 0) {
                return {
                    success: false,
                    taskId: null,
                    reason: 'Task was claimed by another agent'
                };
            }
            // Update heartbeat
            const heartbeatStmt = db.prepare(`
        INSERT OR REPLACE INTO heartbeats (agent_id, last_heartbeat, current_task_id)
        VALUES (?, ?, ?)
      `);
            heartbeatStmt.run(agentId, Date.now(), task.id);
            return {
                success: true,
                taskId: task.id,
                description: task.description
            };
        });
        const result = claimTransaction.immediate();
        if (result.success && currentCwd) {
            writeSwarmSummary(currentCwd);
        }
        return result;
    }
    catch (error) {
        return {
            success: false,
            taskId: null,
            reason: `Claim failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
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
export function claimTaskForFiles(agentId, agentFilePatterns) {
    const db = getDb();
    if (!db) {
        return { success: false, taskId: null, reason: 'Database not initialized' };
    }
    try {
        // Fetch all pending tasks with file ownership data
        const pendingStmt = db.prepare(`
      SELECT id, description, owned_files, file_patterns, priority
      FROM tasks
      WHERE status = 'pending'
      ORDER BY priority ASC, id ASC
    `);
        const pendingTasks = pendingStmt.all();
        // Find first task where files overlap with agent's scope
        for (const task of pendingTasks) {
            let taskFiles = [];
            let taskPatterns = [];
            try {
                taskFiles = task.owned_files ? JSON.parse(task.owned_files) : [];
            }
            catch {
                // Skip tasks with corrupt owned_files JSON
            }
            try {
                taskPatterns = task.file_patterns ? JSON.parse(task.file_patterns) : [];
            }
            catch {
                // Skip tasks with corrupt file_patterns JSON
            }
            // Check if any task file matches any agent pattern
            const hasOverlap = [...taskFiles, ...taskPatterns].some(taskPath => agentFilePatterns.some(agentPattern => simpleGlobMatch(agentPattern, taskPath) || simpleGlobMatch(taskPath, agentPattern)));
            if (hasOverlap) {
                // Try to claim this specific task atomically
                const claimResult = claimSpecificTask(agentId, task.id);
                if (claimResult.success) {
                    return claimResult;
                }
                // Task was claimed by another agent, continue to next
            }
        }
        // No scope-matched task found, fall back to regular claiming
        return claimTask(agentId);
    }
    catch (error) {
        return {
            success: false,
            taskId: null,
            reason: `File claim failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
//# sourceMappingURL=claiming.js.map
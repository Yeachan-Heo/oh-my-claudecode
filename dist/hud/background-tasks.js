/**
 * OMC HUD - Background Task Management
 *
 * Functions for tracking background tasks via hooks.
 * Called from bridge.ts pre-tool-use and post-tool-use handlers.
 */
import { readHudState, writeHudState, createEmptyHudState } from './state.js';
const MAX_TASK_HISTORY = 20;
const TASK_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
/**
 * Add a background task to HUD state.
 * Called when a Task tool starts with run_in_background=true.
 */
export function addBackgroundTask(id, description, agentType, directory) {
    try {
        let state = readHudState(directory) || createEmptyHudState();
        // Clean up old/expired tasks
        state = cleanupTasks(state);
        // Add new task
        const task = {
            id,
            description,
            agentType,
            startedAt: new Date().toISOString(),
            status: 'running',
        };
        state.backgroundTasks.push(task);
        state.timestamp = new Date().toISOString();
        return writeHudState(state, directory);
    }
    catch {
        return false;
    }
}
/**
 * Mark a background task as completed.
 * Called when a Task tool completes.
 */
export function completeBackgroundTask(id, directory, failed = false) {
    try {
        const state = readHudState(directory);
        if (!state) {
            return false;
        }
        const task = state.backgroundTasks.find((t) => t.id === id);
        if (!task) {
            return false;
        }
        task.status = failed ? 'failed' : 'completed';
        task.completedAt = new Date().toISOString();
        state.timestamp = new Date().toISOString();
        return writeHudState(state, directory);
    }
    catch {
        return false;
    }
}
/**
 * Clean up old and expired tasks from state.
 */
function cleanupTasks(state) {
    const now = Date.now();
    // Filter out expired completed/failed tasks
    state.backgroundTasks = state.backgroundTasks.filter((task) => {
        // Keep running tasks
        if (task.status === 'running') {
            // But check if they're stale (started more than expiry time ago)
            const startedAt = new Date(task.startedAt).getTime();
            if (now - startedAt > TASK_EXPIRY_MS) {
                // Mark as failed and keep for history
                task.status = 'failed';
                task.completedAt = new Date().toISOString();
            }
            return true;
        }
        // For completed/failed, check expiry
        if (task.completedAt) {
            const completedAt = new Date(task.completedAt).getTime();
            return now - completedAt < TASK_EXPIRY_MS;
        }
        return true;
    });
    // Limit total history
    if (state.backgroundTasks.length > MAX_TASK_HISTORY) {
        // Keep running tasks and most recent completed
        const running = state.backgroundTasks.filter((t) => t.status === 'running');
        const completed = state.backgroundTasks
            .filter((t) => t.status !== 'running')
            .slice(-Math.max(0, MAX_TASK_HISTORY - running.length));
        state.backgroundTasks = [...running, ...completed];
    }
    return state;
}
/**
 * Get count of running background tasks.
 */
export function getRunningTaskCount(directory) {
    const state = readHudState(directory);
    if (!state)
        return 0;
    return state.backgroundTasks.filter((t) => t.status === 'running').length;
}
/**
 * Clear all background tasks.
 * Useful for cleanup or reset.
 */
export function clearBackgroundTasks(directory) {
    try {
        const state = createEmptyHudState();
        return writeHudState(state, directory);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=background-tasks.js.map
/**
 * OMC HUD - Background Task Cleanup
 *
 * Handles cleanup of stale and orphaned background tasks on HUD startup.
 */
import { readHudState, writeHudState } from './state.js';
const STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes default
/**
 * Parse task start time safely, handling both `startedAt` and legacy `startTime` alias.
 * Returns NaN when neither field contains a valid timestamp.
 */
function getTaskStartMs(task) {
    const raw = task.startedAt ?? task.startTime;
    if (!raw)
        return NaN;
    return new Date(raw).getTime();
}
/**
 * Clean up stale background tasks from HUD state.
 * Removes tasks that are old and not recently completed.
 *
 * @param thresholdMs Age threshold in milliseconds (default: 30 minutes)
 * @returns Number of tasks removed
 */
export async function cleanupStaleBackgroundTasks(thresholdMs = STALE_TASK_THRESHOLD_MS, directory) {
    const state = readHudState(directory);
    if (!state || !state.backgroundTasks) {
        return 0;
    }
    const now = Date.now();
    const originalCount = state.backgroundTasks.length;
    let statusChanged = false;
    // Mark stale running tasks as failed before filtering (consistent with cleanupTasks()
    // in background-tasks.ts) — prevents silently dropping running tasks
    for (const task of state.backgroundTasks) {
        if (task.status === 'running') {
            const startMs = getTaskStartMs(task);
            if (Number.isNaN(startMs)) {
                // Unparseable timestamp — treat as stale to avoid silent data loss
                task.status = 'failed';
                task.completedAt = new Date().toISOString();
                statusChanged = true;
            }
            else {
                const taskAge = now - startMs;
                if (taskAge > thresholdMs) {
                    task.status = 'failed';
                    task.completedAt = new Date().toISOString();
                    statusChanged = true;
                }
            }
        }
    }
    // Filter out expired completed/failed tasks (consistent with cleanupTasks()
    // in background-tasks.ts: running tasks always kept, completed/failed expire
    // based on completedAt)
    state.backgroundTasks = state.backgroundTasks.filter(task => {
        // Running tasks always kept (stale ones were already marked failed above)
        if (task.status === 'running')
            return true;
        // For completed/failed, expire based on completedAt
        if (task.completedAt) {
            const completedMs = new Date(task.completedAt).getTime();
            if (Number.isNaN(completedMs))
                return true;
            return now - completedMs < thresholdMs;
        }
        return true;
    });
    // Limit history to 20 most recent — preserve running tasks (consistent with
    // cleanupTasks() in background-tasks.ts)
    if (state.backgroundTasks.length > 20) {
        const running = state.backgroundTasks.filter(t => t.status === 'running');
        const nonRunning = state.backgroundTasks
            .filter(t => t.status !== 'running')
            .slice(-Math.max(0, 20 - running.length));
        state.backgroundTasks = [...running, ...nonRunning];
    }
    const removedCount = originalCount - state.backgroundTasks.length;
    if (removedCount > 0 || statusChanged) {
        state.timestamp = new Date().toISOString();
        writeHudState(state, directory);
    }
    return removedCount;
}
/**
 * Detect orphaned background tasks that are still marked as running
 * but are likely from a previous session crash.
 *
 * @returns Array of orphaned tasks
 */
export async function detectOrphanedTasks(directory) {
    const state = readHudState(directory);
    if (!state || !state.backgroundTasks) {
        return [];
    }
    // Detect tasks that are marked as running but should have completed
    // (e.g., from previous session crashes)
    const orphaned = [];
    for (const task of state.backgroundTasks) {
        if (task.status === 'running') {
            // Check if task is from a previous HUD session
            // (simple heuristic: running for more than 2 hours is likely orphaned)
            const taskAge = Date.now() - new Date(task.startedAt).getTime();
            const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
            if (taskAge > TWO_HOURS_MS) {
                orphaned.push(task);
            }
        }
    }
    return orphaned;
}
/**
 * Mark orphaned tasks as stale/completed to clean up the display.
 *
 * @returns Number of tasks marked
 */
export async function markOrphanedTasksAsStale(directory) {
    const state = readHudState(directory);
    if (!state || !state.backgroundTasks) {
        return 0;
    }
    const orphaned = await detectOrphanedTasks(directory);
    let marked = 0;
    for (const orphanedTask of orphaned) {
        const task = state.backgroundTasks.find(t => t.id === orphanedTask.id);
        if (task && task.status === 'running') {
            task.status = 'completed'; // Mark as completed to remove from active display
            marked++;
        }
    }
    if (marked > 0) {
        writeHudState(state, directory);
    }
    return marked;
}
//# sourceMappingURL=background-cleanup.js.map
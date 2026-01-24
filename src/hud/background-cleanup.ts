/**
 * OMC HUD - Background Task Cleanup
 *
 * Handles cleanup of stale and orphaned background tasks on HUD startup.
 */

import type { OmcHudState, BackgroundTask } from './types.js';
import { readHudState, writeHudState } from './state.js';

const STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes default

/**
 * Clean up stale background tasks from HUD state.
 * Removes tasks that are old and not recently completed.
 *
 * @param thresholdMs Age threshold in milliseconds (default: 30 minutes)
 * @returns Number of tasks removed
 */
export async function cleanupStaleBackgroundTasks(
  thresholdMs: number = STALE_TASK_THRESHOLD_MS
): Promise<number> {
  const state = readHudState();

  if (!state || !state.backgroundTasks) {
    return 0;
  }

  const now = Date.now();
  const originalCount = state.backgroundTasks.length;

  // Filter out stale tasks
  state.backgroundTasks = state.backgroundTasks.filter(task => {
    // Use startedAt for age calculation
    const taskAge = now - new Date(task.startedAt).getTime();

    // Keep if:
    // - Task is completed (for history)
    // - Task is recent (within threshold)
    return task.status === 'completed' || taskAge < thresholdMs;
  });

  // Limit history to 20 most recent
  if (state.backgroundTasks.length > 20) {
    state.backgroundTasks = state.backgroundTasks.slice(-20);
  }

  const removedCount = originalCount - state.backgroundTasks.length;

  if (removedCount > 0) {
    writeHudState(state);
  }

  return removedCount;
}

/**
 * Detect orphaned background tasks that are still marked as running
 * but are likely from a previous session crash.
 *
 * @returns Array of orphaned tasks
 */
export async function detectOrphanedTasks(): Promise<BackgroundTask[]> {
  const state = readHudState();

  if (!state || !state.backgroundTasks) {
    return [];
  }

  // Detect tasks that are marked as running but should have completed
  // (e.g., from previous session crashes)
  const orphaned: BackgroundTask[] = [];

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
export async function markOrphanedTasksAsStale(): Promise<number> {
  const state = readHudState();

  if (!state || !state.backgroundTasks) {
    return 0;
  }

  const orphaned = await detectOrphanedTasks();
  let marked = 0;

  for (const orphanedTask of orphaned) {
    const task = state.backgroundTasks.find(t => t.id === orphanedTask.id);
    if (task && task.status === 'running') {
      task.status = 'completed'; // Mark as completed to remove from active display
      marked++;
    }
  }

  if (marked > 0) {
    writeHudState(state);
  }

  return marked;
}

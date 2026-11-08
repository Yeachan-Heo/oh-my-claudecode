/**
 * OMC HUD - Background Task Management
 *
 * Functions for tracking background tasks via hooks.
 * Called from bridge.ts pre-tool-use and post-tool-use handlers.
 */

import { readHudState, writeHudState, createEmptyHudState } from './state.js';
import type { BackgroundTask, OmcHudState } from './types.js';

const MAX_TASK_HISTORY = 20;
const TASK_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Add a background task to HUD state.
 * Called when a Task tool starts with run_in_background=true.
 */
export function addBackgroundTask(
  id: string,
  description: string,
  agentType?: string,
  directory?: string,
  sessionId?: string
): boolean {
  try {
    let state = readHudState(directory, sessionId) || createEmptyHudState();

    // Add new task
    const task: BackgroundTask = {
      id,
      description,
      agentType,
      startedAt: new Date().toISOString(),
      status: 'running',
    };

    state.backgroundTasks.push(task);
    // Apply expiry and history capacity to the state that will be written.
    state = cleanupTasks(state);
    state.timestamp = new Date().toISOString();

    return writeHudState(state, directory, sessionId);
  } catch {
    return false;
  }
}

/**
 * Mark a background task as completed.
 * Called when a Task tool completes.
 */
export function completeBackgroundTask(
  id: string,
  directory?: string,
  failed: boolean = false,
  sessionId?: string
): boolean {
  try {
    const state = readHudState(directory, sessionId);
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

    return writeHudState(state, directory, sessionId);
  } catch {
    return false;
  }
}

/**
 * Remap a running background task from its launch-time hook id to the
 * async task id reported after launch.
 */
export function remapBackgroundTaskId(
  currentId: string,
  nextId: string,
  directory?: string,
  sessionId?: string
): boolean {
  try {
    if (currentId === nextId) {
      return true;
    }

    const state = readHudState(directory, sessionId);
    if (!state) {
      return false;
    }

    const task = state.backgroundTasks.find((t) => t.id === currentId);
    if (!task) {
      return false;
    }

    const existingTask = state.backgroundTasks.find((t) => t.id === nextId);
    if (existingTask && existingTask !== task) {
      return false;
    }

    task.id = nextId;
    state.timestamp = new Date().toISOString();

    return writeHudState(state, directory, sessionId);
  } catch {
    return false;
  }
}

function findMostRecentMatchingRunningTask(
  state: OmcHudState,
  description: string,
  agentType?: string
): BackgroundTask | undefined {
  return [...state.backgroundTasks]
    .filter((task) =>
      task.status === 'running'
      && task.description === description
      && (agentType === undefined || task.agentType === agentType)
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
}

export function completeMostRecentMatchingBackgroundTask(
  description: string,
  directory?: string,
  failed: boolean = false,
  agentType?: string,
  sessionId?: string
): boolean {
  try {
    const state = readHudState(directory, sessionId);
    if (!state) {
      return false;
    }

    const task = findMostRecentMatchingRunningTask(state, description, agentType);
    if (!task) {
      return false;
    }

    task.status = failed ? 'failed' : 'completed';
    task.completedAt = new Date().toISOString();
    state.timestamp = new Date().toISOString();

    return writeHudState(state, directory, sessionId);
  } catch {
    return false;
  }
}

export function remapMostRecentMatchingBackgroundTaskId(
  description: string,
  nextId: string,
  directory?: string,
  agentType?: string,
  sessionId?: string
): boolean {
  try {
    const state = readHudState(directory, sessionId);
    if (!state) {
      return false;
    }

    const task = findMostRecentMatchingRunningTask(state, description, agentType);
    if (!task) {
      return false;
    }

    const existingTask = state.backgroundTasks.find((t) => t.id === nextId);
    if (existingTask && existingTask !== task) {
      return false;
    }

    task.id = nextId;
    state.timestamp = new Date().toISOString();

    return writeHudState(state, directory, sessionId);
  } catch {
    return false;
  }
}

/**
 * Clean up old and expired tasks from state.
 */
function cleanupTasks(state: OmcHudState): OmcHudState {
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
    const historyCapacity = Math.max(0, MAX_TASK_HISTORY - running.length);
    const completed = historyCapacity === 0 ? [] : state.backgroundTasks
      .filter((t) => t.status !== 'running')
      .slice(-historyCapacity);

    state.backgroundTasks = [...running, ...completed];
  }

  return state;
}

/**
 * Get count of running background tasks.
 */
export function getRunningTaskCount(directory?: string, sessionId?: string): number {
  const state = readHudState(directory, sessionId);
  if (!state) return 0;

  return state.backgroundTasks.filter((t) => t.status === 'running').length;
}

/**
 * Clear all background tasks.
 * Useful for cleanup or reset.
 */
export function clearBackgroundTasks(directory?: string, sessionId?: string): boolean {
  try {
    // Read existing state to preserve session fields (sessionStartTimestamp, sessionId)
    const existing = readHudState(directory, sessionId);
    const state = createEmptyHudState();
    if (existing) {
      state.sessionStartTimestamp = existing.sessionStartTimestamp;
      state.sessionId = existing.sessionId;
    }
    return writeHudState(state, directory, sessionId);
  } catch {
    return false;
  }
}

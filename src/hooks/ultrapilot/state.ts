/**
 * Ultrapilot State Management
 *
 * Persistent state for ultrapilot workflow - tracks parallel workers,
 * file ownership, and progress.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { UltrapilotState, UltrapilotConfig, WorkerState, FileOwnership } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { canStartMode } from '../mode-registry/index.js';

const STATE_FILE = 'ultrapilot-state.json';
const OWNERSHIP_FILE = 'ultrapilot-ownership.json';

/**
 * Get the state file path
 */
function getStateFilePath(directory: string): string {
  const omcDir = join(directory, '.omc', 'state');
  return join(omcDir, STATE_FILE);
}

/**
 * Get the ownership file path
 */
function getOwnershipFilePath(directory: string): string {
  const omcDir = join(directory, '.omc', 'state');
  return join(omcDir, OWNERSHIP_FILE);
}

/**
 * Ensure the state directory exists
 */
function ensureStateDir(directory: string): void {
  const stateDir = join(directory, '.omc', 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Read ultrapilot state from disk
 */
export function readUltrapilotState(directory: string): UltrapilotState | null {
  const stateFile = getStateFilePath(directory);

  if (!existsSync(stateFile)) {
    return null;
  }

  try {
    const content = readFileSync(stateFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write ultrapilot state to disk
 */
export function writeUltrapilotState(directory: string, state: UltrapilotState): boolean {
  try {
    ensureStateDir(directory);
    const stateFile = getStateFilePath(directory);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear ultrapilot state
 */
export function clearUltrapilotState(directory: string): boolean {
  const stateFile = getStateFilePath(directory);
  const ownershipFile = getOwnershipFilePath(directory);

  try {
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
    }
    if (existsSync(ownershipFile)) {
      unlinkSync(ownershipFile);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if ultrapilot is active
 */
export function isUltrapilotActive(directory: string): boolean {
  const state = readUltrapilotState(directory);
  return state !== null && state.active === true;
}

/**
 * Initialize a new ultrapilot session
 */
export function initUltrapilot(
  directory: string,
  task: string,
  subtasks: string[],
  sessionId?: string,
  config?: Partial<UltrapilotConfig>
): UltrapilotState | null {
  // Mutual exclusion check via mode-registry
  const canStart = canStartMode('ultrapilot', directory);
  if (!canStart.allowed) {
    console.error(canStart.message);
    return null;
  }

  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const now = new Date().toISOString();

  const state: UltrapilotState = {
    active: true,
    iteration: 1,
    maxIterations: mergedConfig.maxIterations,
    originalTask: task,
    subtasks,
    workers: [],
    ownership: {
      coordinator: mergedConfig.sharedFiles,
      workers: {},
      conflicts: []
    },
    startedAt: now,
    completedAt: null,
    totalWorkersSpawned: 0,
    successfulWorkers: 0,
    failedWorkers: 0,
    sessionId
  };

  writeUltrapilotState(directory, state);
  return state;
}

/**
 * Update worker state
 */
export function updateWorkerState(
  directory: string,
  workerId: string,
  updates: Partial<WorkerState>
): boolean {
  const state = readUltrapilotState(directory);
  if (!state) return false;

  const workerIndex = state.workers.findIndex((w) => w.id === workerId);
  if (workerIndex === -1) return false;

  state.workers[workerIndex] = { ...state.workers[workerIndex], ...updates };
  return writeUltrapilotState(directory, state);
}

/**
 * Add a new worker
 */
export function addWorker(directory: string, worker: WorkerState): boolean {
  const state = readUltrapilotState(directory);
  if (!state) return false;

  state.workers.push(worker);
  state.totalWorkersSpawned += 1;

  // Update ownership
  state.ownership.workers[worker.id] = worker.ownedFiles;

  return writeUltrapilotState(directory, state);
}

/**
 * Mark worker as complete
 */
export function completeWorker(
  directory: string,
  workerId: string,
  filesCreated: string[],
  filesModified: string[]
): boolean {
  const state = readUltrapilotState(directory);
  if (!state) return false;

  const workerIndex = state.workers.findIndex((w) => w.id === workerId);
  if (workerIndex === -1) return false;

  state.workers[workerIndex].status = 'complete';
  state.workers[workerIndex].completedAt = new Date().toISOString();
  state.workers[workerIndex].filesCreated = filesCreated;
  state.workers[workerIndex].filesModified = filesModified;
  state.successfulWorkers += 1;

  return writeUltrapilotState(directory, state);
}

/**
 * Mark worker as failed
 */
export function failWorker(directory: string, workerId: string, error: string): boolean {
  const state = readUltrapilotState(directory);
  if (!state) return false;

  const workerIndex = state.workers.findIndex((w) => w.id === workerId);
  if (workerIndex === -1) return false;

  state.workers[workerIndex].status = 'failed';
  state.workers[workerIndex].completedAt = new Date().toISOString();
  state.workers[workerIndex].error = error;
  state.failedWorkers += 1;

  return writeUltrapilotState(directory, state);
}

/**
 * Complete ultrapilot session
 */
export function completeUltrapilot(directory: string): boolean {
  const state = readUltrapilotState(directory);
  if (!state) return false;

  state.active = false;
  state.completedAt = new Date().toISOString();

  return writeUltrapilotState(directory, state);
}

/**
 * Read file ownership mapping
 */
export function readFileOwnership(directory: string): FileOwnership | null {
  const ownershipFile = getOwnershipFilePath(directory);

  if (!existsSync(ownershipFile)) {
    return null;
  }

  try {
    const content = readFileSync(ownershipFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write file ownership mapping
 */
export function writeFileOwnership(directory: string, ownership: FileOwnership): boolean {
  try {
    ensureStateDir(directory);
    const ownershipFile = getOwnershipFilePath(directory);
    writeFileSync(ownershipFile, JSON.stringify(ownership, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a file conflict
 */
export function recordConflict(directory: string, filePath: string): boolean {
  const state = readUltrapilotState(directory);
  if (!state) return false;

  if (!state.ownership.conflicts.includes(filePath)) {
    state.ownership.conflicts.push(filePath);
  }

  return writeUltrapilotState(directory, state);
}

/**
 * Get all completed workers
 */
export function getCompletedWorkers(directory: string): WorkerState[] {
  const state = readUltrapilotState(directory);
  if (!state) return [];

  return state.workers.filter((w) => w.status === 'complete');
}

/**
 * Get all running workers
 */
export function getRunningWorkers(directory: string): WorkerState[] {
  const state = readUltrapilotState(directory);
  if (!state) return [];

  return state.workers.filter((w) => w.status === 'running');
}

/**
 * Get all failed workers
 */
export function getFailedWorkers(directory: string): WorkerState[] {
  const state = readUltrapilotState(directory);
  if (!state) return [];

  return state.workers.filter((w) => w.status === 'failed');
}

/**
 * Ultrapilot State Management
 *
 * Persistent state for ultrapilot workflow - tracks parallel workers,
 * file ownership, and progress.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DEFAULT_CONFIG } from './types.js';
import { resolveSessionStatePath, ensureSessionStateDir, getOmcRoot } from '../../lib/worktree-paths.js';
const STATE_FILE = 'ultrapilot-state.json';
const OWNERSHIP_FILE = 'ultrapilot-ownership.json';
/**
 * Get the state file path
 */
function getStateFilePath(directory, sessionId) {
    if (sessionId) {
        return resolveSessionStatePath('ultrapilot', sessionId, directory);
    }
    const omcDir = join(getOmcRoot(directory), 'state');
    return join(omcDir, STATE_FILE);
}
/**
 * Get the ownership file path
 */
function getOwnershipFilePath(directory, sessionId) {
    if (sessionId) {
        // Store ownership file next to state file in session directory
        const sessionDir = join(getOmcRoot(directory), 'state', 'sessions', sessionId);
        return join(sessionDir, OWNERSHIP_FILE);
    }
    const omcDir = join(getOmcRoot(directory), 'state');
    return join(omcDir, OWNERSHIP_FILE);
}
/**
 * Ensure the state directory exists
 */
function ensureStateDir(directory, sessionId) {
    if (sessionId) {
        ensureSessionStateDir(sessionId, directory);
        return;
    }
    const stateDir = join(getOmcRoot(directory), 'state');
    if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
    }
}
/**
 * Read ultrapilot state from disk
 */
export function readUltrapilotState(directory, sessionId) {
    // Try session-scoped path first
    if (sessionId) {
        const sessionFile = getStateFilePath(directory, sessionId);
        if (existsSync(sessionFile)) {
            try {
                const content = readFileSync(sessionFile, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                // Fall through to legacy path
            }
        }
    }
    // Fallback to legacy path
    const stateFile = getStateFilePath(directory);
    if (!existsSync(stateFile)) {
        return null;
    }
    try {
        const content = readFileSync(stateFile, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Write ultrapilot state to disk
 */
export function writeUltrapilotState(directory, state, sessionId) {
    try {
        ensureStateDir(directory, sessionId);
        const stateFile = getStateFilePath(directory, sessionId);
        writeFileSync(stateFile, JSON.stringify(state, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Clear ultrapilot state
 */
export function clearUltrapilotState(directory, sessionId) {
    const stateFile = getStateFilePath(directory, sessionId);
    const ownershipFile = getOwnershipFilePath(directory, sessionId);
    try {
        if (existsSync(stateFile)) {
            unlinkSync(stateFile);
        }
        if (existsSync(ownershipFile)) {
            unlinkSync(ownershipFile);
        }
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Check if ultrapilot is active
 */
export function isUltrapilotActive(directory, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    return state !== null && state.active === true;
}
/**
 * Initialize a new ultrapilot session
 */
export function initUltrapilot(directory, task, subtasks, sessionId, config) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const now = new Date().toISOString();
    const state = {
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
        sessionId,
        project_path: directory
    };
    writeUltrapilotState(directory, state, sessionId);
    return state;
}
/**
 * Update worker state
 */
export function updateWorkerState(directory, workerId, updates, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return false;
    const workerIndex = state.workers.findIndex((w) => w.id === workerId);
    if (workerIndex === -1)
        return false;
    state.workers[workerIndex] = { ...state.workers[workerIndex], ...updates };
    return writeUltrapilotState(directory, state, sessionId);
}
/**
 * Add a new worker
 */
export function addWorker(directory, worker, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return false;
    state.workers.push(worker);
    state.totalWorkersSpawned += 1;
    // Update ownership
    state.ownership.workers[worker.id] = worker.ownedFiles;
    return writeUltrapilotState(directory, state, sessionId);
}
/**
 * Mark worker as complete
 */
export function completeWorker(directory, workerId, filesCreated, filesModified, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return false;
    const workerIndex = state.workers.findIndex((w) => w.id === workerId);
    if (workerIndex === -1)
        return false;
    state.workers[workerIndex].status = 'complete';
    state.workers[workerIndex].completedAt = new Date().toISOString();
    state.workers[workerIndex].filesCreated = filesCreated;
    state.workers[workerIndex].filesModified = filesModified;
    state.successfulWorkers += 1;
    return writeUltrapilotState(directory, state, sessionId);
}
/**
 * Mark worker as failed
 */
export function failWorker(directory, workerId, error, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return false;
    const workerIndex = state.workers.findIndex((w) => w.id === workerId);
    if (workerIndex === -1)
        return false;
    state.workers[workerIndex].status = 'failed';
    state.workers[workerIndex].completedAt = new Date().toISOString();
    state.workers[workerIndex].error = error;
    state.failedWorkers += 1;
    return writeUltrapilotState(directory, state, sessionId);
}
/**
 * Complete ultrapilot session
 */
export function completeUltrapilot(directory, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return false;
    state.active = false;
    state.completedAt = new Date().toISOString();
    return writeUltrapilotState(directory, state, sessionId);
}
/**
 * Read file ownership mapping
 */
export function readFileOwnership(directory, sessionId) {
    // Try session-scoped path first
    if (sessionId) {
        const sessionFile = getOwnershipFilePath(directory, sessionId);
        if (existsSync(sessionFile)) {
            try {
                const content = readFileSync(sessionFile, 'utf-8');
                return JSON.parse(content);
            }
            catch {
                // Fall through to legacy path
            }
        }
    }
    // Fallback to legacy path
    const ownershipFile = getOwnershipFilePath(directory);
    if (!existsSync(ownershipFile)) {
        return null;
    }
    try {
        const content = readFileSync(ownershipFile, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Write file ownership mapping
 */
export function writeFileOwnership(directory, ownership, sessionId) {
    try {
        ensureStateDir(directory, sessionId);
        const ownershipFile = getOwnershipFilePath(directory, sessionId);
        writeFileSync(ownershipFile, JSON.stringify(ownership, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Record a file conflict
 */
export function recordConflict(directory, filePath, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return false;
    if (!state.ownership.conflicts.includes(filePath)) {
        state.ownership.conflicts.push(filePath);
    }
    return writeUltrapilotState(directory, state, sessionId);
}
/**
 * Get all completed workers
 */
export function getCompletedWorkers(directory, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return [];
    return state.workers.filter((w) => w.status === 'complete');
}
/**
 * Get all running workers
 */
export function getRunningWorkers(directory, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return [];
    return state.workers.filter((w) => w.status === 'running');
}
/**
 * Get all failed workers
 */
export function getFailedWorkers(directory, sessionId) {
    const state = readUltrapilotState(directory, sessionId);
    if (!state)
        return [];
    return state.workers.filter((w) => w.status === 'failed');
}
//# sourceMappingURL=state.js.map
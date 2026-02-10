/**
 * Ultrapilot State Management
 *
 * Persistent state for ultrapilot workflow - tracks parallel workers,
 * file ownership, and progress.
 */
import type { UltrapilotState, UltrapilotConfig, WorkerState, FileOwnership } from './types.js';
/**
 * Read ultrapilot state from disk
 */
export declare function readUltrapilotState(directory: string, sessionId?: string): UltrapilotState | null;
/**
 * Write ultrapilot state to disk
 */
export declare function writeUltrapilotState(directory: string, state: UltrapilotState, sessionId?: string): boolean;
/**
 * Clear ultrapilot state
 */
export declare function clearUltrapilotState(directory: string, sessionId?: string): boolean;
/**
 * Check if ultrapilot is active
 */
export declare function isUltrapilotActive(directory: string, sessionId?: string): boolean;
/**
 * Initialize a new ultrapilot session
 */
export declare function initUltrapilot(directory: string, task: string, subtasks: string[], sessionId?: string, config?: Partial<UltrapilotConfig>): UltrapilotState | null;
/**
 * Update worker state
 */
export declare function updateWorkerState(directory: string, workerId: string, updates: Partial<WorkerState>, sessionId?: string): boolean;
/**
 * Add a new worker
 */
export declare function addWorker(directory: string, worker: WorkerState, sessionId?: string): boolean;
/**
 * Mark worker as complete
 */
export declare function completeWorker(directory: string, workerId: string, filesCreated: string[], filesModified: string[], sessionId?: string): boolean;
/**
 * Mark worker as failed
 */
export declare function failWorker(directory: string, workerId: string, error: string, sessionId?: string): boolean;
/**
 * Complete ultrapilot session
 */
export declare function completeUltrapilot(directory: string, sessionId?: string): boolean;
/**
 * Read file ownership mapping
 */
export declare function readFileOwnership(directory: string, sessionId?: string): FileOwnership | null;
/**
 * Write file ownership mapping
 */
export declare function writeFileOwnership(directory: string, ownership: FileOwnership, sessionId?: string): boolean;
/**
 * Record a file conflict
 */
export declare function recordConflict(directory: string, filePath: string, sessionId?: string): boolean;
/**
 * Get all completed workers
 */
export declare function getCompletedWorkers(directory: string, sessionId?: string): WorkerState[];
/**
 * Get all running workers
 */
export declare function getRunningWorkers(directory: string, sessionId?: string): WorkerState[];
/**
 * Get all failed workers
 */
export declare function getFailedWorkers(directory: string, sessionId?: string): WorkerState[];
//# sourceMappingURL=state.d.ts.map
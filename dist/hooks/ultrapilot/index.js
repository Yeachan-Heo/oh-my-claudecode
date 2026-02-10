/**
 * Ultrapilot Coordinator
 *
 * Manages parallel worker spawning and coordination for ultrapilot mode.
 * Decomposes tasks, spawns workers (max 5), tracks progress, and integrates results
 * while managing file ownership to avoid conflicts.
 */
import { DEFAULT_CONFIG } from './types.js';
import { readUltrapilotState, writeUltrapilotState, initUltrapilot, addWorker, getCompletedWorkers, getRunningWorkers, getFailedWorkers, recordConflict } from './state.js';
// AI-powered decomposition utilities
// TODO: Use these with the Architect agent for intelligent task decomposition
// Example integration:
//   const prompt = generateDecompositionPrompt(task, codebaseContext);
//   const response = await Task({ subagent_type: 'architect', prompt });
//   const result = parseDecompositionResult(response);
//   const subtasks = toSimpleSubtasks(result);
export { generateDecompositionPrompt, parseDecompositionResult, generateParallelGroups, validateFileOwnership, extractSharedFiles, toSimpleSubtasks, DEFAULT_SHARED_FILE_PATTERNS } from './decomposer.js';
/**
 * Start ultrapilot coordinator
 *
 * Entry point for ultrapilot - decomposes task and spawns parallel workers.
 *
 * @param cwd - Current working directory
 * @param task - Task description to parallelize
 * @param config - Configuration options
 * @returns Initialized ultrapilot state
 */
export async function startUltrapilot(cwd, task, config, sessionId) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    // Decompose task into parallelizable subtasks
    const subtasks = await decomposeTask(task, mergedConfig);
    // Initialize state
    const state = initUltrapilot(cwd, task, subtasks, sessionId, mergedConfig);
    if (!state) {
        throw new Error('Failed to initialize ultrapilot: another mode is active');
    }
    return state;
}
/**
 * Decompose a task into parallelizable subtasks
 *
 * Uses heuristics to identify independent work units that can be executed in parallel.
 * For more intelligent decomposition with file ownership and dependencies, use the
 * AI-powered decomposition functions:
 *
 * @example AI-powered decomposition (recommended for complex tasks):
 * ```typescript
 * import {
 *   generateDecompositionPrompt,
 *   parseDecompositionResult,
 *   toSimpleSubtasks
 * } from './decomposer.js';
 *
 * // Generate prompt for Architect agent
 * const prompt = generateDecompositionPrompt(task, codebaseContext);
 *
 * // Call Architect agent (via Task tool in orchestrator)
 * const response = await Task({
 *   subagent_type: 'oh-my-claudecode:architect',
 *   model: 'opus',
 *   prompt
 * });
 *
 * // Parse structured result with file ownership
 * const result = parseDecompositionResult(response);
 *
 * // Use result.subtasks for full DecomposedTask objects with:
 * // - id, description, files, blockedBy, agentType, model
 * // Or convert to simple strings for legacy compatibility:
 * const subtasks = toSimpleSubtasks(result);
 * ```
 *
 * @param task - Task description
 * @param config - Configuration options
 * @returns Array of subtask descriptions
 */
export async function decomposeTask(task, config) {
    // Heuristic-based decomposition for simple cases
    // For complex tasks, use generateDecompositionPrompt() with Architect agent
    // to get structured DecompositionResult with file ownership and dependencies
    const subtasks = [];
    // Look for explicit lists (numbered or bulleted)
    const listItemPattern = /^[\s]*(?:\d+\.|[-*+])\s+(.+)$/gm;
    const matches = task.matchAll(listItemPattern);
    for (const match of matches) {
        if (match[1]) {
            subtasks.push(match[1].trim());
        }
    }
    // If no explicit list found, look for sentences separated by periods or newlines
    if (subtasks.length === 0) {
        const sentences = task
            .split(/[.;\n]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 10); // Filter out very short fragments
        subtasks.push(...sentences);
    }
    // If still no subtasks, treat entire task as single unit
    if (subtasks.length === 0) {
        subtasks.push(task);
    }
    // Limit to maxWorkers
    return subtasks.slice(0, config.maxWorkers);
}
/**
 * Spawn parallel workers for subtasks
 *
 * Creates Task agents for each subtask with non-overlapping file ownership.
 *
 * @param cwd - Current working directory
 * @param subtasks - Array of subtask descriptions
 * @param config - Configuration options
 * @returns Array of spawned worker states
 */
export async function spawnWorkers(cwd, subtasks, config) {
    const state = readUltrapilotState(cwd);
    if (!state) {
        throw new Error('Ultrapilot not initialized');
    }
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const workers = [];
    for (let i = 0; i < subtasks.length; i++) {
        const workerId = `worker-${i + 1}`;
        const worker = {
            id: workerId,
            index: i,
            task: subtasks[i],
            ownedFiles: [], // Will be assigned during execution
            status: 'pending',
            startedAt: new Date().toISOString(),
            filesCreated: [],
            filesModified: []
        };
        workers.push(worker);
        addWorker(cwd, worker);
    }
    return workers;
}
/**
 * Track progress of running workers
 *
 * Polls TaskOutput to check worker status and updates state accordingly.
 *
 * @param cwd - Current working directory
 * @returns Object with completed, running, and failed worker counts
 */
export async function trackProgress(cwd) {
    const state = readUltrapilotState(cwd);
    if (!state) {
        return { completed: 0, running: 0, failed: 0, total: 0 };
    }
    const completed = getCompletedWorkers(cwd);
    const running = getRunningWorkers(cwd);
    const failed = getFailedWorkers(cwd);
    return {
        completed: completed.length,
        running: running.length,
        failed: failed.length,
        total: state.workers.length
    };
}
/**
 * Integrate results from completed workers
 *
 * Merges outputs, detects conflicts, and produces final integration result.
 *
 * @param cwd - Current working directory
 * @returns Integration result with files, conflicts, and summary
 */
export async function integrateResults(cwd) {
    const state = readUltrapilotState(cwd);
    if (!state) {
        return {
            success: false,
            filesCreated: [],
            filesModified: [],
            conflicts: [],
            errors: ['Ultrapilot not initialized'],
            summary: 'Integration failed: no state found'
        };
    }
    const completed = getCompletedWorkers(cwd);
    const failed = getFailedWorkers(cwd);
    const filesCreated = new Set();
    const filesModified = new Set();
    const errors = [];
    // Collect files from completed workers
    for (const worker of completed) {
        worker.filesCreated.forEach((f) => filesCreated.add(f));
        worker.filesModified.forEach((f) => filesModified.add(f));
    }
    // Collect errors from failed workers
    for (const worker of failed) {
        if (worker.error) {
            errors.push(`Worker ${worker.id}: ${worker.error}`);
        }
    }
    // Check for conflicts (files modified by multiple workers)
    const conflicts = detectFileConflicts(state);
    const success = errors.length === 0 && conflicts.length === 0;
    const summary = generateIntegrationSummary(state, completed, failed, conflicts);
    return {
        success,
        filesCreated: Array.from(filesCreated),
        filesModified: Array.from(filesModified),
        conflicts,
        errors,
        summary
    };
}
/**
 * Detect conflicts where multiple workers modified the same file
 */
function detectFileConflicts(state) {
    const fileToWorkers = new Map();
    // Build map of files to workers that modified them
    for (const worker of state.workers) {
        if (worker.status !== 'complete')
            continue;
        for (const file of worker.filesModified) {
            if (!fileToWorkers.has(file)) {
                fileToWorkers.set(file, []);
            }
            fileToWorkers.get(file).push(worker.id);
        }
    }
    // Find files with multiple workers
    const conflicts = [];
    for (const [file, workers] of fileToWorkers.entries()) {
        if (workers.length > 1) {
            conflicts.push(file);
        }
    }
    return conflicts;
}
/**
 * Generate integration summary
 */
function generateIntegrationSummary(state, completed, failed, conflicts) {
    const lines = [];
    lines.push(`Ultrapilot Integration Summary`);
    lines.push(`==============================`);
    lines.push(`Original Task: ${state.originalTask}`);
    lines.push(``);
    lines.push(`Workers: ${state.workers.length} total`);
    lines.push(`  - Completed: ${completed.length}`);
    lines.push(`  - Failed: ${failed.length}`);
    lines.push(``);
    if (completed.length > 0) {
        lines.push(`Completed Workers:`);
        for (const worker of completed) {
            lines.push(`  - ${worker.id}: ${worker.task}`);
            if (worker.filesCreated.length > 0) {
                lines.push(`    Created: ${worker.filesCreated.join(', ')}`);
            }
            if (worker.filesModified.length > 0) {
                lines.push(`    Modified: ${worker.filesModified.join(', ')}`);
            }
        }
        lines.push(``);
    }
    if (failed.length > 0) {
        lines.push(`Failed Workers:`);
        for (const worker of failed) {
            lines.push(`  - ${worker.id}: ${worker.task}`);
            lines.push(`    Error: ${worker.error || 'Unknown error'}`);
        }
        lines.push(``);
    }
    if (conflicts.length > 0) {
        lines.push(`Conflicts Detected:`);
        for (const file of conflicts) {
            lines.push(`  - ${file}`);
        }
        lines.push(``);
        lines.push(`Manual resolution required for conflicting files.`);
    }
    return lines.join('\n');
}
/**
 * Handle shared files that multiple workers might need to access
 *
 * Coordinator maintains exclusive ownership of shared files (package.json, etc.)
 * and provides a mechanism for workers to request changes.
 *
 * @param cwd - Current working directory
 * @param files - List of files to mark as shared
 * @returns Updated ownership state
 */
export async function handleSharedFiles(cwd, files) {
    const state = readUltrapilotState(cwd);
    if (!state)
        return false;
    // Add files to coordinator ownership
    for (const file of files) {
        if (!state.ownership.coordinator.includes(file)) {
            state.ownership.coordinator.push(file);
        }
    }
    return writeUltrapilotState(cwd, state);
}
/**
 * Check if a file is owned by a specific worker
 */
export function isFileOwnedByWorker(cwd, workerId, filePath) {
    const state = readUltrapilotState(cwd);
    if (!state)
        return false;
    const ownedFiles = state.ownership.workers[workerId];
    if (!ownedFiles)
        return false;
    return ownedFiles.includes(filePath);
}
/**
 * Check if a file is shared (owned by coordinator)
 */
export function isSharedFile(cwd, filePath) {
    const state = readUltrapilotState(cwd);
    if (!state)
        return false;
    return state.ownership.coordinator.includes(filePath);
}
/**
 * Assign file ownership to a worker
 */
export function assignFileToWorker(cwd, workerId, filePath) {
    const state = readUltrapilotState(cwd);
    if (!state)
        return false;
    // Check if file is already owned by another worker or coordinator
    if (isSharedFile(cwd, filePath)) {
        return false; // Cannot reassign shared files
    }
    for (const [id, files] of Object.entries(state.ownership.workers)) {
        if (id !== workerId && files.includes(filePath)) {
            recordConflict(cwd, filePath);
            return false; // Already owned by another worker
        }
    }
    // Assign to worker
    if (!state.ownership.workers[workerId]) {
        state.ownership.workers[workerId] = [];
    }
    if (!state.ownership.workers[workerId].includes(filePath)) {
        state.ownership.workers[workerId].push(filePath);
    }
    return writeUltrapilotState(cwd, state);
}
export { DEFAULT_CONFIG } from './types.js';
export { readUltrapilotState, writeUltrapilotState, initUltrapilot, addWorker, updateWorkerState, completeWorker, failWorker, completeUltrapilot, getCompletedWorkers, getRunningWorkers, getFailedWorkers, recordConflict } from './state.js';
//# sourceMappingURL=index.js.map
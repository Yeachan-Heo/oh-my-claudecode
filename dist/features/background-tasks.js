/**
 * Background Task Management
 *
 * Provides utilities for managing background task execution,
 * similar to oh-my-opencode's Background Task Manager.
 *
 * In Claude Code, background execution is controlled via:
 * - Bash tool's `run_in_background` parameter
 * - Task tool's `run_in_background` parameter
 * - TaskOutput tool for retrieving results
 *
 * This module provides:
 * - Decision heuristics for when to use background execution
 * - Task lifecycle management
 * - Concurrency limit enforcement
 * - System prompt guidance for agents
 */
/**
 * Default maximum concurrent background tasks
 */
export const DEFAULT_MAX_BACKGROUND_TASKS = 5;
/**
 * Patterns that indicate long-running operations
 * These should typically run in background
 */
export const LONG_RUNNING_PATTERNS = [
    // Package managers
    /\b(npm|yarn|pnpm|bun)\s+(install|ci|update|upgrade)\b/i,
    /\b(pip|pip3)\s+install\b/i,
    /\bcargo\s+(build|install|test)\b/i,
    /\bgo\s+(build|install|test)\b/i,
    /\brustup\s+(update|install)\b/i,
    /\bgem\s+install\b/i,
    /\bcomposer\s+install\b/i,
    /\bmaven|mvn\s+(install|package|test)\b/i,
    /\bgradle\s+(build|test)\b/i,
    // Build commands
    /\b(npm|yarn|pnpm|bun)\s+run\s+(build|compile|bundle)\b/i,
    /\bmake\s*(all|build|install)?\s*$/i,
    /\bcmake\s+--build\b/i,
    /\btsc\s+(--build|-b)?\b/i,
    /\bwebpack\b/i,
    /\brollup\b/i,
    /\besbuild\b/i,
    /\bvite\s+build\b/i,
    // Test suites
    /\b(npm|yarn|pnpm|bun)\s+run\s+test\b/i,
    /\b(jest|mocha|vitest|pytest|cargo\s+test)\b/i,
    /\bgo\s+test\b/i,
    // Docker operations
    /\bdocker\s+(build|pull|push)\b/i,
    /\bdocker-compose\s+(up|build)\b/i,
    // Database operations
    /\b(prisma|typeorm|sequelize)\s+(migrate|generate|push)\b/i,
    // Linting large codebases
    /\b(eslint|prettier)\s+[^|]*\.\s*$/i,
    // Git operations on large repos
    /\bgit\s+(clone|fetch|pull)\b/i,
];
/**
 * Patterns that should always run blocking (foreground)
 * These are quick operations or need immediate feedback
 */
export const BLOCKING_PATTERNS = [
    // Quick status checks
    /\bgit\s+(status|diff|log|branch)\b/i,
    /\bls\b/i,
    /\bpwd\b/i,
    /\bcat\b/i,
    /\becho\b/i,
    /\bhead\b/i,
    /\btail\b/i,
    /\bwc\b/i,
    /\bwhich\b/i,
    /\btype\b/i,
    // File operations
    /\bcp\b/i,
    /\bmv\b/i,
    /\brm\b/i,
    /\bmkdir\b/i,
    /\btouch\b/i,
    // Environment checks
    /\benv\b/i,
    /\bprintenv\b/i,
    /\bnode\s+-[vpe]\b/i,
    /\bnpm\s+-v\b/i,
    /\bpython\s+--version\b/i,
];
/**
 * Determine if a command should run in background
 *
 * This is the core heuristic function that decides whether a command
 * should be executed with `run_in_background: true`.
 *
 * @param command - The command to analyze
 * @param currentBackgroundCount - Number of currently running background tasks
 * @param maxBackgroundTasks - Maximum allowed concurrent background tasks
 * @returns Decision object with recommendation and reasoning
 */
export function shouldRunInBackground(command, currentBackgroundCount = 0, maxBackgroundTasks = DEFAULT_MAX_BACKGROUND_TASKS) {
    // Check if at capacity
    if (currentBackgroundCount >= maxBackgroundTasks) {
        return {
            runInBackground: false,
            reason: `At background task limit (${currentBackgroundCount}/${maxBackgroundTasks}). Wait for existing tasks or run blocking.`,
            estimatedDuration: 'unknown',
            confidence: 'high'
        };
    }
    // Check for explicit blocking patterns first
    for (const pattern of BLOCKING_PATTERNS) {
        if (pattern.test(command)) {
            return {
                runInBackground: false,
                reason: 'Quick operation that should complete immediately.',
                estimatedDuration: 'quick',
                confidence: 'high'
            };
        }
    }
    // Check for long-running patterns
    for (const pattern of LONG_RUNNING_PATTERNS) {
        if (pattern.test(command)) {
            return {
                runInBackground: true,
                reason: 'Long-running operation detected. Run in background to continue other work.',
                estimatedDuration: 'long',
                confidence: 'high'
            };
        }
    }
    // Heuristic: commands with multiple operations (piped or chained)
    if ((command.match(/\|/g) || []).length > 2 || (command.match(/&&/g) || []).length > 2) {
        return {
            runInBackground: true,
            reason: 'Complex command chain that may take time.',
            estimatedDuration: 'medium',
            confidence: 'medium'
        };
    }
    // Default: run blocking for unknown commands
    return {
        runInBackground: false,
        reason: 'Unknown command type. Running blocking for immediate feedback.',
        estimatedDuration: 'unknown',
        confidence: 'low'
    };
}
/**
 * Create a BackgroundTaskManager instance
 */
export function createBackgroundTaskManager(state, config) {
    const maxBackgroundTasks = config.permissions?.maxBackgroundTasks ?? DEFAULT_MAX_BACKGROUND_TASKS;
    return {
        registerTask(agentName, prompt) {
            const task = {
                id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                agentName,
                prompt,
                status: 'pending'
            };
            state.backgroundTasks.push(task);
            return task;
        },
        getTasks() {
            return [...state.backgroundTasks];
        },
        getTasksByStatus(status) {
            return state.backgroundTasks.filter(t => t.status === status);
        },
        getRunningCount() {
            return state.backgroundTasks.filter(t => t.status === 'running' || t.status === 'pending').length;
        },
        canStartNewTask() {
            return this.getRunningCount() < maxBackgroundTasks;
        },
        updateTaskStatus(taskId, status, result, error) {
            const task = state.backgroundTasks.find(t => t.id === taskId);
            if (task) {
                task.status = status;
                if (result !== undefined)
                    task.result = result;
                if (error !== undefined)
                    task.error = error;
            }
        },
        completeTask(taskId, result) {
            this.updateTaskStatus(taskId, 'completed', result);
        },
        failTask(taskId, error) {
            this.updateTaskStatus(taskId, 'error', undefined, error);
        },
        pruneCompletedTasks(_maxAge = 5 * 60 * 1000) {
            // Note: maxAge-based pruning would require tracking task completion timestamps
            // For now, just prune all completed/errored tasks
            const before = state.backgroundTasks.length;
            state.backgroundTasks = state.backgroundTasks.filter(t => t.status !== 'completed' && t.status !== 'error');
            return before - state.backgroundTasks.length;
        },
        getMaxTasks() {
            return maxBackgroundTasks;
        },
        shouldRunInBackground(command) {
            return shouldRunInBackground(command, this.getRunningCount(), maxBackgroundTasks);
        }
    };
}
/**
 * System prompt guidance for background task execution
 *
 * This text should be appended to the system prompt to guide agents
 * on when and how to use background execution.
 */
export function getBackgroundTaskGuidance(maxBackgroundTasks = DEFAULT_MAX_BACKGROUND_TASKS) {
    return `
## Background Task Execution

For long-running operations, use the \`run_in_background\` parameter to avoid blocking.

### When to Use Background Execution

**Run in Background** (set \`run_in_background: true\`):
- Package installation (\`npm install\`, \`pip install\`, \`cargo build\`, etc.)
- Build processes (project build command, \`make\`, etc.)
- Test suites (project test command, etc.)
- Docker operations: \`docker build\`, \`docker pull\`
- Git operations on large repos: \`git clone\`, \`git fetch\`
- Database migrations: \`prisma migrate\`, \`typeorm migration:run\`

**Run Blocking** (foreground, immediate):
- Quick status checks: \`git status\`, \`ls\`, \`pwd\`
- File operations: \`cat\`, \`head\`, \`tail\`
- Simple commands: \`echo\`, \`which\`, \`env\`
- Operations needing immediate feedback

### How to Use Background Execution

1. **Start in background:**
   \`\`\`
   Bash(command: "project build command", run_in_background: true)
   \`\`\`

2. **Continue with other work** while the task runs

3. **Check results later:**
   \`\`\`
   TaskOutput(task_id: "<task_id_from_step_1>", block: false)
   \`\`\`

### Concurrency Limits

- Maximum **${maxBackgroundTasks}** concurrent background tasks
- If at limit, wait for existing tasks to complete or run the new task blocking
- Use \`TaskOutput\` to check if background tasks have finished

### Decision Checklist

Before running a command, ask:
1. Will this take more than 5 seconds? → Consider background
2. Do I need the result immediately? → Run blocking
3. Can I do other useful work while waiting? → Use background
4. Am I at the background task limit? → Run blocking or wait
`;
}
//# sourceMappingURL=background-tasks.js.map
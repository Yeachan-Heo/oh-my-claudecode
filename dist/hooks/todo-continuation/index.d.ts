/**
 * Todo Continuation Enforcer Hook
 *
 * Prevents stopping when incomplete tasks remain in the todo list.
 * Forces the agent to continue until all tasks are marked complete.
 *
 * Ported from oh-my-opencode's todo-continuation-enforcer hook.
 */
/**
 * Validates that a session ID is safe to use in file paths.
 * Session IDs should be alphanumeric with optional hyphens and underscores.
 * This prevents path traversal attacks (e.g., "../../../etc").
 *
 * @param sessionId - The session ID to validate
 * @returns true if the session ID is safe, false otherwise
 */
export declare function isValidSessionId(sessionId: string): boolean;
export interface Todo {
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority?: string;
    id?: string;
}
/**
 * Claude Code Task system task
 *
 * IMPORTANT: This interface is based on observed behavior and the TaskCreate/TaskUpdate
 * tool schema. The file structure ~/.claude/tasks/{sessionId}/{taskId}.json is inferred
 * from Claude Code's implementation and may change in future versions.
 *
 * As of 2025-01, Anthropic has not published official documentation for the Task system
 * file format. This implementation should be verified empirically when issues arise.
 *
 * @see https://docs.anthropic.com/en/docs/claude-code (check for updates)
 */
export interface Task {
    id: string;
    subject: string;
    description?: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'deleted';
    blocks?: string[];
    blockedBy?: string[];
}
/** Internal result for Task checking */
export interface TaskCheckResult {
    count: number;
    tasks: Task[];
    total: number;
}
export interface IncompleteTodosResult {
    count: number;
    todos: Todo[];
    total: number;
    source: 'task' | 'todo' | 'both' | 'none';
}
/**
 * Context from Stop hook event
 *
 * NOTE: Field names support both camelCase and snake_case variants
 * for compatibility with different Claude Code versions.
 *
 * IMPORTANT: The abort detection patterns below are assumed. Verify
 * actual stop_reason values from Claude Code before finalizing.
 */
export interface StopContext {
    /** Reason for stop (from Claude Code) - snake_case variant */
    stop_reason?: string;
    /** Reason for stop (from Claude Code) - camelCase variant */
    stopReason?: string;
    /** End turn reason (from API) - snake_case variant */
    end_turn_reason?: string;
    /** End turn reason (from API) - camelCase variant */
    endTurnReason?: string;
    /** Whether user explicitly requested stop - snake_case variant */
    user_requested?: boolean;
    /** Whether user explicitly requested stop - camelCase variant */
    userRequested?: boolean;
}
export interface TodoContinuationHook {
    checkIncomplete: (sessionId?: string) => Promise<IncompleteTodosResult>;
}
/**
 * Detect if stop was due to user abort (not natural completion)
 *
 * WARNING: These patterns are ASSUMED based on common conventions.
 * As of 2025-01, Anthropic's Stop hook input schema does not document
 * the exact stop_reason values. The patterns below are educated guesses:
 *
 * - user_cancel, user_interrupt: Likely user-initiated via UI
 * - ctrl_c: Terminal interrupt (Ctrl+C)
 * - manual_stop: Explicit stop button
 * - abort, cancel, interrupt: Generic abort patterns
 *
 * NOTE: Per official Anthropic docs, the Stop hook "Does not run if
 * the stoppage occurred due to a user interrupt." This means this
 * function may never receive user-abort contexts in practice.
 * It is kept as defensive code in case the behavior changes.
 *
 * If the hook fails to detect user aborts correctly, these patterns
 * should be updated based on observed Claude Code behavior.
 */
export declare function isUserAbort(context?: StopContext): boolean;
/**
 * Detect if stop was triggered by context-limit related reasons.
 * When context is exhausted, Claude Code needs to stop so it can compact.
 * Blocking these stops causes a deadlock: can't compact because can't stop,
 * can't continue because context is full.
 *
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/213
 */
export declare function isContextLimitStop(context?: StopContext): boolean;
/**
 * Get the Task directory for a session
 *
 * NOTE: This path (~/.claude/tasks/{sessionId}/) is inferred from Claude Code's
 * implementation. Anthropic has not officially documented this structure.
 * The Task files are created by Claude Code's TaskCreate tool.
 */
export declare function getTaskDirectory(sessionId: string): string;
/**
 * Validates that a parsed JSON object is a valid Task.
 * Required fields: id (string), subject (string), status (string).
 */
export declare function isValidTask(data: unknown): data is Task;
/**
 * Read all Task files from a session's task directory
 */
export declare function readTaskFiles(sessionId: string): Task[];
/**
 * Check if a Task is incomplete.
 *
 * NOTE: Task system has 3 statuses (pending, in_progress, completed).
 * The TaskUpdate tool also supports 'deleted' status, but deleted task files
 * may be removed rather than marked. If a 'deleted' status is encountered,
 * we treat it as complete (not requiring continuation).
 *
 * Unlike legacy todos, Tasks do not have a 'cancelled' status. The Task system
 * uses 'deleted' for removal, which is handled by file deletion rather than
 * status change.
 */
export declare function isTaskIncomplete(task: Task): boolean;
/**
 * Check for incomplete tasks in the new Task system
 *
 * SYNC NOTICE: This function is intentionally duplicated across:
 * - templates/hooks/persistent-mode.mjs
 * - templates/hooks/stop-continuation.mjs
 * - src/hooks/todo-continuation/index.ts (as checkIncompleteTasks)
 *
 * Templates cannot import shared modules (they're standalone scripts).
 * When modifying this logic, update ALL THREE files to maintain consistency.
 */
export declare function checkIncompleteTasks(sessionId: string): TaskCheckResult;
/**
 * Check for incomplete todos in the legacy system
 */
export declare function checkLegacyTodos(sessionId?: string, directory?: string): IncompleteTodosResult;
/**
 * Check for incomplete todos/tasks across all possible locations.
 * Checks new Task system first, then falls back to legacy todos.
 *
 * Priority Logic:
 * - If Task system has incomplete items, returns Task count only (source: 'task' or 'both')
 * - The returned count reflects Tasks only because Tasks are the authoritative source
 * - Legacy todos are checked to set source='both' for informational purposes
 * - If no incomplete Tasks exist, returns legacy todo count (source: 'todo')
 *
 * NOTE ON COUNTING: Shell templates use a combined Task + Todo count for the
 * "should continue?" boolean check, which may differ from the count returned here.
 * The boolean decision (continue or not) is equivalent; only the displayed count differs.
 */
export declare function checkIncompleteTodos(sessionId?: string, directory?: string, stopContext?: StopContext): Promise<IncompleteTodosResult>;
/**
 * Create a Todo Continuation hook instance
 */
export declare function createTodoContinuationHook(directory: string): TodoContinuationHook;
/**
 * Get formatted status string for todos
 */
export declare function formatTodoStatus(result: IncompleteTodosResult): string;
/**
 * Get the next pending todo
 */
export declare function getNextPendingTodo(result: IncompleteTodosResult): Todo | null;
//# sourceMappingURL=index.d.ts.map
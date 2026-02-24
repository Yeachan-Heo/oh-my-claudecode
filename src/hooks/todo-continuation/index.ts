/**
 * Todo Continuation Enforcer Hook
 *
 * Prevents stopping when incomplete tasks remain in the todo list.
 * Forces the agent to continue until all tasks are marked complete.
 *
 * Ported from oh-my-opencode's todo-continuation-enforcer hook.
 */

/**
 * TERMINOLOGY:
 * - "Task" (capitalized): New Claude Code Task system (~/.claude/tasks/)
 * - "todo" (lowercase): Legacy todo system (~/.claude/todos/)
 * - "item": Generic term for either Task or todo
 */

/**
 * Debug logging for task/todo operations.
 * Set OMC_DEBUG=1 or OMC_DEBUG=todo-continuation for verbose output.
 */
function debugLog(message: string, ...args: unknown[]): void {
  const debug = process.env.OMC_DEBUG;
  if (debug === '1' || debug === 'todo-continuation' || debug === 'true') {
    console.error('[todo-continuation]', message, ...args);
  }
}

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../../utils/paths.js';

/**
 * Validates that a session ID is safe to use in file paths.
 * Session IDs should be alphanumeric with optional hyphens and underscores.
 * This prevents path traversal attacks (e.g., "../../../etc").
 *
 * @param sessionId - The session ID to validate
 * @returns true if the session ID is safe, false otherwise
 */
export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }
  // Allow alphanumeric, hyphens, and underscores only
  // Must be 1-256 characters (reasonable length limit)
  // Must not start with a dot (hidden files) or hyphen
  const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
  return SAFE_SESSION_ID_PATTERN.test(sessionId);
}

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
  count: number;          // Incomplete tasks
  tasks: Task[];          // The incomplete tasks
  total: number;          // Total tasks found
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
  /** Prompt text (when available) */
  prompt?: string;
  /** Tool name from hook payload (snake_case) */
  tool_name?: string;
  /** Tool name from hook payload (camelCase) */
  toolName?: string;
  /** Tool input from hook payload (snake_case) */
  tool_input?: unknown;
  /** Tool input from hook payload (camelCase) */
  toolInput?: unknown;
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
export function isUserAbort(context?: StopContext): boolean {
  if (!context) return false;

  // User explicitly requested stop (supports both camelCase and snake_case)
  if (context.user_requested || context.userRequested) return true;

  // Check stop_reason patterns indicating user abort
  // Exact-match patterns: short generic words that cause false positives with .includes()
  const exactPatterns = ['aborted', 'abort', 'cancel', 'interrupt'];
  // Substring patterns: compound words safe for .includes() matching
  const substringPatterns = ['user_cancel', 'user_interrupt', 'ctrl_c', 'manual_stop'];

  // Support both snake_case and camelCase field names
  const reason = (context.stop_reason ?? context.stopReason ?? '').toLowerCase();
  const endTurnReason = (context.end_turn_reason ?? context.endTurnReason ?? '').toLowerCase();

  const matchesAbort = (value: string): boolean =>
    exactPatterns.some(p => value === p) ||
    substringPatterns.some(p => value.includes(p));

  return matchesAbort(reason) || matchesAbort(endTurnReason);
}

/**
 * Detect explicit /cancel command paths that should bypass stop-hook reinforcement.
 *
 * This is stricter than generic user-abort detection and is intended to prevent
 * re-enforcement races when the user explicitly invokes /cancel or /cancel --force.
 */
export function isExplicitCancelCommand(context?: StopContext): boolean {
  if (!context) return false;

  const prompt = (context.prompt ?? '').trim();
  if (prompt) {
    const slashCancelPattern = /^\/(?:oh-my-claudecode:)?cancel(?:\s+--force)?\s*$/i;
    const keywordCancelPattern = /^(?:cancelomc|stopomc)\s*$/i;
    if (slashCancelPattern.test(prompt) || keywordCancelPattern.test(prompt)) {
      return true;
    }
  }

  const reason = (context.stop_reason ?? context.stopReason ?? '').toLowerCase();
  const endTurnReason = (context.end_turn_reason ?? context.endTurnReason ?? '').toLowerCase();
  const explicitReasonPatterns = [
    /^cancel$/,
    /^cancelled$/,
    /^canceled$/,
    /^user_cancel$/,
    /^cancel_force$/,
    /^force_cancel$/,
  ];
  if (explicitReasonPatterns.some((pattern) => pattern.test(reason) || pattern.test(endTurnReason))) {
    return true;
  }

  const toolName = String(context.tool_name ?? context.toolName ?? '').toLowerCase();
  const toolInput = (context.tool_input ?? context.toolInput) as Record<string, unknown> | undefined;
  if (toolName.includes('skill') && toolInput && typeof toolInput.skill === 'string') {
    const skill = toolInput.skill.toLowerCase();
    if (skill === 'oh-my-claudecode:cancel' || skill.endsWith(':cancel')) {
      return true;
    }
  }

  return false;
}

/**
 * Detect if stop was triggered by context-limit related reasons.
 * When context is exhausted, Claude Code needs to stop so it can compact.
 * Blocking these stops causes a deadlock: can't compact because can't stop,
 * can't continue because context is full.
 *
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/213
 */
export function isContextLimitStop(context?: StopContext): boolean {
  if (!context) return false;

  const reason = (context.stop_reason ?? context.stopReason ?? '').toLowerCase();
  const endTurnReason = (context.end_turn_reason ?? context.endTurnReason ?? '').toLowerCase();

  const contextPatterns = [
    'context_limit', 'context_window', 'context_exceeded', 'context_full',
    'max_context', 'token_limit', 'max_tokens', 'conversation_too_long', 'input_too_long'
  ];

  return contextPatterns.some(p => reason.includes(p) || endTurnReason.includes(p));
}

/**
 * Detect if stop was triggered by rate limiting (HTTP 429 / quota exhausted).
 * When the API is rate-limited, Claude Code stops the session.
 * Blocking these stops causes an infinite retry loop: the persistent-mode hook
 * injects a continuation prompt, Claude immediately hits the rate limit again,
 * stops again, and the cycle repeats indefinitely.
 *
 * Fix for: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/777
 */
export function isRateLimitStop(context?: StopContext): boolean {
  if (!context) return false;

  const reason = (context.stop_reason ?? context.stopReason ?? '').toLowerCase();
  const endTurnReason = (context.end_turn_reason ?? context.endTurnReason ?? '').toLowerCase();

  const rateLimitPatterns = [
    'rate_limit', 'rate_limited', 'ratelimit',
    'too_many_requests', '429',
    'quota_exceeded', 'quota_limit', 'quota_exhausted',
    'request_limit', 'api_limit',
    // Anthropic API returns 'overloaded_error' (529) for server overload;
    // 'capacity' covers provider-level capacity-exceeded responses
    'overloaded', 'capacity',
  ];

  return rateLimitPatterns.some(p => reason.includes(p) || endTurnReason.includes(p));
}

/**
 * Get possible todo file locations
 */
function getTodoFilePaths(sessionId?: string, directory?: string): string[] {
  const claudeDir = getClaudeConfigDir();
  const paths: string[] = [];

  // Session-specific todos
  if (sessionId) {
    paths.push(join(claudeDir, 'sessions', sessionId, 'todos.json'));
    paths.push(join(claudeDir, 'todos', `${sessionId}.json`));
  }

  // Project-specific todos
  if (directory) {
    paths.push(join(directory, '.omc', 'todos.json'));
    paths.push(join(directory, '.claude', 'todos.json'));
  }

  // NOTE: Global todos directory scan removed to prevent false positives.
  // Only session-specific and project-local todos are now checked.

  return paths;
}

/**
 * Parse todo file content
 */
function parseTodoFile(filePath: string): Todo[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    // Handle array format
    if (Array.isArray(data)) {
      return data.filter(item =>
        item &&
        typeof item.content === 'string' &&
        typeof item.status === 'string'
      );
    }

    // Handle object format with todos array
    if (data.todos && Array.isArray(data.todos)) {
      return data.todos.filter((item: unknown) => {
        const todo = item as Record<string, unknown>;
        return (
          todo &&
          typeof todo.content === 'string' &&
          typeof todo.status === 'string'
        );
      }) as Todo[];
    }

    return [];
  } catch (err) {
    debugLog('Failed to parse todo file:', filePath, err);
    return [];
  }
}

/**
 * Check if a todo is incomplete
 */
function isIncomplete(todo: Todo): boolean {
  return todo.status !== 'completed' && todo.status !== 'cancelled';
}

/**
 * Get the Task directory for a session
 *
 * NOTE: This path (~/.claude/tasks/{sessionId}/) is inferred from Claude Code's
 * implementation. Anthropic has not officially documented this structure.
 * The Task files are created by Claude Code's TaskCreate tool.
 */
export function getTaskDirectory(sessionId: string): string {
  // Security: validate sessionId before constructing path
  if (!isValidSessionId(sessionId)) {
    return ''; // Return empty string for invalid sessions
  }
  return join(getClaudeConfigDir(), 'tasks', sessionId);
}

/**
 * Validates that a parsed JSON object is a valid Task.
 * Required fields: id (string), subject (string), status (string).
 */
export function isValidTask(data: unknown): data is Task {
  if (data === null || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === 'string' && obj.id.length > 0 &&
    typeof obj.subject === 'string' && obj.subject.length > 0 &&
    typeof obj.status === 'string' &&
    // Accept 'deleted' as valid - matches Task interface status union type
    ['pending', 'in_progress', 'completed', 'deleted'].includes(obj.status)
  );
}

/**
 * Read all Task files from a session's task directory
 */
export function readTaskFiles(sessionId: string): Task[] {
  if (!isValidSessionId(sessionId)) {
    return [];
  }
  const taskDir = getTaskDirectory(sessionId);
  if (!taskDir || !existsSync(taskDir)) return [];

  const tasks: Task[] = [];
  try {
    for (const file of readdirSync(taskDir)) {
      // Skip non-JSON files and .lock file (used by Claude Code for atomic writes)
      // The .lock file prevents concurrent modifications to task files
      if (!file.endsWith('.json') || file === '.lock') continue;
      try {
        const content = readFileSync(join(taskDir, file), 'utf-8');
        const parsed = JSON.parse(content);
        if (isValidTask(parsed)) tasks.push(parsed);
      } catch (err) {
        debugLog('Failed to parse task file:', file, err);
      }
    }
  } catch (err) {
    debugLog('Failed to read task directory:', sessionId, err);
  }
  return tasks;
}

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
export function isTaskIncomplete(task: Task): boolean {
  // Treat 'completed' and any unknown/deleted status as complete
  return task.status === 'pending' || task.status === 'in_progress';
}

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
export function checkIncompleteTasks(sessionId: string): TaskCheckResult {
  if (!isValidSessionId(sessionId)) {
    return { count: 0, tasks: [], total: 0 };
  }
  const tasks = readTaskFiles(sessionId);
  const incomplete = tasks.filter(isTaskIncomplete);
  return {
    count: incomplete.length,
    tasks: incomplete,
    total: tasks.length
  };
}

/**
 * Check for incomplete todos in the legacy system
 */
export function checkLegacyTodos(sessionId?: string, directory?: string): IncompleteTodosResult {
  const paths = getTodoFilePaths(sessionId, directory);
  const seenContents = new Set<string>();
  const allTodos: Todo[] = [];
  const incompleteTodos: Todo[] = [];

  for (const p of paths) {
    if (!existsSync(p)) continue;

    const todos = parseTodoFile(p);
    for (const todo of todos) {
      const key = `${todo.content}:${todo.status}`;
      if (seenContents.has(key)) continue;
      seenContents.add(key);
      allTodos.push(todo);
      if (isIncomplete(todo)) {
        incompleteTodos.push(todo);
      }
    }
  }

  return {
    count: incompleteTodos.length,
    todos: incompleteTodos,
    total: allTodos.length,
    source: incompleteTodos.length > 0 ? 'todo' : 'none'
  };
}

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
export async function checkIncompleteTodos(
  sessionId?: string,
  directory?: string,
  stopContext?: StopContext
): Promise<IncompleteTodosResult> {
  // If user aborted, don't force continuation
  if (isUserAbort(stopContext)) {
    return { count: 0, todos: [], total: 0, source: 'none' };
  }

  let taskResult: TaskCheckResult | null = null;

  // Priority 1: Check new Task system (if sessionId provided)
  if (sessionId) {
    taskResult = checkIncompleteTasks(sessionId);
  }

  // Priority 2: Check legacy todo system
  const todoResult = checkLegacyTodos(sessionId, directory);

  // Combine results (prefer Tasks if available)
  if (taskResult && taskResult.count > 0) {
    return {
      count: taskResult.count,
      // taskResult.tasks only contains incomplete tasks (pending/in_progress)
      // so status is safe to cast to Todo['status'] (no 'deleted' will appear)
      todos: taskResult.tasks.map(t => ({
        content: t.subject,
        status: t.status as Todo['status'],
        id: t.id
      })),
      total: taskResult.total,
      source: todoResult.count > 0 ? 'both' : 'task'
    };
  }

  return todoResult;
}

/**
 * Create a Todo Continuation hook instance
 */
export function createTodoContinuationHook(directory: string): TodoContinuationHook {
  return {
    checkIncomplete: (sessionId?: string) =>
      checkIncompleteTodos(sessionId, directory)
  };
}

/**
 * Get formatted status string for todos
 */
export function formatTodoStatus(result: IncompleteTodosResult): string {
  if (result.count === 0) {
    return `All tasks complete (${result.total} total)`;
  }

  return `${result.total - result.count}/${result.total} completed, ${result.count} remaining`;
}

/**
 * Get the next pending todo
 */
export function getNextPendingTodo(result: IncompleteTodosResult): Todo | null {
  // First try to find one that's in_progress
  const inProgress = result.todos.find(t => t.status === 'in_progress');
  if (inProgress) {
    return inProgress;
  }

  // Otherwise return first pending
  return result.todos.find(t => t.status === 'pending') ?? null;
}

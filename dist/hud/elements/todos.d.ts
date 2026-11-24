/**
 * OMC HUD - Todos Element
 *
 * Renders todo progress display.
 */
import type { TodoItem } from "../types.js";
/**
 * Render todo progress.
 * Returns null if no todos.
 *
 * Format: todos:2/5
 */
export declare function renderTodos(todos: TodoItem[]): string | null;
/**
 * Render current in-progress todo (for full mode).
 *
 * Format: todos:2/5 (working: Implementing feature)
 */
export declare function renderTodosWithCurrent(todos: TodoItem[]): string | null;
//# sourceMappingURL=todos.d.ts.map
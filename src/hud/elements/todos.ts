/**
 * OMC HUD - Todos Element
 *
 * Renders todo progress display with visual progress bars.
 */

import type { TodoItem, ProgressBarStyle } from "../types.js";
import { RESET, GREEN, YELLOW, CYAN, MAGENTA, DIM, ICONS, ASCII_ICONS } from "../colors.js";
import { renderTodoProgressBar, renderStatusIndicator } from "../progress-bar.js";
import { truncateToWidth } from "../../utils/string-width.js";

/**
 * Get color for todo progress.
 */
function getTodoProgressColor(completed: number, total: number): string {
  if (total === 0) return DIM;
  const percent = (completed / total) * 100;

  if (percent >= 100) return GREEN;     // Complete
  if (percent >= 80) return CYAN;       // Almost done
  if (percent >= 50) return YELLOW;     // Halfway
  return MAGENTA;                        // Started
}

/**
 * Render todo progress.
 * Returns null if no todos.
 *
 * Format: todos:2/5
 */
export function renderTodos(todos: TodoItem[]): string | null {
  if (todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  // Color based on progress
  const color = getTodoProgressColor(completed, total);

  return `todos:${color}${completed}/${total}${RESET}`;
}

/**
 * Render todo progress with visual bar.
 *
 * Format: todos:[████░░░░]2/5
 *
 * @param todos - List of todo items
 * @param style - Progress bar visual style
 */
export function renderTodosWithBar(
  todos: TodoItem[],
  style: ProgressBarStyle = 'solid'
): string | null {
  if (todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  // Use the progress bar component
  const bar = renderTodoProgressBar(completed, total, 10, style);
  const color = getTodoProgressColor(completed, total);

  return `todos:${bar} ${color}${completed}/${total}${RESET}`;
}

/**
 * Render current in-progress todo (for full mode).
 *
 * Format: todos:2/5 (working: Implementing feature)
 */
export function renderTodosWithCurrent(todos: TodoItem[]): string | null {
  if (todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const inProgress = todos.find((t) => t.status === "in_progress");

  // Color based on progress
  const color = getTodoProgressColor(completed, total);

  let result = `todos:${color}${completed}/${total}${RESET}`;

  if (inProgress) {
    const activeText = inProgress.activeForm || inProgress.content || "...";
    // Use CJK-aware truncation (30 visual columns)
    const truncated = truncateToWidth(activeText, 30);
    result += ` ${DIM}(working: ${truncated})${RESET}`;
  }

  return result;
}

/**
 * Render todos with progress bar and current task.
 *
 * Format: todos:[████░░░░]2/5 (working: Implementing feature)
 *
 * @param todos - List of todo items
 * @param style - Progress bar visual style
 */
export function renderTodosWithBarAndCurrent(
  todos: TodoItem[],
  style: ProgressBarStyle = 'solid'
): string | null {
  if (todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const inProgress = todos.find((t) => t.status === "in_progress");

  // Use the progress bar component
  const bar = renderTodoProgressBar(completed, total, 10, style);
  const color = getTodoProgressColor(completed, total);

  let result = `todos:${bar} ${color}${completed}/${total}${RESET}`;

  if (inProgress) {
    const activeText = inProgress.activeForm || inProgress.content || "...";
    // Use CJK-aware truncation (30 visual columns)
    const truncated = truncateToWidth(activeText, 30);
    result += ` ${DIM}(working: ${truncated})${RESET}`;
  }

  return result;
}

/**
 * Render compact todo display with completion indicator.
 *
 * Format: todos:2/5 ✓ or todos:2/5 ○
 */
export function renderTodosCompact(todos: TodoItem[], useAscii: boolean = false): string | null {
  if (todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const isComplete = completed === total;

  const color = getTodoProgressColor(completed, total);
  const icons = useAscii ? ASCII_ICONS : ICONS;
  const indicator = isComplete ? icons.check : icons.pending;

  return `todos:${color}${completed}/${total}${RESET} ${indicator}${RESET}`;
}

/**
 * Render mini todo indicator (3 chars max).
 *
 * Format: todos:▓▓░
 */
export function renderTodosMini(todos: TodoItem[]): string | null {
  if (todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const percent = (completed / total) * 100;

  let indicator: string;
  if (percent >= 100) {
    indicator = `${GREEN}▓▓▓${RESET}`;
  } else if (percent >= 66) {
    indicator = `${CYAN}▓▓░${RESET}`;
  } else if (percent >= 33) {
    indicator = `${YELLOW}▓░░${RESET}`;
  } else {
    indicator = `${MAGENTA}░░░${RESET}`;
  }

  return `todos:${indicator}`;
}

/**
 * Multi-line render result for todos.
 */
export interface TodosMultiLineResult {
  summary: string;
  detailLines: string[];
}

/**
 * Render todos as multi-line display.
 *
 * Format:
 * todos:[████████░░]4/5
 *   ○ completed-task-1
 *   ○ completed-task-2
 *   ● in-progress-task (current)
 *   ○ pending-task
 *
 * @param todos - List of todo items
 * @param maxLines - Maximum detail lines to show
 * @param style - Progress bar visual style
 * @param useAscii - Use ASCII icons
 */
export function renderTodosMultiLine(
  todos: TodoItem[],
  maxLines: number = 5,
  style: ProgressBarStyle = 'solid',
  useAscii: boolean = false
): TodosMultiLineResult | null {
  if (todos.length === 0) {
    return null;
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  // Build summary line
  const bar = renderTodoProgressBar(completed, total, 10, style);
  const color = getTodoProgressColor(completed, total);
  const summary = `todos:${bar} ${color}${completed}/${total}${RESET}`;

  // Build detail lines
  const icons = useAscii ? ASCII_ICONS : ICONS;
  const detailLines: string[] = [];

  // Show non-completed todos first (in_progress, then pending)
  const inProgress = todos.filter(t => t.status === "in_progress");
  const pending = todos.filter(t => t.status === "pending");
  const displayTodos = [...inProgress, ...pending].slice(0, maxLines);

  displayTodos.forEach((todo, index) => {
    const isLast = index === displayTodos.length - 1;
    const prefix = isLast ? icons.endSeparator : icons.branchSeparator;
    const icon = todo.status === "in_progress" ? icons.running : icons.pending;
    const todoColor = todo.status === "in_progress" ? YELLOW : DIM;

    const text = todo.activeForm || todo.content || "...";
    const truncated = truncateToWidth(text, 50);

    detailLines.push(
      `${DIM}${prefix}${RESET} ${icon}${RESET} ${todoColor}${truncated}${RESET}`
    );
  });

  // Add overflow indicator
  const remainingCount = todos.length - completed - displayTodos.length;
  if (remainingCount > 0) {
    detailLines.push(`${DIM}${icons.endSeparator} +${remainingCount} more pending...${RESET}`);
  }

  return { summary, detailLines };
}
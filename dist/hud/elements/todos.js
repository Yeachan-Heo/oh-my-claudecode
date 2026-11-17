/**
 * OMC HUD - Todos Element
 *
 * Renders todo progress display.
 */
import { RESET } from "../colors.js";
import { truncateToWidth } from "../../utils/string-width.js";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
/**
 * Render todo progress.
 * Returns null if no todos.
 *
 * Format: todos:2/5
 */
export function renderTodos(todos) {
    if (todos.length === 0) {
        return null;
    }
    const completed = todos.filter((t) => t.status === "completed").length;
    const total = todos.length;
    // Color based on progress
    let color;
    const percent = (completed / total) * 100;
    if (percent >= 80) {
        color = GREEN;
    }
    else if (percent >= 50) {
        color = YELLOW;
    }
    else {
        color = CYAN;
    }
    return `todos:${color}${completed}/${total}${RESET}`;
}
/**
 * Render current in-progress todo (for full mode).
 *
 * Format: todos:2/5 (working: Implementing feature)
 */
export function renderTodosWithCurrent(todos) {
    if (todos.length === 0) {
        return null;
    }
    const completed = todos.filter((t) => t.status === "completed").length;
    const total = todos.length;
    const inProgress = todos.find((t) => t.status === "in_progress");
    // Color based on progress
    const percent = (completed / total) * 100;
    let color;
    if (percent >= 80) {
        color = GREEN;
    }
    else if (percent >= 50) {
        color = YELLOW;
    }
    else {
        color = CYAN;
    }
    let result = `todos:${color}${completed}/${total}${RESET}`;
    if (inProgress) {
        const activeText = inProgress.activeForm || inProgress.content || "...";
        // Use CJK-aware truncation (30 visual columns)
        const truncated = truncateToWidth(activeText, 30);
        result += ` ${DIM}(working: ${truncated})${RESET}`;
    }
    return result;
}
//# sourceMappingURL=todos.js.map
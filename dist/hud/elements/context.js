/**
 * OMC HUD - Context Element
 *
 * Renders context window usage display.
 */
import { RESET } from '../colors.js';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
/**
 * Render context window percentage.
 *
 * Format: ctx:67%
 */
export function renderContext(percent, thresholds) {
    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    let color;
    let suffix = '';
    if (safePercent >= thresholds.contextCritical) {
        color = RED;
        suffix = ' CRITICAL';
    }
    else if (safePercent >= thresholds.contextCompactSuggestion) {
        color = YELLOW;
        suffix = ' COMPRESS?';
    }
    else if (safePercent >= thresholds.contextWarning) {
        color = YELLOW;
    }
    else {
        color = GREEN;
    }
    return `ctx:${color}${safePercent}%${suffix}${RESET}`;
}
/**
 * Render context window with visual bar.
 *
 * Format: ctx:[████░░░░░░]67%
 */
export function renderContextWithBar(percent, thresholds, barWidth = 10) {
    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    const filled = Math.round((safePercent / 100) * barWidth);
    const empty = barWidth - filled;
    let color;
    if (safePercent >= thresholds.contextCritical) {
        color = RED;
    }
    else if (safePercent >= thresholds.contextWarning) {
        color = YELLOW;
    }
    else {
        color = GREEN;
    }
    const bar = `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
    return `ctx:[${bar}]${color}${safePercent}%${RESET}`;
}
//# sourceMappingURL=context.js.map
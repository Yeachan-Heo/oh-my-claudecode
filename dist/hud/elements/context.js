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
const CONTEXT_DISPLAY_HYSTERESIS = 2;
const CONTEXT_DISPLAY_STATE_TTL_MS = 5_000;
let lastDisplayedPercent = null;
let lastDisplayedSeverity = null;
let lastDisplayScope = null;
let lastDisplayUpdatedAt = 0;
function clampContextPercent(percent) {
    return Math.min(100, Math.max(0, Math.round(percent)));
}
function getContextSeverity(safePercent, thresholds) {
    if (safePercent >= thresholds.contextCritical) {
        return 'critical';
    }
    if (safePercent >= thresholds.contextCompactSuggestion) {
        return 'compact';
    }
    if (safePercent >= thresholds.contextWarning) {
        return 'warning';
    }
    return 'normal';
}
function getContextDisplayStyle(safePercent, thresholds) {
    const severity = getContextSeverity(safePercent, thresholds);
    switch (severity) {
        case 'critical':
            return { color: RED, suffix: ' CRITICAL' };
        case 'compact':
            return { color: YELLOW, suffix: ' COMPRESS?' };
        case 'warning':
            return { color: YELLOW, suffix: '' };
        default:
            return { color: GREEN, suffix: '' };
    }
}
/**
 * Reset cached context display state.
 * Useful for test isolation and fresh render sessions.
 */
export function resetContextDisplayState() {
    lastDisplayedPercent = null;
    lastDisplayedSeverity = null;
    lastDisplayScope = null;
    lastDisplayUpdatedAt = 0;
}
/**
 * Apply display-layer hysteresis so small refresh-to-refresh ctx fluctuations
 * do not visibly jitter in the HUD.
 */
export function getStableContextDisplayPercent(percent, thresholds, displayScope) {
    const safePercent = clampContextPercent(percent);
    const severity = getContextSeverity(safePercent, thresholds);
    const nextScope = displayScope ?? null;
    const now = Date.now();
    if (nextScope !== lastDisplayScope) {
        lastDisplayedPercent = null;
        lastDisplayedSeverity = null;
        lastDisplayScope = nextScope;
    }
    if (lastDisplayedPercent === null
        || lastDisplayedSeverity === null
        || now - lastDisplayUpdatedAt > CONTEXT_DISPLAY_STATE_TTL_MS) {
        lastDisplayedPercent = safePercent;
        lastDisplayedSeverity = severity;
        lastDisplayUpdatedAt = now;
        return safePercent;
    }
    if (severity !== lastDisplayedSeverity) {
        lastDisplayedPercent = safePercent;
        lastDisplayedSeverity = severity;
        lastDisplayUpdatedAt = now;
        return safePercent;
    }
    if (Math.abs(safePercent - lastDisplayedPercent) <= CONTEXT_DISPLAY_HYSTERESIS) {
        lastDisplayUpdatedAt = now;
        return lastDisplayedPercent;
    }
    lastDisplayedPercent = safePercent;
    lastDisplayedSeverity = severity;
    lastDisplayUpdatedAt = now;
    return safePercent;
}
/**
 * Render context window percentage.
 *
 * Format: ctx:67%
 */
export function renderContext(percent, thresholds, displayScope) {
    const safePercent = getStableContextDisplayPercent(percent, thresholds, displayScope);
    const { color, suffix } = getContextDisplayStyle(safePercent, thresholds);
    return `ctx:${color}${safePercent}%${suffix}${RESET}`;
}
/**
 * Render context window with visual bar.
 *
 * Format: ctx:[████░░░░░░]67%
 */
export function renderContextWithBar(percent, thresholds, barWidth = 10, displayScope) {
    const safePercent = getStableContextDisplayPercent(percent, thresholds, displayScope);
    const filled = Math.round((safePercent / 100) * barWidth);
    const empty = barWidth - filled;
    const { color, suffix } = getContextDisplayStyle(safePercent, thresholds);
    const bar = `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
    return `ctx:[${bar}]${color}${safePercent}%${suffix}${RESET}`;
}
//# sourceMappingURL=context.js.map
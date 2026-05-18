/**
 * Pane Fresh Capture
 *
 * Tracks per-pane scrollback position (history_size) in a state file.
 * Returns only newly appended pane lines since the last scan,
 * preventing stale pane history from re-alerting after blockers are resolved.
 *
 * Security: pane IDs are validated before use in shell commands.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmuxExec, PANE_ID_VALIDATOR } from '../../cli/tmux-utils.js';
const STATE_FILE = 'pane-tail-positions.json';
/** Default maximum new lines to surface per capture. */
const DEFAULT_MAX_LINES = 15;
/** Valid tmux pane id format: %<integer> from real tmux, or %<UUID> from cmux. */
function isValidPaneId(paneId) {
    return PANE_ID_VALIDATOR.test(paneId);
}
function readPaneTailState(stateDir) {
    const path = join(stateDir, STATE_FILE);
    try {
        if (existsSync(path)) {
            const parsed = JSON.parse(readFileSync(path, 'utf-8'));
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed;
            }
        }
    }
    catch {
        // corrupt or missing — start fresh
    }
    return {};
}
function writePaneTailState(stateDir, state) {
    try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, STATE_FILE), JSON.stringify(state), { mode: 0o600 });
    }
    catch {
        // best-effort — never block alert path on write failure
    }
}
/**
 * Get the current scrollback history size for a tmux pane.
 * Returns null when the pane is dead, does not exist, or tmux is unavailable.
 */
export function getPaneHistorySize(paneId) {
    try {
        const raw = tmuxExec(['display-message', '-t', paneId, '-p', '#{pane_dead} #{history_size}'], { stripTmux: true, timeout: 3000 }).trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            const [paneDeadRaw, historySizeRaw] = parts;
            if (paneDeadRaw === '1') {
                return null;
            }
            const n = parseInt(historySizeRaw ?? '', 10);
            return Number.isFinite(n) && n >= 0 ? n : null;
        }
        // Backward-compatible fallback if tmux returns only history_size.
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }
    catch {
        return null;
    }
}
/**
 * Capture the last `lines` lines of pane content.
 */
function capturePaneLines(paneId, lines) {
    try {
        const safeLines = Math.max(1, Math.min(500, Math.floor(lines)));
        return tmuxExec(['capture-pane', '-t', paneId, '-p', '-S', `-${safeLines}`], { stripTmux: true, timeout: 5000 });
    }
    catch {
        return '';
    }
}
/**
 * Return only the pane lines appended since the last call for this pane ID.
 *
 * Returns an empty string when:
 * - The pane no longer exists (terminated / superseded session)
 * - No new lines have been written since the last scan (stale)
 * - The pane ID format is invalid
 *
 * On the very first scan for a pane, returns the recent tail (up to
 * `maxLines`) so the first stop-event notification always carries context.
 * Subsequent scans return only the delta, preventing stale re-alerts.
 *
 * @param paneId   tmux pane ID (e.g. "%3")
 * @param stateDir directory for persisting per-pane positions
 * @param maxLines maximum new lines to surface (default 15)
 */
export function getNewPaneTail(paneId, stateDir, maxLines = DEFAULT_MAX_LINES) {
    if (!isValidPaneId(paneId)) {
        return '';
    }
    const currentSize = getPaneHistorySize(paneId);
    if (currentSize === null) {
        // Pane gone or tmux unavailable — silently skip rather than replay stale content.
        return '';
    }
    const state = readPaneTailState(stateDir);
    const lastSize = state[paneId] ?? -1;
    // Update stored position before capturing so that a capture error does not
    // cause the same lines to be re-emitted on the next call.
    state[paneId] = currentSize;
    writePaneTailState(stateDir, state);
    if (lastSize < 0) {
        // First scan for this pane — emit a bounded recent tail for initial context.
        return capturePaneLines(paneId, maxLines);
    }
    const newLines = currentSize - lastSize;
    if (newLines <= 0) {
        // No new output since last scan — stale, suppress.
        return '';
    }
    // Emit only the delta, capped at maxLines to bound payload size.
    return capturePaneLines(paneId, Math.min(newLines, maxLines));
}
//# sourceMappingURL=pane-fresh-capture.js.map
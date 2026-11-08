/**
 * Pane Fresh Capture
 *
 * Tracks per-pane scrollback position (history_size) in a state file.
 * Returns only newly appended pane lines since the last scan,
 * preventing stale pane history from re-alerting after blockers are resolved.
 *
 * Security: pane IDs are validated before use in shell commands.
 */
/** Reset saved pane cursors so a new usage profile can recapture live prompts. */
export declare function resetPaneTailPositions(stateDir: string): void;
/**
 * Get the current scrollback history size for a tmux pane.
 * Returns null when the pane is dead, does not exist, or tmux is unavailable.
 */
export declare function getPaneHistorySize(paneId: string): number | null;
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
export declare function getNewPaneTail(paneId: string, stateDir: string, maxLines?: number): string;
//# sourceMappingURL=pane-fresh-capture.d.ts.map
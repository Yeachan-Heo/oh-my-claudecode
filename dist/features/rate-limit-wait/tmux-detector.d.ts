/**
 * tmux Detector
 *
 * Detects Claude Code sessions running in tmux panes and identifies
 * those that are blocked due to rate limiting.
 *
 * Security considerations:
 * - Pane IDs are validated before use in shell commands
 * - Text inputs are sanitized to prevent command injection
 */
import type { TmuxPane, PaneAnalysisResult, BlockedPane } from './types.js';
/**
 * Check if tmux is installed and available.
 * On Windows, a tmux-compatible binary such as psmux may provide tmux.
 */
export declare function isTmuxAvailable(): boolean;
/**
 * Check if currently running inside a tmux session
 */
export declare function isInsideTmux(): boolean;
/**
 * List all tmux panes across all sessions.
 */
export declare function listTmuxPanes(): TmuxPane[];
/**
 * Check whether a tmux pane is alive (not in the dead/exited state).
 *
 * tmux sets #{pane_dead} to "1" once the child process in the pane exits.
 * Capturing content from a dead pane returns stale scrollback and can
 * trigger spurious keyword alerts — callers should skip capture when this
 * returns false.
 *
 * Returns false for dead panes, invalid pane IDs, and when tmux is unavailable.
 * Intentionally synchronous so it can be used in fire-and-forget hook paths.
 */
export declare function isPaneAlive(paneId: string): boolean;
export declare function capturePaneContent(paneId: string, lines?: number): string;
/**
 * Analyze pane content to determine if it shows a rate-limited Claude Code session
 */
export declare function analyzePaneContent(content: string): PaneAnalysisResult;
/**
 * Scan all tmux panes for blocked Claude Code sessions.
 *
 * @param lines    - Number of lines to capture from each pane
 * @param stateDir - When provided, use cursor-tracked capture (getNewPaneTail) so
 *                   repeated daemon polls only surface lines written since the last
 *                   scan. Panes with no new output are skipped, preventing stale
 *                   rate-limit messages from re-alerting after blockers are resolved.
 *                   When omitted, falls back to a plain capturePaneContent call.
 */
export declare function scanForBlockedPanes(lines?: number, stateDir?: string): BlockedPane[];
/**
 * Revalidate persisted pane candidates before sending resume keys.
 * Returns null when tmux could not provide a complete scan, so callers can retry
 * without discarding recovery state. A successful scan only returns panes whose
 * current output still shows a rate-limit screen and a live first resume option.
 */
export declare function revalidateBlockedPanes(trackedPanes: BlockedPane[], lines?: number): BlockedPane[] | null;
/**
 * Send resume sequence to a tmux pane
 *
 * This sends "1" followed by Enter to select the first option (usually "Continue"),
 * then waits briefly and sends "continue" if needed.
 *
 * @param paneId - The tmux pane ID
 * @returns Whether the command was sent successfully
 */
export declare function sendResumeSequence(paneId: string): boolean;
/**
 * Send custom text to a tmux pane
 */
export declare function sendToPane(paneId: string, text: string, pressEnter?: boolean): boolean;
/**
 * Get a summary of blocked panes for display
 */
export declare function formatBlockedPanesSummary(blockedPanes: BlockedPane[]): string;
//# sourceMappingURL=tmux-detector.d.ts.map
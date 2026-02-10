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
 * Check if tmux is installed and available
 */
export declare function isTmuxAvailable(): boolean;
/**
 * Check if currently running inside a tmux session
 */
export declare function isInsideTmux(): boolean;
/**
 * List all tmux panes across all sessions
 */
export declare function listTmuxPanes(): TmuxPane[];
/**
 * Capture the content of a specific tmux pane
 *
 * @param paneId - The tmux pane ID (e.g., "%0")
 * @param lines - Number of lines to capture (default: 15)
 */
export declare function capturePaneContent(paneId: string, lines?: number): string;
/**
 * Analyze pane content to determine if it shows a rate-limited Claude Code session
 */
export declare function analyzePaneContent(content: string): PaneAnalysisResult;
/**
 * Scan all tmux panes for blocked Claude Code sessions
 *
 * @param lines - Number of lines to capture from each pane
 */
export declare function scanForBlockedPanes(lines?: number): BlockedPane[];
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
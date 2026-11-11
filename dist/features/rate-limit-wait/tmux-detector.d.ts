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
 * Whether the herdr panes should be scanned. Conservative gate: only when the
 * multiplexer setting elects herdr (env OMC_TEAM_MULTIPLEXER or
 * team.ops.multiplexer). Ambient scanning is not enabled for herdr because a
 * scan implies the headless Herdr server (spawned on demand); default tmux
 * behavior is unchanged.
 */
export declare function isHerdrDetectorEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Scan live herdr agent panes for blocked Claude Code sessions. Only panes
 * hosting a recognized agent are considered (the live-agent inventory is the
 * liveness proof; plain shell tabs are not agents). Returns [] when the
 * inventory cannot be read.
 */
export declare function scanForBlockedHerdrPanes(lines?: number): Promise<BlockedPane[]>;
/**
 * Revalidate persisted herdr pane candidates before sending resume keys.
 * Mirrors revalidateBlockedPanes: null means "inconclusive" (the inventory
 * could not be read — callers retain state and retry), otherwise only panes
 * whose live agent still shows a rate-limit screen with a live resume menu
 * are returned.
 */
export declare function revalidateBlockedHerdrPanes(trackedPanes: BlockedPane[], lines?: number): Promise<BlockedPane[] | null>;
/**
 * Send the resume confirmation to a herdr agent pane.
 *
 * tmux sends "1" + Enter to pick the first menu option. The herdr agent
 * surface types only semantic keys, so this confirms with Enter alone: the
 * live-menu revalidation above requires option 1 ("continue"/"wait") to be
 * the first resume option, and Claude's limit screen preselects it, making
 * Enter the equivalent of "1" + Enter.
 */
export declare function sendHerdrResumeSequence(paneId: string): Promise<boolean>;
/**
 * Get a summary of blocked panes for display
 */
export declare function formatBlockedPanesSummary(blockedPanes: BlockedPane[]): string;
//# sourceMappingURL=tmux-detector.d.ts.map
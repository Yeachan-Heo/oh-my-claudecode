/**
 * tmux utility functions for omc native shell launch
 * Adapted from oh-my-codex patterns for omc
 */
export type ClaudeLaunchPolicy = 'inside-tmux' | 'outside-tmux' | 'direct';
export interface TmuxPaneSnapshot {
    paneId: string;
    currentCommand: string;
    startCommand: string;
}
/**
 * Check if tmux is available on the system
 */
export declare function isTmuxAvailable(): boolean;
/**
 * Check if claude CLI is available on the system
 */
export declare function isClaudeAvailable(): boolean;
/**
 * Resolve launch policy based on environment
 * - inside-tmux: Already in tmux session, split pane for HUD
 * - outside-tmux: Not in tmux, create new session
 * - direct: tmux not available, run directly
 */
export declare function resolveLaunchPolicy(env?: NodeJS.ProcessEnv): ClaudeLaunchPolicy;
/**
 * Build tmux session name from directory, git branch, and UTC timestamp
 * Format: omc-{dir}-{branch}-{utctimestamp}
 * e.g.  omc-myproject-dev-20260221143052
 *
 * When worktree option is enabled, uses last 2 path segments instead of
 * just the basename, so worktree paths like ~/omc-worktrees/feat/issue-42
 * produce "omc-feat-issue-42-..." instead of generic "omc-issue-42-...".
 */
export declare function buildTmuxSessionName(cwd: string, options?: {
    worktree?: boolean;
}): string;
/**
 * Sanitize string for use in tmux session/window names
 * Lowercase, alphanumeric + hyphens only
 */
export declare function sanitizeTmuxToken(value: string): string;
/**
 * Build shell command string for tmux with proper quoting
 */
export declare function buildTmuxShellCommand(command: string, args: string[]): string;
/**
 * Quote shell argument for safe shell execution
 * Uses single quotes with proper escaping
 */
export declare function quoteShellArg(value: string): string;
/**
 * Parse tmux pane list output into structured data
 */
export declare function parseTmuxPaneSnapshot(output: string): TmuxPaneSnapshot[];
/**
 * Check if pane is running a HUD watch command
 */
export declare function isHudWatchPane(pane: TmuxPaneSnapshot): boolean;
/**
 * Find HUD watch pane IDs in current window
 */
export declare function findHudWatchPaneIds(panes: TmuxPaneSnapshot[], currentPaneId?: string): string[];
/**
 * List HUD watch panes in current tmux window
 */
export declare function listHudWatchPaneIdsInCurrentWindow(currentPaneId?: string): string[];
/**
 * Create HUD watch pane in current window
 * Returns pane ID or null on failure
 */
export declare function createHudWatchPane(cwd: string, hudCmd: string): string | null;
/**
 * Kill tmux pane by ID
 */
export declare function killTmuxPane(paneId: string): void;
//# sourceMappingURL=tmux-utils.d.ts.map
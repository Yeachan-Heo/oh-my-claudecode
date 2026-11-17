/**
 * tmux Session Detection for Notifications
 *
 * Detects the current tmux session name for inclusion in notification payloads.
 */
/**
 * Get the current tmux session name.
 * Returns null if not running inside tmux.
 */
export declare function getCurrentTmuxSession(): string | null;
/**
 * List active omc-team tmux sessions for a given team.
 */
export declare function getTeamTmuxSessions(teamName: string): string[];
/**
 * Format tmux session info for human-readable display.
 * Returns null if not in tmux.
 */
export declare function formatTmuxInfo(): string | null;
/**
 * Get the current tmux pane ID (e.g., "%0").
 * Returns null if not running inside tmux.
 *
 * Tries $TMUX_PANE env var first, falls back to tmux display-message.
 */
export declare function getCurrentTmuxPaneId(): string | null;
//# sourceMappingURL=tmux.d.ts.map
/**
 * tmux Session Detection for Notifications
 *
 * Detects the current tmux session name for inclusion in notification payloads.
 */
/**
 * The Herdr pane hosting this process, when OMC itself runs inside Herdr.
 * The HERDR_PANE_ID grammar (wN:pM) is validated before any use; an absent
 * or malformed value leaves the default tmux detection untouched.
 */
export declare function getCurrentHerdrPaneId(env?: NodeJS.ProcessEnv): string | null;
/**
 * Get the current tmux session name.
 * Returns null if not running inside tmux.
 *
 * Inside a Herdr pane the team-session marker (herdr:<workspace_id>) is
 * returned instead, so payloads and registries use the same marker grammar
 * the team layer persists.
 */
export declare function getCurrentTmuxSession(): string | null;
/**
 * List active omc-team tmux sessions for a given team.
 */
export declare function getTeamTmuxSessions(teamName: string): string[];
/**
 * Format multiplexer session info for human-readable display.
 * Returns null when not inside tmux or Herdr.
 */
export declare function formatTmuxInfo(): string | null;
/**
 * Get the current tmux pane ID (e.g., "%0").
 * Returns null if not running inside tmux.
 *
 * Tries $TMUX_PANE env var first, falls back to tmux display-message.
 */
export declare function getCurrentTmuxPaneId(): string | null;
/**
 * List Herdr team workspaces for a given team (omc-team-<name> labels).
 * Async because the Herdr CLI answers JSON envelopes; returns [] on any
 * failure, mirroring the tmux variant's tolerance.
 */
export declare function getTeamHerdrWorkspaces(teamName: string): Promise<Array<{
    workspaceId: string;
    teamName: string;
    label: string;
}>>;
//# sourceMappingURL=tmux.d.ts.map
/**
 * tmux Session Detection for Notifications
 *
 * Detects the current tmux session name for inclusion in notification payloads.
 */
import { tmuxShell } from "../cli/tmux-utils.js";
/**
 * Get the current tmux session name.
 * Returns null if not running inside tmux.
 */
export function getCurrentTmuxSession() {
    // Check if we're inside a tmux session
    if (!process.env.TMUX) {
        return null;
    }
    try {
        // Use $TMUX_PANE to find the session this process actually belongs to.
        // tmux display-message -p '#S' returns the *attached* session name, which
        // is wrong when Claude runs in a detached session.
        const paneId = process.env.TMUX_PANE;
        if (paneId) {
            const lines = tmuxShell("list-panes -a -F '#{pane_id} #{session_name}'", {
                timeout: 3000,
                stdio: ["pipe", "pipe", "pipe"],
            }).split("\n");
            const match = lines.find((l) => l.startsWith(paneId + " "));
            if (match)
                return match.split(" ")[1] ?? null;
        }
        // Fallback: ask the attached session (may differ when detached).
        const sessionName = tmuxShell("display-message -p '#S'", {
            timeout: 3000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return sessionName || null;
    }
    catch {
        return null;
    }
}
/**
 * List active omc-team tmux sessions for a given team.
 */
export function getTeamTmuxSessions(teamName) {
    const sanitized = teamName.replace(/[^a-zA-Z0-9-]/g, "");
    if (!sanitized)
        return [];
    const prefix = `omc-team-${sanitized}-`;
    try {
        const output = tmuxShell("list-sessions -F '#{session_name}'", {
            timeout: 3000,
            stdio: ["pipe", "pipe", "pipe"],
        });
        return output
            .trim()
            .split("\n")
            .filter((s) => s.startsWith(prefix))
            .map((s) => s.slice(prefix.length));
    }
    catch {
        return [];
    }
}
/**
 * Format tmux session info for human-readable display.
 * Returns null if not in tmux.
 */
export function formatTmuxInfo() {
    const session = getCurrentTmuxSession();
    if (!session)
        return null;
    return `tmux: ${session}`;
}
/**
 * Get the current tmux pane ID (e.g., "%0").
 * Returns null if not running inside tmux.
 *
 * Tries $TMUX_PANE env var first, falls back to tmux display-message.
 */
export function getCurrentTmuxPaneId() {
    if (!process.env.TMUX)
        return null;
    // Prefer $TMUX_PANE (set by tmux automatically)
    const envPane = process.env.TMUX_PANE;
    if (envPane && /^%\d+$/.test(envPane))
        return envPane;
    // Fallback: ask tmux directly (similar to getCurrentTmuxSession)
    try {
        const paneId = tmuxShell("display-message -p '#{pane_id}'", {
            timeout: 3000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return paneId && /^%\d+$/.test(paneId) ? paneId : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=tmux.js.map
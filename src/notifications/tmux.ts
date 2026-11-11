/**
 * tmux Session Detection for Notifications
 *
 * Detects the current tmux session name for inclusion in notification payloads.
 */

import { tmuxShell } from "../cli/tmux-utils.js";
import { isHerdrPaneId } from "../team/tmux-session.js";
import {
  herdrWorkspaceIdFromPaneId,
  listHerdrTeams,
} from "../team/herdr-session.js";

/**
 * The Herdr pane hosting this process, when OMC itself runs inside Herdr.
 * The HERDR_PANE_ID grammar (wN:pM) is validated before any use; an absent
 * or malformed value leaves the default tmux detection untouched.
 */
export function getCurrentHerdrPaneId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const paneId = env.HERDR_PANE_ID?.trim();
  return paneId && isHerdrPaneId(paneId) ? paneId : null;
}

/** Herdr team-session marker (herdr:<workspace_id>) for the current pane. */
function herdrSessionMarker(paneId: string): string | null {
  try {
    return `herdr:${herdrWorkspaceIdFromPaneId(paneId)}`;
  } catch {
    return null;
  }
}

/**
 * Get the current tmux session name.
 * Returns null if not running inside tmux.
 *
 * Inside a Herdr pane the team-session marker (herdr:<workspace_id>) is
 * returned instead, so payloads and registries use the same marker grammar
 * the team layer persists.
 */
export function getCurrentTmuxSession(): string | null {
  const herdrPane = getCurrentHerdrPaneId();
  if (herdrPane) {
    return herdrSessionMarker(herdrPane);
  }

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
      if (match) return match.slice(paneId.length + 1) || null;
    }

    // Fallback: ask the attached session (may differ when detached).
    const sessionName = tmuxShell("display-message -p '#S'", {
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return sessionName || null;
  } catch {
    return null;
  }
}

/**
 * List active omc-team tmux sessions for a given team.
 */
export function getTeamTmuxSessions(teamName: string): string[] {
  const sanitized = teamName.replace(/[^a-zA-Z0-9-]/g, "");
  if (!sanitized) return [];

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
  } catch {
    return [];
  }
}

/**
 * Format multiplexer session info for human-readable display.
 * Returns null when not inside tmux or Herdr.
 */
export function formatTmuxInfo(): string | null {
  const herdrPane = getCurrentHerdrPaneId();
  if (herdrPane) {
    const marker = herdrSessionMarker(herdrPane);
    return marker ? `herdr: ${marker.slice("herdr:".length)}` : null;
  }
  const session = getCurrentTmuxSession();
  if (!session) return null;
  return `tmux: ${session}`;
}

/**
 * Get the current tmux pane ID (e.g., "%0").
 * Returns null if not running inside tmux.
 *
 * Tries $TMUX_PANE env var first, falls back to tmux display-message.
 */
export function getCurrentTmuxPaneId(): string | null {
  // A Herdr pane context wins: the pane id routes notifications and replies
  // to the Herdr agent surface instead of tmux send-keys.
  const herdrPane = getCurrentHerdrPaneId();
  if (herdrPane) return herdrPane;

  if (!process.env.TMUX) return null;

  // Prefer $TMUX_PANE (set by tmux automatically)
  const envPane = process.env.TMUX_PANE;
  if (envPane && /^%\d+$/.test(envPane)) return envPane;

  // Fallback: ask tmux directly (similar to getCurrentTmuxSession)
  try {
    const paneId = tmuxShell("display-message -p '#{pane_id}'", {
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return paneId && /^%\d+$/.test(paneId) ? paneId : null;
  } catch {
    return null;
  }
}

/**
 * List Herdr team workspaces for a given team (omc-team-<name> labels).
 * Async because the Herdr CLI answers JSON envelopes; returns [] on any
 * failure, mirroring the tmux variant's tolerance.
 */
export async function getTeamHerdrWorkspaces(
  teamName: string,
): Promise<Array<{ workspaceId: string; teamName: string; label: string }>> {
  const sanitized = teamName.replace(/[^a-zA-Z0-9-]/g, "");
  if (!sanitized) return [];
  try {
    const teams = await listHerdrTeams();
    return teams.filter((team) => team.teamName === sanitized);
  } catch {
    return [];
  }
}

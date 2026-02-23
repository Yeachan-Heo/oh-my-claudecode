export interface TeamSession {
    sessionName: string;
    leaderPaneId: string;
    workerPaneIds: string[];
}
export interface WorkerPaneConfig {
    teamName: string;
    workerName: string;
    envVars: Record<string, string>;
    launchCmd: string;
    cwd: string;
}
/** Validate tmux is available. Throws with install instructions if not. */
export declare function validateTmux(): void;
/** Sanitize name to prevent tmux command injection (alphanum + hyphen only) */
export declare function sanitizeName(name: string): string;
/** Build session name: "omc-team-{teamName}-{workerName}" */
export declare function sessionName(teamName: string, workerName: string): string;
/** @deprecated Use createTeamSession() instead for split-pane topology */
/** Create a detached tmux session. Kills stale session with same name first. */
export declare function createSession(teamName: string, workerName: string, workingDirectory?: string): string;
/** @deprecated Use killTeamSession() instead */
/** Kill a session by team/worker name. No-op if not found. */
export declare function killSession(teamName: string, workerName: string): void;
/** @deprecated Use isWorkerAlive() with pane ID instead */
/** Check if a session exists */
export declare function isSessionAlive(teamName: string, workerName: string): boolean;
/** List all active worker sessions for a team */
export declare function listActiveSessions(teamName: string): string[];
/**
 * Spawn bridge in session via config temp file.
 *
 * Instead of passing JSON via tmux send-keys (brittle quoting), the caller
 * writes config to a temp file and passes --config flag:
 *   node dist/team/bridge-entry.js --config /tmp/omc-bridge-{worker}.json
 */
export declare function spawnBridgeInSession(tmuxSession: string, bridgeScriptPath: string, configFilePath: string): void;
/**
 * Create a tmux session with split-pane topology for a team.
 *
 * Must be run inside an existing tmux session ($TMUX must be set).
 * Creates splits in the CURRENT window so panes appear immediately
 * in the user's view. Returns sessionName in "session:window" form.
 *
 * Layout: leader pane on the left, worker panes stacked vertically on the right.
 * IMPORTANT: Uses pane IDs (%N format) not pane indices for stable targeting.
 */
export declare function createTeamSession(teamName: string, workerCount: number, cwd: string): Promise<TeamSession>;
/**
 * Spawn a CLI agent in a specific pane.
 * Worker startup: env OMC_TEAM_WORKER={teamName}/workerName shell -lc "exec agentCmd"
 */
export declare function spawnWorkerInPane(sessionName: string, paneId: string, config: WorkerPaneConfig): Promise<void>;
/**
 * Send a short trigger message to a worker via tmux send-keys.
 * Uses robust C-m double-press with delays to ensure the message is submitted.
 * Detects and auto-dismisses trust prompts. Handles busy panes with queue semantics.
 * Message must be < 200 chars.
 * Returns false on error (does not throw).
 */
export declare function sendToWorker(sessionName: string, paneId: string, message: string): Promise<boolean>;
/**
 * Inject a status message into the leader Claude pane.
 * The message is typed into the leader's input, triggering a new conversation turn.
 * Prefixes with [OMC_TMUX_INJECT] marker to distinguish from user input.
 * Returns false on error (does not throw).
 */
export declare function injectToLeaderPane(sessionName: string, leaderPaneId: string, message: string): Promise<boolean>;
/**
 * Wait for a worker to write its ready sentinel file.
 * Polls .omc/state/team/{teamName}/workers/{workerName}/.ready
 * Default timeout: 30s
 */
export declare function waitForWorkerReady(teamName: string, workerName: string, cwd: string, timeoutMs?: number): Promise<boolean>;
/**
 * Check if a worker pane is still alive.
 * Uses pane ID for stable targeting (not pane index).
 */
export declare function isWorkerAlive(paneId: string): Promise<boolean>;
/**
 * Kill the team tmux session or just the worker panes (split-pane mode).
 *
 * When sessionName contains ':' (split-pane mode, "session:window" form),
 * only the worker panes are killed — the leader pane and the user's session
 * are left intact. leaderPaneId is never killed.
 *
 * When sessionName does not contain ':', the entire session is killed.
 */
export declare function killTeamSession(sessionName: string, workerPaneIds?: string[], leaderPaneId?: string): Promise<void>;
/**
 * Respawn a worker in a new pane (when old pane died).
 * Returns the new pane ID.
 */
export declare function respawnWorkerInPane(sessionName: string, config: WorkerPaneConfig): Promise<string>;
//# sourceMappingURL=tmux-session.d.ts.map
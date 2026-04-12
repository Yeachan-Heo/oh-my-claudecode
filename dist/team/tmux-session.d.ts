export type TeamMultiplexerContext = 'tmux' | 'cmux' | 'none';
export declare function detectTeamMultiplexerContext(env?: NodeJS.ProcessEnv): TeamMultiplexerContext;
/**
 * True when running on Windows under MSYS2/Git Bash.
 * Tmux panes run bash in this environment, not cmd.exe.
 */
export declare function isUnixLikeOnWindows(): boolean;
export declare function applyMainVerticalLayout(teamTarget: string): Promise<void>;
export type TeamSessionMode = 'split-pane' | 'dedicated-window' | 'detached-session';
export interface TeamSession {
    sessionName: string;
    leaderPaneId: string;
    workerPaneIds: string[];
    sessionMode: TeamSessionMode;
}
export interface CreateTeamSessionOptions {
    newWindow?: boolean;
}
export interface WorkerPaneConfig {
    teamName: string;
    workerName: string;
    envVars: Record<string, string>;
    launchBinary?: string;
    launchArgs?: string[];
    /** @deprecated Prefer launchBinary + launchArgs for safe argv handling */
    launchCmd?: string;
    cwd: string;
}
export declare function getDefaultShell(): string;
/** Shell + rc file pair used for worker pane launch */
export interface WorkerLaunchSpec {
    shell: string;
    rcFile: string | null;
}
/** Try a list of shell paths; return first existing path or PATH-discovered binary with its rcFile, or null */
export declare function resolveShellFromCandidates(paths: string[], rcFile: string): WorkerLaunchSpec | null;
/** Check if shellPath is a supported shell (zsh/bash) that exists on disk */
export declare function resolveSupportedShellAffinity(shellPath?: string): WorkerLaunchSpec | null;
/**
 * Resolve the shell and rc file to use for worker pane launch.
 *
 * Priority:
 *   1. MSYS2/Windows → /bin/sh (no rcFile)
 *   2. shellPath (from $SHELL) if zsh or bash and binary exists
 *   3. ZSH candidates
 *   4. BASH candidates
 *   5. Fallback: /bin/sh
 */
export declare function buildWorkerLaunchSpec(shellPath?: string): WorkerLaunchSpec;
export declare function buildWorkerStartCommand(config: WorkerPaneConfig): string;
/** Validate tmux is available. Throws with install instructions if not. */
export declare function validateTmux(hasTmuxContext?: boolean): void;
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
 * Create a tmux team topology for a team leader/worker layout.
 *
 * When running inside a classic tmux session, creates splits in the CURRENT
 * window so panes appear immediately in the user's view. When options.newWindow
 * is true, creates a detached dedicated tmux window first and then splits worker
 * panes there.
 *
 * When running inside cmux (CMUX_SURFACE_ID without TMUX) or a plain terminal,
 * falls back to a detached tmux session because the current surface cannot be
 * targeted as a normal tmux pane/window. Returns sessionName in "session:window"
 * form.
 *
 * Layout: leader pane on the left, worker panes stacked vertically on the right.
 * IMPORTANT: Uses pane IDs (%N format) not pane indices for stable targeting.
 */
export declare function createTeamSession(teamName: string, workerCount: number, cwd: string, options?: CreateTeamSessionOptions): Promise<TeamSession>;
/**
 * Spawn a CLI agent in a specific pane.

 * Worker startup: env OMC_TEAM_WORKER={teamName}/workerName shell -lc "exec agentCmd"
 */
export declare function spawnWorkerInPane(sessionName: string, paneId: string, config: WorkerPaneConfig): Promise<void>;
export declare function paneHasActiveTask(captured: string): boolean;
export declare function paneLooksReady(captured: string): boolean;
export interface WaitForPaneReadyOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
}
export declare function waitForPaneReady(paneId: string, opts?: WaitForPaneReadyOptions): Promise<boolean>;
export declare function shouldAttemptAdaptiveRetry(args: {
    paneBusy: boolean;
    latestCapture: string | null;
    message: string;
    paneInCopyMode: boolean;
    retriesAttempted: number;
}): boolean;
/**
 * Send a short trigger message to a worker via tmux send-keys.
 * Uses robust C-m double-press with delays to ensure the message is submitted.
 * Detects and auto-dismisses trust prompts. Handles busy panes with queue semantics.
 * Message must be < 200 chars.
 * Returns false on error (does not throw).
 */
export declare function sendToWorker(_sessionName: string, paneId: string, message: string): Promise<boolean>;
/**
 * Inject a status message into the leader Claude pane.
 * The message is typed into the leader's input, triggering a new conversation turn.
 * Prefixes with [OMC_TMUX_INJECT] marker to distinguish from user input.
 * Returns false on error (does not throw).
 */
export declare function injectToLeaderPane(sessionName: string, leaderPaneId: string, message: string): Promise<boolean>;
/**
 * Check if a worker pane is still alive.
 * Uses pane ID for stable targeting (not pane index).
 */
export declare function isWorkerAlive(paneId: string): Promise<boolean>;
/**
 * Graceful-then-force kill of worker panes.
 * Writes a shutdown sentinel, waits up to graceMs, then force-kills remaining panes.
 * Never kills the leader pane.
 */
export declare function killWorkerPanes(opts: {
    paneIds: string[];
    leaderPaneId?: string;
    teamName: string;
    cwd: string;
    graceMs?: number;
}): Promise<void>;
export declare function resolveSplitPaneWorkerPaneIds(sessionName: string, recordedPaneIds?: string[], leaderPaneId?: string): Promise<string[]>;
/**
 * Kill the team tmux session or just the worker panes, depending on how the
 * team was created.
 *
 * - split-pane: kill only worker panes; preserve the leader pane and user window.
 * - dedicated-window: kill the owned tmux window.
 * - detached-session: kill the fully owned tmux session.
 */
export declare function killTeamSession(sessionName: string, workerPaneIds?: string[], leaderPaneId?: string, options?: {
    sessionMode?: TeamSessionMode;
}): Promise<void>;
//# sourceMappingURL=tmux-session.d.ts.map
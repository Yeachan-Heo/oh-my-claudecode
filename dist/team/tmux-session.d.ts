/** Validate tmux is available. Throws with install instructions if not. */
export declare function validateTmux(): void;
/** Sanitize name to prevent tmux command injection (alphanum + hyphen only) */
export declare function sanitizeName(name: string): string;
/** Build session name: "omc-team-{teamName}-{workerName}" */
export declare function sessionName(teamName: string, workerName: string): string;
/** Create a detached tmux session. Kills stale session with same name first. */
export declare function createSession(teamName: string, workerName: string, workingDirectory?: string): string;
/** Kill a session by team/worker name. No-op if not found. */
export declare function killSession(teamName: string, workerName: string): void;
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
//# sourceMappingURL=tmux-session.d.ts.map
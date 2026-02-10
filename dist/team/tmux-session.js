// src/team/tmux-session.ts
/**
 * Tmux Session Management for MCP Team Bridge
 *
 * Create, kill, list, and manage tmux sessions for MCP worker bridge daemons.
 * Sessions are named "omc-team-{teamName}-{workerName}".
 */
import { execSync, execFileSync } from 'child_process';
const TMUX_SESSION_PREFIX = 'omc-team';
/** Validate tmux is available. Throws with install instructions if not. */
export function validateTmux() {
    try {
        execSync('tmux -V', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    }
    catch {
        throw new Error('tmux is not available. Install it:\n' +
            '  macOS: brew install tmux\n' +
            '  Ubuntu/Debian: sudo apt-get install tmux\n' +
            '  Fedora: sudo dnf install tmux\n' +
            '  Arch: sudo pacman -S tmux');
    }
}
/** Sanitize name to prevent tmux command injection (alphanum + hyphen only) */
export function sanitizeName(name) {
    const sanitized = name.replace(/[^a-zA-Z0-9-]/g, '');
    if (sanitized.length === 0) {
        throw new Error(`Invalid name: "${name}" contains no valid characters (alphanumeric or hyphen)`);
    }
    if (sanitized.length < 2) {
        throw new Error(`Invalid name: "${name}" too short after sanitization (minimum 2 characters)`);
    }
    // Truncate to safe length for tmux session names
    return sanitized.slice(0, 50);
}
/** Build session name: "omc-team-{teamName}-{workerName}" */
export function sessionName(teamName, workerName) {
    return `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${sanitizeName(workerName)}`;
}
/** Create a detached tmux session. Kills stale session with same name first. */
export function createSession(teamName, workerName, workingDirectory) {
    const name = sessionName(teamName, workerName);
    // Kill existing session if present (stale from previous run)
    try {
        execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe', timeout: 5000 });
    }
    catch { /* ignore — session may not exist */ }
    // Create detached session with reasonable terminal size
    const args = ['new-session', '-d', '-s', name, '-x', '200', '-y', '50'];
    if (workingDirectory) {
        args.push('-c', workingDirectory);
    }
    execFileSync('tmux', args, { stdio: 'pipe', timeout: 5000 });
    return name;
}
/** Kill a session by team/worker name. No-op if not found. */
export function killSession(teamName, workerName) {
    const name = sessionName(teamName, workerName);
    try {
        execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe', timeout: 5000 });
    }
    catch { /* ignore — session may not exist */ }
}
/** Check if a session exists */
export function isSessionAlive(teamName, workerName) {
    const name = sessionName(teamName, workerName);
    try {
        execFileSync('tmux', ['has-session', '-t', name], { stdio: 'pipe', timeout: 5000 });
        return true;
    }
    catch {
        return false;
    }
}
/** List all active worker sessions for a team */
export function listActiveSessions(teamName) {
    const prefix = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-`;
    try {
        const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
        return output.trim().split('\n')
            .filter(s => s.startsWith(prefix))
            .map(s => s.slice(prefix.length));
    }
    catch {
        return [];
    }
}
/**
 * Spawn bridge in session via config temp file.
 *
 * Instead of passing JSON via tmux send-keys (brittle quoting), the caller
 * writes config to a temp file and passes --config flag:
 *   node dist/team/bridge-entry.js --config /tmp/omc-bridge-{worker}.json
 */
export function spawnBridgeInSession(tmuxSession, bridgeScriptPath, configFilePath) {
    const cmd = `node "${bridgeScriptPath}" --config "${configFilePath}"`;
    execFileSync('tmux', ['send-keys', '-t', tmuxSession, cmd, 'Enter'], { stdio: 'pipe', timeout: 5000 });
}
//# sourceMappingURL=tmux-session.js.map
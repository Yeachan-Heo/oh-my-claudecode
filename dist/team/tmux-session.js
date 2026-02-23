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
/** @deprecated Use createTeamSession() instead for split-pane topology */
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
/** @deprecated Use killTeamSession() instead */
/** Kill a session by team/worker name. No-op if not found. */
export function killSession(teamName, workerName) {
    const name = sessionName(teamName, workerName);
    try {
        execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe', timeout: 5000 });
    }
    catch { /* ignore — session may not exist */ }
}
/** @deprecated Use isWorkerAlive() with pane ID instead */
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
export async function createTeamSession(teamName, workerCount, cwd) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    if (!process.env.TMUX) {
        throw new Error('Team mode requires running inside tmux. Start one: tmux new-session');
    }
    // Get "session:window" target and leader pane ID in one call
    const contextResult = await execFileAsync('tmux', [
        'display-message', '-p', '#S:#I #{pane_id}'
    ]);
    const contextLine = contextResult.stdout.trim();
    const spaceIdx = contextLine.indexOf(' ');
    const sessionAndWindow = contextLine.slice(0, spaceIdx);
    const leaderPaneId = contextLine.slice(spaceIdx + 1);
    const teamTarget = sessionAndWindow; // "session:window" form
    // Extract bare session name (before ':') for options that don't accept window targets
    const resolvedSessionName = teamTarget.split(':')[0];
    const workerPaneIds = [];
    // Create worker panes: first via horizontal split off leader, rest stacked vertically on right
    for (let i = 0; i < workerCount; i++) {
        const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
        const splitType = i === 0 ? '-h' : '-v';
        // -d: don't switch focus to new pane; -P -F: print new pane ID directly
        const splitResult = await execFileAsync('tmux', [
            'split-window', splitType, '-t', splitTarget,
            '-d', '-P', '-F', '#{pane_id}',
            '-c', cwd,
        ]);
        const paneId = splitResult.stdout.split('\n')[0]?.trim();
        if (paneId) {
            workerPaneIds.push(paneId);
        }
    }
    // Apply main-vertical layout to balance the panes
    try {
        await execFileAsync('tmux', ['select-layout', '-t', teamTarget, 'main-vertical']);
    }
    catch {
        // Layout may not apply if only 1 pane; ignore
    }
    // Set leader pane to half the window width
    try {
        const widthResult = await execFileAsync('tmux', [
            'display-message', '-p', '-t', teamTarget, '#{window_width}'
        ]);
        const width = parseInt(widthResult.stdout.trim(), 10);
        if (Number.isFinite(width) && width >= 40) {
            const half = String(Math.floor(width / 2));
            await execFileAsync('tmux', ['set-window-option', '-t', teamTarget, 'main-pane-width', half]);
            await execFileAsync('tmux', ['select-layout', '-t', teamTarget, 'main-vertical']);
        }
    }
    catch { /* ignore layout sizing errors */ }
    // Enable mouse mode so user can click/scroll panes
    try {
        await execFileAsync('tmux', ['set-option', '-t', resolvedSessionName, 'mouse', 'on']);
    }
    catch { /* ignore */ }
    // Return focus to leader pane
    try {
        await execFileAsync('tmux', ['select-pane', '-t', leaderPaneId]);
    }
    catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 300));
    return { sessionName: teamTarget, leaderPaneId, workerPaneIds };
}
/**
 * Spawn a CLI agent in a specific pane.
 * Worker startup: env OMC_TEAM_WORKER={teamName}/workerName shell -lc "exec agentCmd"
 */
export async function spawnWorkerInPane(sessionName, paneId, config) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    // Build env prefix string
    const envString = Object.entries(config.envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
    const shell = process.env.SHELL || '/bin/bash';
    const shellName = shell.split('/').pop() || 'bash';
    const rcFile = process.env.HOME ? `${process.env.HOME}/.${shellName}rc` : '';
    // Quote rcFile to prevent shell injection if HOME contains metacharacters
    const sourceCmd = rcFile ? `[ -f "${rcFile}" ] && source "${rcFile}"; ` : '';
    const startCmd = `env ${envString} ${shell} -c "${sourceCmd}exec ${config.launchCmd}"`;
    // Use -l (literal) flag to prevent tmux key-name parsing of the command string
    await execFileAsync('tmux', [
        'send-keys', '-t', paneId, '-l', startCmd
    ]);
    await execFileAsync('tmux', ['send-keys', '-t', paneId, 'Enter']);
}
function normalizeTmuxCapture(value) {
    return value.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}
async function capturePaneAsync(paneId, execFileAsync) {
    try {
        const result = await execFileAsync('tmux', ['capture-pane', '-t', paneId, '-p', '-S', '-80']);
        return result.stdout;
    }
    catch {
        return '';
    }
}
function paneHasTrustPrompt(captured) {
    const lines = captured.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
    const tail = lines.slice(-12);
    const hasQuestion = tail.some(l => /Do you trust the contents of this directory\?/i.test(l));
    const hasChoices = tail.some(l => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(l));
    return hasQuestion && hasChoices;
}
function paneHasActiveTask(captured) {
    const lines = captured.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
    const tail = lines.slice(-40);
    if (tail.some(l => /esc to interrupt/i.test(l)))
        return true;
    if (tail.some(l => /\bbackground terminal running\b/i.test(l)))
        return true;
    return false;
}
function paneTailContainsLiteralLine(captured, text) {
    return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(text));
}
/**
 * Send a short trigger message to a worker via tmux send-keys.
 * Uses robust C-m double-press with delays to ensure the message is submitted.
 * Detects and auto-dismisses trust prompts. Handles busy panes with queue semantics.
 * Message must be < 200 chars.
 * Returns false on error (does not throw).
 */
export async function sendToWorker(sessionName, paneId, message) {
    if (message.length > 200) {
        console.warn(`[tmux-session] sendToWorker: message truncated to 200 chars`);
        message = message.slice(0, 200);
    }
    try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const sendKey = async (key) => {
            await execFileAsync('tmux', ['send-keys', '-t', paneId, key]);
        };
        // Check for trust prompt and auto-dismiss before sending our text
        const initialCapture = await capturePaneAsync(paneId, execFileAsync);
        const paneBusy = paneHasActiveTask(initialCapture);
        if (paneHasTrustPrompt(initialCapture)) {
            await sendKey('C-m');
            await sleep(120);
            await sendKey('C-m');
            await sleep(200);
        }
        // Send text in literal mode with -- separator
        await execFileAsync('tmux', ['send-keys', '-t', paneId, '-l', '--', message]);
        // Allow input buffer to settle
        await sleep(150);
        // Submit: up to 6 rounds of C-m double-press.
        // For busy panes, first round uses Tab+C-m (queue semantics).
        const submitRounds = 6;
        for (let round = 0; round < submitRounds; round++) {
            await sleep(100);
            if (round === 0 && paneBusy) {
                await sendKey('Tab');
                await sleep(80);
                await sendKey('C-m');
            }
            else {
                await sendKey('C-m');
                await sleep(200);
                await sendKey('C-m');
            }
            await sleep(140);
            // Check if text is still visible in the pane — if not, it was submitted
            const checkCapture = await capturePaneAsync(paneId, execFileAsync);
            if (!paneTailContainsLiteralLine(checkCapture, message))
                return true;
            await sleep(140);
        }
        // Fail-open: one last nudge, then continue regardless
        await sendKey('C-m');
        await sleep(120);
        await sendKey('C-m');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Inject a status message into the leader Claude pane.
 * The message is typed into the leader's input, triggering a new conversation turn.
 * Prefixes with [OMC_TMUX_INJECT] marker to distinguish from user input.
 * Returns false on error (does not throw).
 */
export async function injectToLeaderPane(sessionName, leaderPaneId, message) {
    const prefixed = `[OMC_TMUX_INJECT] ${message}`.slice(0, 200);
    return sendToWorker(sessionName, leaderPaneId, prefixed);
}
/**
 * Wait for a worker to write its ready sentinel file.
 * Polls .omc/state/team/{teamName}/workers/{workerName}/.ready
 * Default timeout: 30s
 */
export async function waitForWorkerReady(teamName, workerName, cwd, timeoutMs = 30_000) {
    const { access } = await import('fs/promises');
    const { join } = await import('path');
    const sentinelPath = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}/.ready`);
    const pollInterval = 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await access(sentinelPath);
            return true;
        }
        catch {
            await new Promise(r => setTimeout(r, pollInterval));
        }
    }
    return false;
}
/**
 * Check if a worker pane is still alive.
 * Uses pane ID for stable targeting (not pane index).
 */
export async function isWorkerAlive(paneId) {
    try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const result = await execFileAsync('tmux', [
            'display-message', '-t', paneId, '-p', '#{pane_dead}'
        ]);
        return result.stdout.trim() === '0';
    }
    catch {
        return false;
    }
}
/**
 * Kill the team tmux session or just the worker panes (split-pane mode).
 *
 * When sessionName contains ':' (split-pane mode, "session:window" form),
 * only the worker panes are killed — the leader pane and the user's session
 * are left intact. leaderPaneId is never killed.
 *
 * When sessionName does not contain ':', the entire session is killed.
 */
export async function killTeamSession(sessionName, workerPaneIds, leaderPaneId) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    if (sessionName.includes(':') && workerPaneIds && workerPaneIds.length > 0) {
        // Split-pane mode: kill only worker panes, never the leader
        for (const paneId of workerPaneIds) {
            if (leaderPaneId && paneId === leaderPaneId)
                continue;
            try {
                await execFileAsync('tmux', ['kill-pane', '-t', paneId]);
            }
            catch {
                // Pane may already be dead
            }
        }
    }
    else {
        try {
            await execFileAsync('tmux', ['kill-session', '-t', sessionName]);
        }
        catch {
            // Session may already be dead
        }
    }
}
/**
 * Respawn a worker in a new pane (when old pane died).
 * Returns the new pane ID.
 */
export async function respawnWorkerInPane(sessionName, config) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    // Create new vertical split in the session
    await execFileAsync('tmux', [
        'split-window', '-v', '-t', sessionName, '-c', config.cwd
    ]);
    // Get the new pane ID
    const allPanesResult = await execFileAsync('tmux', [
        'list-panes', '-t', sessionName, '-F', '#{pane_id}'
    ]);
    const allPanes = allPanesResult.stdout.trim().split('\n').filter(Boolean);
    const newPaneId = allPanes[allPanes.length - 1];
    // Spawn worker in new pane
    await spawnWorkerInPane(sessionName, newPaneId, config);
    return newPaneId;
}
//# sourceMappingURL=tmux-session.js.map
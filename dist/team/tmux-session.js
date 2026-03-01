// src/team/tmux-session.ts
/**
 * Tmux Session Management for MCP Team Bridge
 *
 * Create, kill, list, and manage tmux sessions for MCP worker bridge daemons.
 * Sessions are named "omc-team-{teamName}-{workerName}".
 */
import { exec, execFile, execSync, execFileSync } from 'child_process';
import { join, basename } from 'path';
import { promisify } from 'util';
import fs from 'fs/promises';
import { validateTeamName } from './team-name.js';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TMUX_SESSION_PREFIX = 'omc-team';
const promisifiedExec = promisify(exec);
const promisifiedExecFile = promisify(execFile);
/**
 * True when running on Windows under MSYS2/Git Bash.
 * Tmux panes run bash in this environment, not cmd.exe.
 */
export function isUnixLikeOnWindows() {
    return process.platform === 'win32' &&
        !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}
/**
 * Execute a tmux command asynchronously. Routes through shell when arguments
 * contain tmux format strings (e.g. #{pane_id}) to prevent MSYS2 execFile
 * from stripping curly braces.
 */
async function tmuxAsync(args) {
    if (args.some(a => a.includes('#{'))) {
        const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
        return promisifiedExec(`tmux ${escaped}`);
    }
    return promisifiedExecFile('tmux', args);
}
export function getDefaultShell() {
    if (process.platform === 'win32' && !isUnixLikeOnWindows()) {
        return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
}
function escapeForCmdSet(value) {
    return value.replace(/"/g, '""');
}
function shellNameFromPath(shellPath) {
    const shellName = basename(shellPath.replace(/\\/g, '/'));
    return shellName.replace(/\.(exe|cmd|bat)$/i, '');
}
function shellEscape(value) {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
function assertSafeEnvKey(key) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment key: "${key}"`);
    }
}
function getLaunchWords(config) {
    if (config.launchBinary) {
        return [config.launchBinary, ...(config.launchArgs ?? [])];
    }
    if (config.launchCmd) {
        return [config.launchCmd];
    }
    throw new Error('Missing worker launch command. Provide launchBinary or launchCmd.');
}
export function buildWorkerStartCommand(config) {
    const shell = getDefaultShell();
    const launchWords = getLaunchWords(config);
    if (process.platform === 'win32' && !isUnixLikeOnWindows()) {
        const envPrefix = Object.entries(config.envVars)
            .map(([k, v]) => {
            assertSafeEnvKey(k);
            return `set "${k}=${escapeForCmdSet(v)}"`;
        })
            .join(' && ');
        const launch = config.launchBinary
            ? launchWords.map((part) => `"${escapeForCmdSet(part)}"`).join(' ')
            : launchWords[0];
        const cmdBody = envPrefix ? `${envPrefix} && ${launch}` : launch;
        return `${shell} /d /s /c "${cmdBody}"`;
    }
    if (config.launchBinary) {
        const envAssignments = Object.entries(config.envVars).map(([key, value]) => {
            assertSafeEnvKey(key);
            return `${key}=${shellEscape(value)}`;
        });
        const shellName = shellNameFromPath(shell) || 'bash';
        const rcFile = process.env.HOME ? `${process.env.HOME}/.${shellName}rc` : '';
        const script = rcFile
            ? `[ -f ${shellEscape(rcFile)} ] && . ${shellEscape(rcFile)}; exec "$@"`
            : 'exec "$@"';
        return [
            'env',
            ...envAssignments,
            shell,
            '-lc',
            script,
            '--',
            ...launchWords,
        ].map(shellEscape).join(' ');
    }
    const envString = Object.entries(config.envVars)
        .map(([k, v]) => {
        assertSafeEnvKey(k);
        return `${k}=${shellEscape(v)}`;
    })
        .join(' ');
    const shellName = shellNameFromPath(shell) || 'bash';
    const rcFile = process.env.HOME ? `${process.env.HOME}/.${shellName}rc` : '';
    // Quote rcFile to prevent shell injection if HOME contains metacharacters
    const sourceCmd = rcFile ? `[ -f "${rcFile}" ] && source "${rcFile}"; ` : '';
    return `env ${envString} ${shell} -c "${sourceCmd}exec ${launchWords[0]}"`;
}
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
        // Use shell execution to prevent MSYS2 from stripping #{} in format strings
        const fmtArgs = ['list-sessions', '-F', '#{session_name}'];
        const shellCmd = 'tmux ' + fmtArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
        const output = execSync(shellCmd, {
            encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
        });
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
    // Prefer the invoking pane from environment to avoid focus races when users
    // switch tmux windows during startup (issue #966).
    const envPaneIdRaw = (process.env.TMUX_PANE ?? '').trim();
    const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : '';
    let sessionAndWindow = '';
    let leaderPaneId = envPaneId;
    if (envPaneId) {
        try {
            const targetedContextResult = await execFileAsync('tmux', [
                'display-message', '-p', '-t', envPaneId, '#S:#I'
            ]);
            sessionAndWindow = targetedContextResult.stdout.trim();
        }
        catch {
            sessionAndWindow = '';
            leaderPaneId = '';
        }
    }
    if (!sessionAndWindow || !leaderPaneId) {
        // Fallback when TMUX_PANE is unavailable/invalid.
        const contextResult = await tmuxAsync([
            'display-message', '-p', '#S:#I #{pane_id}'
        ]);
        const contextLine = contextResult.stdout.trim();
        const contextMatch = contextLine.match(/^(\S+)\s+(%\d+)$/);
        if (!contextMatch) {
            throw new Error(`Failed to resolve tmux context: "${contextLine}"`);
        }
        sessionAndWindow = contextMatch[1];
        leaderPaneId = contextMatch[2];
    }
    const teamTarget = sessionAndWindow; // "session:window" form
    // Extract bare session name (before ':') for options that don't accept window targets
    const resolvedSessionName = teamTarget.split(':')[0];
    const workerPaneIds = [];
    if (workerCount <= 0) {
        // Leader-only topology: no worker panes yet (spawned on demand later).
        try {
            await execFileAsync('tmux', ['set-option', '-t', resolvedSessionName, 'mouse', 'on']);
        }
        catch { /* ignore */ }
        try {
            await execFileAsync('tmux', ['select-pane', '-t', leaderPaneId]);
        }
        catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 300));
        return { sessionName: teamTarget, leaderPaneId, workerPaneIds };
    }
    // Create worker panes: first via horizontal split off leader, rest stacked vertically on right
    for (let i = 0; i < workerCount; i++) {
        const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
        const splitType = i === 0 ? '-h' : '-v';
        // -d: don't switch focus to new pane; -P -F: print new pane ID directly
        const splitResult = await tmuxAsync([
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
        const widthResult = await tmuxAsync([
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
    validateTeamName(config.teamName);
    const startCmd = buildWorkerStartCommand(config);
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
export function paneHasActiveTask(captured) {
    const lines = captured.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
    const tail = lines.slice(-40);
    if (tail.some(l => /esc to interrupt/i.test(l)))
        return true;
    if (tail.some(l => /\bbackground terminal running\b/i.test(l)))
        return true;
    return false;
}
export function paneLooksReady(captured) {
    const lines = captured
        .split('\n')
        .map(line => line.replace(/\r/g, '').trim())
        .filter(line => line.length > 0);
    if (lines.length === 0)
        return false;
    const tail = lines.slice(-20);
    const hasPrompt = tail.some(line => /^\s*[›>❯]\s*/u.test(line));
    if (hasPrompt)
        return true;
    const hasCodexHint = tail.some(line => /\bgpt-[\w.-]+\b/i.test(line) || /\b\d+% left\b/i.test(line));
    return hasCodexHint;
}
function paneTailContainsLiteralLine(captured, text) {
    return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(text));
}
async function paneInCopyMode(paneId, execFileAsync) {
    try {
        const result = await tmuxAsync(['display-message', '-t', paneId, '-p', '#{pane_in_mode}']);
        return result.stdout.trim() === '1';
    }
    catch {
        return false;
    }
}
export function shouldAttemptAdaptiveRetry(args) {
    if (process.env.OMX_TEAM_AUTO_INTERRUPT_RETRY === '0')
        return false;
    if (args.retriesAttempted >= 1)
        return false;
    if (args.paneInCopyMode)
        return false;
    if (!args.paneBusy)
        return false;
    if (typeof args.latestCapture !== 'string')
        return false;
    if (!paneTailContainsLiteralLine(args.latestCapture, args.message))
        return false;
    if (paneHasActiveTask(args.latestCapture))
        return false;
    if (!paneLooksReady(args.latestCapture))
        return false;
    return true;
}
/**
 * Send a short trigger message to a worker via tmux send-keys.
 * Uses robust C-m double-press with delays to ensure the message is submitted.
 * Detects and auto-dismisses trust prompts. Handles busy panes with queue semantics.
 * Message must be < 200 chars.
 * Returns false on error (does not throw).
 */
export async function sendToWorker(_sessionName, paneId, message) {
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
        // Guard: copy-mode captures keys; skip injection entirely.
        if (await paneInCopyMode(paneId, execFileAsync)) {
            return false;
        }
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
        // Safety gate: copy-mode can turn on while we retry; never send fallback control keys when active.
        if (await paneInCopyMode(paneId, execFileAsync)) {
            return false;
        }
        // Adaptive fallback: for busy panes, retry once without interrupting active turns.
        const finalCapture = await capturePaneAsync(paneId, execFileAsync);
        const paneModeBeforeAdaptiveRetry = await paneInCopyMode(paneId, execFileAsync);
        if (shouldAttemptAdaptiveRetry({
            paneBusy,
            latestCapture: finalCapture,
            message,
            paneInCopyMode: paneModeBeforeAdaptiveRetry,
            retriesAttempted: 0,
        })) {
            if (await paneInCopyMode(paneId, execFileAsync)) {
                return false;
            }
            await sendKey('C-u');
            await sleep(80);
            if (await paneInCopyMode(paneId, execFileAsync)) {
                return false;
            }
            await execFileAsync('tmux', ['send-keys', '-t', paneId, '-l', '--', message]);
            await sleep(120);
            for (let round = 0; round < 4; round++) {
                await sendKey('C-m');
                await sleep(180);
                await sendKey('C-m');
                await sleep(140);
                const retryCapture = await capturePaneAsync(paneId, execFileAsync);
                if (!paneTailContainsLiteralLine(retryCapture, message))
                    return true;
            }
        }
        // Before fallback control keys, re-check copy-mode to avoid mutating scrollback UI state.
        if (await paneInCopyMode(paneId, execFileAsync)) {
            return false;
        }
        // Fail-open: one last nudge, then continue regardless.
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
    // If the leader is running a blocking tool (e.g. omc_run_team_wait shows
    // "esc to interrupt"), send C-c first so the message is not queued in the
    // stdin buffer behind the blocked process.
    try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        if (await paneInCopyMode(leaderPaneId, execFileAsync)) {
            return false;
        }
        const captured = await capturePaneAsync(leaderPaneId, execFileAsync);
        if (paneHasActiveTask(captured)) {
            await execFileAsync('tmux', ['send-keys', '-t', leaderPaneId, 'C-c']);
            await new Promise(r => setTimeout(r, 250));
        }
    }
    catch { /* best-effort */ }
    return sendToWorker(sessionName, leaderPaneId, prefixed);
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
        const result = await tmuxAsync([
            'display-message', '-t', paneId, '-p', '#{pane_dead}'
        ]);
        return result.stdout.trim() === '0';
    }
    catch {
        return false;
    }
}
/**
 * Graceful-then-force kill of worker panes.
 * Writes a shutdown sentinel, waits up to graceMs, then force-kills remaining panes.
 * Never kills the leader pane.
 */
export async function killWorkerPanes(opts) {
    const { paneIds, leaderPaneId, teamName, cwd, graceMs = 10_000 } = opts;
    if (!paneIds.length)
        return; // guard: nothing to kill
    // 1. Write graceful shutdown sentinel
    const shutdownPath = join(cwd, '.omc', 'state', 'team', teamName, 'shutdown.json');
    try {
        await fs.writeFile(shutdownPath, JSON.stringify({ requestedAt: Date.now() }));
        await sleep(graceMs);
    }
    catch { /* sentinel write failure is non-fatal */ }
    // 2. Force-kill each worker pane, guarding leader
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    for (const paneId of paneIds) {
        if (paneId === leaderPaneId)
            continue; // GUARD — never kill leader
        try {
            await execFileAsync('tmux', ['kill-pane', '-t', paneId]);
        }
        catch { /* pane already gone — OK */ }
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
    if (sessionName.includes(':')) {
        // Split-pane mode: kill ONLY worker panes, never kill-session
        if (!workerPaneIds?.length)
            return; // no-op guard
        for (const id of workerPaneIds) {
            if (id === leaderPaneId)
                continue;
            try {
                await execFileAsync('tmux', ['kill-pane', '-t', id]);
            }
            catch { /* already gone */ }
        }
        return;
    }
    // Session mode: this session is fully owned by the team
    try {
        await execFileAsync('tmux', ['kill-session', '-t', sessionName]);
    }
    catch {
        // Session may already be dead
    }
}
//# sourceMappingURL=tmux-session.js.map
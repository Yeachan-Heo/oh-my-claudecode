// src/team/tmux-session.ts
/**
 * Tmux Session Management for MCP Team Bridge
 *
 * Create, kill, list, and manage tmux sessions for MCP worker bridge daemons.
 * Sessions are named "omc-team-{teamName}-{workerName}".
 */
import { exec, execFile, execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join, basename, isAbsolute, win32 } from 'path';
import { promisify } from 'util';
import fs from 'fs/promises';
import { validateTeamName } from './team-name.js';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TMUX_SESSION_PREFIX = 'omc-team';
const promisifiedExec = promisify(exec);
const promisifiedExecFile = promisify(execFile);
export function detectTeamMultiplexerContext(env = process.env) {
    if (env.TMUX)
        return 'tmux';
    if (env.CMUX_SURFACE_ID)
        return 'cmux';
    return 'none';
}
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
        // MSYS2/Git Bash strips curly braces from execFile arguments.
        // Use shell execution with proper single-quote escaping.
        const escaped = args.map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ');
        return promisifiedExec(`tmux ${escaped}`);
    }
    return promisifiedExecFile('tmux', args);
}
export async function applyMainVerticalLayout(teamTarget) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    try {
        await execFileAsync('tmux', ['select-layout', '-t', teamTarget, 'main-vertical']);
    }
    catch {
        // Layout may not apply if only 1 pane; ignore.
    }
    try {
        const widthResult = await tmuxAsync([
            'display-message', '-p', '-t', teamTarget, '#{window_width}',
        ]);
        const width = parseInt(widthResult.stdout.trim(), 10);
        if (Number.isFinite(width) && width >= 40) {
            const half = String(Math.floor(width / 2));
            await execFileAsync('tmux', ['set-window-option', '-t', teamTarget, 'main-pane-width', half]);
            await execFileAsync('tmux', ['select-layout', '-t', teamTarget, 'main-vertical']);
        }
    }
    catch {
        /* ignore layout sizing errors */
    }
}
/** Shells known to support the `-lc 'exec "$@"'` invocation pattern. */
const SUPPORTED_POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh']);
export function getDefaultShell() {
    if (process.platform === 'win32' && !isUnixLikeOnWindows()) {
        return process.env.COMSPEC || 'cmd.exe';
    }
    const shell = process.env.SHELL || '/bin/bash';
    // Validate that the shell supports our launch script syntax.
    // Unsupported shells (tcsh, csh, etc.) fall back to /bin/sh.
    const name = basename(shell.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');
    if (!SUPPORTED_POSIX_SHELLS.has(name)) {
        return '/bin/sh';
    }
    return shell;
}
const ZSH_CANDIDATES = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'];
const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash'];
function pathEntries(envPath) {
    return (envPath ?? '')
        .split(process.platform === 'win32' ? ';' : ':')
        .map(entry => entry.trim())
        .filter(Boolean);
}
function pathCandidateNames(candidatePath) {
    const base = basename(candidatePath.replace(/\\/g, '/'));
    const bare = base.replace(/\.(exe|cmd|bat)$/i, '');
    if (process.platform === 'win32') {
        return Array.from(new Set([`${bare}.exe`, `${bare}.cmd`, `${bare}.bat`, bare]));
    }
    return Array.from(new Set([base, bare]));
}
function resolveShellFromPath(candidatePath) {
    for (const dir of pathEntries(process.env.PATH)) {
        for (const name of pathCandidateNames(candidatePath)) {
            const full = join(dir, name);
            if (existsSync(full))
                return full;
        }
    }
    return null;
}
/** Try a list of shell paths; return first existing path or PATH-discovered binary with its rcFile, or null */
export function resolveShellFromCandidates(paths, rcFile) {
    for (const p of paths) {
        if (existsSync(p))
            return { shell: p, rcFile };
        const resolvedFromPath = resolveShellFromPath(p);
        if (resolvedFromPath)
            return { shell: resolvedFromPath, rcFile };
    }
    return null;
}
/** Check if shellPath is a supported shell (zsh/bash) that exists on disk */
export function resolveSupportedShellAffinity(shellPath) {
    if (!shellPath)
        return null;
    const name = basename(shellPath.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');
    if (name !== 'zsh' && name !== 'bash')
        return null;
    if (!existsSync(shellPath))
        return null;
    const home = process.env.HOME ?? '';
    const rcFile = home ? `${home}/.${name}rc` : null;
    return { shell: shellPath, rcFile };
}
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
export function buildWorkerLaunchSpec(shellPath) {
    // MSYS2 / Windows: short-circuit to /bin/sh
    if (isUnixLikeOnWindows()) {
        return { shell: '/bin/sh', rcFile: null };
    }
    // Try user's preferred shell if it's supported (zsh or bash)
    const preferred = resolveSupportedShellAffinity(shellPath);
    if (preferred)
        return preferred;
    // Try zsh candidates
    const home = process.env.HOME ?? '';
    const zshRc = home ? `${home}/.zshrc` : null;
    const zsh = resolveShellFromCandidates(ZSH_CANDIDATES, zshRc ?? '');
    if (zsh)
        return { shell: zsh.shell, rcFile: zshRc };
    // Try bash candidates
    const bashRc = home ? `${home}/.bashrc` : null;
    const bash = resolveShellFromCandidates(BASH_CANDIDATES, bashRc ?? '');
    if (bash)
        return { shell: bash.shell, rcFile: bashRc };
    // Final fallback
    return { shell: '/bin/sh', rcFile: null };
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
const DANGEROUS_LAUNCH_BINARY_CHARS = /[;&|`$()<>\n\r\t\0]/;
function isAbsoluteLaunchBinaryPath(value) {
    return isAbsolute(value) || win32.isAbsolute(value);
}
function assertSafeLaunchBinary(launchBinary) {
    if (launchBinary.trim().length === 0) {
        throw new Error('Invalid launchBinary: value cannot be empty');
    }
    if (launchBinary !== launchBinary.trim()) {
        throw new Error('Invalid launchBinary: value cannot have leading/trailing whitespace');
    }
    if (DANGEROUS_LAUNCH_BINARY_CHARS.test(launchBinary)) {
        throw new Error('Invalid launchBinary: contains dangerous shell metacharacters');
    }
    if (/\s/.test(launchBinary) && !isAbsoluteLaunchBinaryPath(launchBinary)) {
        throw new Error('Invalid launchBinary: paths with spaces must be absolute');
    }
}
function getLaunchWords(config) {
    if (config.launchBinary) {
        assertSafeLaunchBinary(config.launchBinary);
        return [config.launchBinary, ...(config.launchArgs ?? [])];
    }
    if (config.launchCmd) {
        throw new Error('launchCmd is deprecated and has been removed for security reasons. ' +
            'Use launchBinary + launchArgs instead.');
    }
    throw new Error('Missing worker launch command. Provide launchBinary or launchCmd.');
}
export function buildWorkerStartCommand(config) {
    const shell = getDefaultShell();
    const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
    const launchWords = getLaunchWords(config);
    const shouldSourceRc = process.env.OMC_TEAM_NO_RC !== '1';
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
        const isFish = shellName === 'fish';
        const execArgsCommand = isFish ? 'exec $argv' : 'exec "$@"';
        // Use rcFile from launchSpec when shell matches; fall back to legacy derivation otherwise
        let rcFile = (launchSpec.shell === shell ? launchSpec.rcFile : null) ?? '';
        if (!rcFile && process.env.HOME) {
            rcFile = isFish
                ? `${process.env.HOME}/.config/fish/config.fish`
                : `${process.env.HOME}/.${shellName}rc`;
        }
        let script;
        if (isFish) {
            // Fish uses different syntax for conditionals and sourcing
            script = shouldSourceRc && rcFile
                ? `test -f ${shellEscape(rcFile)}; and source ${shellEscape(rcFile)}; ${execArgsCommand}`
                : execArgsCommand;
        }
        else {
            script = shouldSourceRc && rcFile
                ? `[ -f ${shellEscape(rcFile)} ] && . ${shellEscape(rcFile)}; ${execArgsCommand}`
                : execArgsCommand;
        }
        // Fish doesn't support combined -lc; use separate -l -c flags
        const shellFlags = isFish ? ['-l', '-c'] : ['-lc'];
        // envAssignments are already shell-escaped (KEY='value'), so they must
        // NOT go through shellEscape again — that would wrap them in a second
        // layer of quotes, causing `env` to receive literal quote characters
        // in the values (e.g. ANTHROPIC_MODEL="'us.anthropic...'" instead of
        // ANTHROPIC_MODEL="us.anthropic..."). Issue #1415.
        return [
            shellEscape('env'),
            ...envAssignments,
            ...[shell, ...shellFlags, script, '--', ...launchWords].map(shellEscape),
        ].join(' ');
    }
    const envString = Object.entries(config.envVars)
        .map(([k, v]) => {
        assertSafeEnvKey(k);
        return `${k}=${shellEscape(v)}`;
    })
        .join(' ');
    const shellName = shellNameFromPath(shell) || 'bash';
    const isFish = shellName === 'fish';
    // Use rcFile from launchSpec when shell matches; fall back to legacy derivation otherwise
    let rcFile = (launchSpec.shell === shell ? launchSpec.rcFile : null) ?? '';
    if (!rcFile && process.env.HOME) {
        rcFile = isFish
            ? `${process.env.HOME}/.config/fish/config.fish`
            : `${process.env.HOME}/.${shellName}rc`;
    }
    let sourceCmd = '';
    if (shouldSourceRc && rcFile) {
        sourceCmd = isFish
            ? `test -f "${rcFile}"; and source "${rcFile}"; `
            : `[ -f "${rcFile}" ] && source "${rcFile}"; `;
    }
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
            '  Arch: sudo pacman -S tmux\n' +
            '  Windows: winget install psmux');
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
        // Use shell execution for format strings containing #{} to prevent
        // MSYS2/Git Bash from stripping curly braces in execFileSync args.
        // All arguments here are hardcoded constants, not user input.
        const output = execSync("tmux list-sessions -F '#{session_name}'", {
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
export async function createTeamSession(teamName, workerCount, cwd, options = {}) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const multiplexerContext = detectTeamMultiplexerContext();
    const inTmux = multiplexerContext === 'tmux';
    const useDedicatedWindow = Boolean(options.newWindow && inTmux);
    // Prefer the invoking pane from environment to avoid focus races when users
    // switch tmux windows during startup (issue #966).
    const envPaneIdRaw = (process.env.TMUX_PANE ?? '').trim();
    const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : '';
    let sessionAndWindow = '';
    let leaderPaneId = envPaneId;
    let sessionMode = inTmux ? 'split-pane' : 'detached-session';
    if (!inTmux) {
        // Backward-compatible fallback: create an isolated detached tmux session
        // so workflows can run when launched outside an attached tmux client. This
        // also covers cmux, which exposes its own surface metadata without a tmux
        // pane/window that OMC can split directly.
        const detachedSessionName = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${Date.now().toString(36)}`;
        const detachedResult = await execFileAsync('tmux', [
            'new-session', '-d', '-P', '-F', '#S:0 #{pane_id}',
            '-s', detachedSessionName,
            '-c', cwd,
        ]);
        const detachedLine = detachedResult.stdout.trim();
        const detachedMatch = detachedLine.match(/^(\S+)\s+(%\d+)$/);
        if (!detachedMatch) {
            throw new Error(`Failed to create detached tmux session: "${detachedLine}"`);
        }
        sessionAndWindow = detachedMatch[1];
        leaderPaneId = detachedMatch[2];
    }
    if (inTmux && envPaneId) {
        try {
            const targetedContextResult = await execFileAsync('tmux', [
                'display-message', '-p', '-t', envPaneId, '#S:#I',
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
            'display-message', '-p', '#S:#I #{pane_id}',
        ]);
        const contextLine = contextResult.stdout.trim();
        const contextMatch = contextLine.match(/^(\S+)\s+(%\d+)$/);
        if (!contextMatch) {
            throw new Error(`Failed to resolve tmux context: "${contextLine}"`);
        }
        sessionAndWindow = contextMatch[1];
        leaderPaneId = contextMatch[2];
    }
    if (useDedicatedWindow) {
        const targetSession = sessionAndWindow.split(':')[0] ?? sessionAndWindow;
        const windowName = `omc-${sanitizeName(teamName)}`.slice(0, 32);
        const newWindowResult = await execFileAsync('tmux', [
            'new-window', '-d', '-P', '-F', '#S:#I #{pane_id}',
            '-t', targetSession,
            '-n', windowName,
            '-c', cwd,
        ]);
        const newWindowLine = newWindowResult.stdout.trim();
        const newWindowMatch = newWindowLine.match(/^(\S+)\s+(%\d+)$/);
        if (!newWindowMatch) {
            throw new Error(`Failed to create team tmux window: "${newWindowLine}"`);
        }
        sessionAndWindow = newWindowMatch[1];
        leaderPaneId = newWindowMatch[2];
        sessionMode = 'dedicated-window';
    }
    const teamTarget = sessionAndWindow; // "session:window" form
    const resolvedSessionName = teamTarget.split(':')[0];
    const workerPaneIds = [];
    if (workerCount <= 0) {
        try {
            await execFileAsync('tmux', ['set-option', '-t', resolvedSessionName, 'mouse', 'on']);
        }
        catch { /* ignore */ }
        if (sessionMode !== 'dedicated-window') {
            try {
                await execFileAsync('tmux', ['select-pane', '-t', leaderPaneId]);
            }
            catch { /* ignore */ }
        }
        await new Promise(r => setTimeout(r, 300));
        return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
    }
    // Create worker panes: first via horizontal split off leader, rest stacked vertically on right.
    for (let i = 0; i < workerCount; i++) {
        const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
        const splitType = i === 0 ? '-h' : '-v';
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
    await applyMainVerticalLayout(teamTarget);
    try {
        await execFileAsync('tmux', ['set-option', '-t', resolvedSessionName, 'mouse', 'on']);
    }
    catch { /* ignore */ }
    if (sessionMode !== 'dedicated-window') {
        try {
            await execFileAsync('tmux', ['select-pane', '-t', leaderPaneId]);
        }
        catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 300));
    return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
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
function paneIsBootstrapping(captured) {
    const lines = captured
        .split('\n')
        .map((line) => line.replace(/\r/g, '').trim())
        .filter((line) => line.length > 0);
    return lines.some((line) => /\b(loading|initializing|starting up)\b/i.test(line)
        || /\bmodel:\s*loading\b/i.test(line)
        || /\bconnecting\s+to\b/i.test(line));
}
export function paneHasActiveTask(captured) {
    const lines = captured.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
    const tail = lines.slice(-40);
    if (tail.some(l => /\b\d+\s+background terminal running\b/i.test(l)))
        return true;
    if (tail.some(l => /esc to interrupt/i.test(l)))
        return true;
    if (tail.some(l => /\bbackground terminal running\b/i.test(l)))
        return true;
    if (tail.some(l => /^[·✻]\s+[A-Za-z][A-Za-z0-9''-]*(?:\s+[A-Za-z][A-Za-z0-9''-]*){0,3}(?:…|\.{3})$/u.test(l)))
        return true;
    return false;
}
export function paneLooksReady(captured) {
    const content = captured.trimEnd();
    if (content === '')
        return false;
    const lines = content
        .split('\n')
        .map(line => line.replace(/\r/g, '').trimEnd())
        .filter(line => line.trim() !== '');
    if (lines.length === 0)
        return false;
    if (paneIsBootstrapping(content))
        return false;
    const lastLine = lines[lines.length - 1];
    if (/^\s*[›>❯]\s*/u.test(lastLine))
        return true;
    const hasCodexPromptLine = lines.some((line) => /^\s*›\s*/u.test(line));
    const hasClaudePromptLine = lines.some((line) => /^\s*❯\s*/u.test(line));
    return hasCodexPromptLine || hasClaudePromptLine;
}
export async function waitForPaneReady(paneId, opts = {}) {
    const envTimeout = Number.parseInt(process.env.OMC_SHELL_READY_TIMEOUT_MS ?? '', 10);
    const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
        ? Number(opts.timeoutMs)
        : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000);
    const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0
        ? Number(opts.pollIntervalMs)
        : 250;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const captured = await capturePaneAsync(paneId, promisifiedExecFile);
        if (paneLooksReady(captured) && !paneHasActiveTask(captured)) {
            return true;
        }
        await sleep(pollIntervalMs);
    }
    console.warn(`[tmux-session] waitForPaneReady: pane ${paneId} timed out after ${timeoutMs}ms ` +
        `(set OMC_SHELL_READY_TIMEOUT_MS to tune)`);
    return false;
}
function paneTailContainsLiteralLine(captured, text) {
    return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(text));
}
async function paneInCopyMode(paneId) {
    try {
        const result = await tmuxAsync(['display-message', '-t', paneId, '-p', '#{pane_in_mode}']);
        return result.stdout.trim() === '1';
    }
    catch {
        return false;
    }
}
export function shouldAttemptAdaptiveRetry(args) {
    if (process.env.OMC_TEAM_AUTO_INTERRUPT_RETRY === '0')
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
        console.warn(`[tmux-session] sendToWorker: message rejected (${message.length} chars exceeds 200 char limit)`);
        return false;
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
        if (await paneInCopyMode(paneId)) {
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
        if (await paneInCopyMode(paneId)) {
            return false;
        }
        // Adaptive fallback: for busy panes, retry once without interrupting active turns.
        const finalCapture = await capturePaneAsync(paneId, execFileAsync);
        const paneModeBeforeAdaptiveRetry = await paneInCopyMode(paneId);
        if (shouldAttemptAdaptiveRetry({
            paneBusy,
            latestCapture: finalCapture,
            message,
            paneInCopyMode: paneModeBeforeAdaptiveRetry,
            retriesAttempted: 0,
        })) {
            if (await paneInCopyMode(paneId)) {
                return false;
            }
            await sendKey('C-u');
            await sleep(80);
            if (await paneInCopyMode(paneId)) {
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
        if (await paneInCopyMode(paneId)) {
            return false;
        }
        // Fail-closed: one final submit attempt, then report failure so
        // callers can surface startup dispatch problems explicitly.
        await sendKey('C-m');
        await sleep(120);
        await sendKey('C-m');
        await sleep(140);
        const finalCheckCapture = await capturePaneAsync(paneId, execFileAsync);
        // Empty capture means tmux capture failed or returned indeterminate output.
        // Treat this as delivery failure to keep dispatch behavior fail-closed.
        if (!finalCheckCapture || finalCheckCapture.trim() === '') {
            return false;
        }
        return !paneTailContainsLiteralLine(finalCheckCapture, message);
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
        if (await paneInCopyMode(leaderPaneId)) {
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
        const aliveChecks = await Promise.all(paneIds.map(id => isWorkerAlive(id)));
        if (aliveChecks.some(alive => alive)) {
            await sleep(graceMs);
        }
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
function isPaneId(value) {
    return typeof value === 'string' && /^%\d+$/.test(value.trim());
}
function dedupeWorkerPaneIds(paneIds, leaderPaneId) {
    const unique = new Set();
    for (const paneId of paneIds) {
        if (!isPaneId(paneId))
            continue;
        const normalized = paneId.trim();
        if (normalized === leaderPaneId)
            continue;
        unique.add(normalized);
    }
    return [...unique];
}
export async function resolveSplitPaneWorkerPaneIds(sessionName, recordedPaneIds, leaderPaneId) {
    const resolved = dedupeWorkerPaneIds(recordedPaneIds ?? [], leaderPaneId);
    if (!sessionName.includes(':'))
        return resolved;
    try {
        const paneResult = await tmuxAsync(['list-panes', '-t', sessionName, '-F', '#{pane_id}']);
        return dedupeWorkerPaneIds([...resolved, ...paneResult.stdout.split('\n').map((paneId) => paneId.trim())], leaderPaneId);
    }
    catch {
        return resolved;
    }
}
/**
 * Kill the team tmux session or just the worker panes, depending on how the
 * team was created.
 *
 * - split-pane: kill only worker panes; preserve the leader pane and user window.
 * - dedicated-window: kill the owned tmux window.
 * - detached-session: kill the fully owned tmux session.
 */
export async function killTeamSession(sessionName, workerPaneIds, leaderPaneId, options = {}) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const sessionMode = options.sessionMode
        ?? (sessionName.includes(':') ? 'split-pane' : 'detached-session');
    if (sessionMode === 'split-pane') {
        if (!workerPaneIds?.length)
            return;
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
    if (sessionMode === 'dedicated-window') {
        try {
            await execFileAsync('tmux', ['kill-window', '-t', sessionName]);
        }
        catch {
            // Window may already be gone.
        }
        return;
    }
    const sessionTarget = sessionName.split(':')[0] ?? sessionName;
    if (process.env.OMC_TEAM_ALLOW_KILL_CURRENT_SESSION !== '1' && process.env.TMUX) {
        try {
            const current = await tmuxAsync(['display-message', '-p', '#S']);
            const currentSessionName = current.stdout.trim();
            if (currentSessionName && currentSessionName === sessionTarget) {
                return;
            }
        }
        catch {
            // If we cannot resolve current session safely, continue with best effort.
        }
    }
    try {
        await execFileAsync('tmux', ['kill-session', '-t', sessionTarget]);
    }
    catch {
        // Session may already be dead.
    }
}
//# sourceMappingURL=tmux-session.js.map
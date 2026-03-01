/**
 * tmux utility functions for omc native shell launch
 * Adapted from oh-my-codex patterns for omc
 */
import { execFileSync } from 'child_process';
import { basename } from 'path';
/**
 * Check if tmux is available on the system
 */
export function isTmuxAvailable() {
    try {
        execFileSync('tmux', ['-V'], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Check if claude CLI is available on the system
 */
export function isClaudeAvailable() {
    try {
        execFileSync('claude', ['--version'], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Resolve launch policy based on environment
 * - inside-tmux: Already in tmux session, split pane for HUD
 * - outside-tmux: Not in tmux, create new session
 * - direct: tmux not available, run directly
 */
export function resolveLaunchPolicy(env = process.env) {
    if (!isTmuxAvailable()) {
        return 'direct';
    }
    return env.TMUX ? 'inside-tmux' : 'outside-tmux';
}
/**
 * Build tmux session name from directory, git branch, and UTC timestamp
 * Format: omc-{dir}-{branch}-{utctimestamp}
 * e.g.  omc-myproject-dev-20260221143052
 */
export function buildTmuxSessionName(cwd) {
    const dirToken = sanitizeTmuxToken(basename(cwd));
    let branchToken = 'detached';
    try {
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (branch) {
            branchToken = sanitizeTmuxToken(branch);
        }
    }
    catch {
        // Non-git directory or git unavailable
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const utcTimestamp = `${now.getUTCFullYear()}` +
        `${pad(now.getUTCMonth() + 1)}` +
        `${pad(now.getUTCDate())}` +
        `${pad(now.getUTCHours())}` +
        `${pad(now.getUTCMinutes())}` +
        `${pad(now.getUTCSeconds())}`;
    const name = `omc-${dirToken}-${branchToken}-${utcTimestamp}`;
    return name.length > 120 ? name.slice(0, 120) : name;
}
/**
 * Sanitize string for use in tmux session/window names
 * Lowercase, alphanumeric + hyphens only
 */
export function sanitizeTmuxToken(value) {
    const cleaned = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || 'unknown';
}
/**
 * Build shell command string for tmux with proper quoting
 */
export function buildTmuxShellCommand(command, args) {
    return [quoteShellArg(command), ...args.map(quoteShellArg)].join(' ');
}
/**
 * Wrap a command string in the user's login shell with RC file sourcing.
 * Ensures PATH and other environment setup from .bashrc/.zshrc is available
 * when tmux spawns new sessions or panes with a command argument.
 *
 * tmux new-session / split-window run commands via a non-login, non-interactive
 * shell, so tools installed via nvm, pyenv, conda, etc. are invisible.
 * This wrapper starts a login shell (`-lc`) and explicitly sources the RC file.
 */
export function wrapWithLoginShell(command) {
    const shell = process.env.SHELL || '/bin/bash';
    const shellName = basename(shell).replace(/\.(exe|cmd|bat)$/i, '');
    const rcFile = process.env.HOME ? `${process.env.HOME}/.${shellName}rc` : '';
    const sourcePrefix = rcFile
        ? `[ -f ${quoteShellArg(rcFile)} ] && . ${quoteShellArg(rcFile)}; `
        : '';
    return `exec ${quoteShellArg(shell)} -lc ${quoteShellArg(`${sourcePrefix}${command}`)}`;
}
/**
 * Quote shell argument for safe shell execution
 * Uses single quotes with proper escaping
 */
export function quoteShellArg(value) {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
/**
 * Parse tmux pane list output into structured data
 */
export function parseTmuxPaneSnapshot(output) {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
        const [paneId = '', currentCommand = '', ...startCommandParts] = line.split('\t');
        return {
            paneId: paneId.trim(),
            currentCommand: currentCommand.trim(),
            startCommand: startCommandParts.join('\t').trim(),
        };
    })
        .filter((pane) => pane.paneId.startsWith('%'));
}
/**
 * Check if pane is running a HUD watch command
 */
export function isHudWatchPane(pane) {
    const command = `${pane.startCommand} ${pane.currentCommand}`.toLowerCase();
    return /\bhud\b/.test(command)
        && /--watch\b/.test(command)
        && (/\bomc(?:\.js)?\b/.test(command) || /\bnode\b/.test(command));
}
/**
 * Find HUD watch pane IDs in current window
 */
export function findHudWatchPaneIds(panes, currentPaneId) {
    return panes
        .filter((pane) => pane.paneId !== currentPaneId)
        .filter((pane) => isHudWatchPane(pane))
        .map((pane) => pane.paneId);
}
/**
 * List HUD watch panes in current tmux window
 */
export function listHudWatchPaneIdsInCurrentWindow(currentPaneId) {
    try {
        const output = execFileSync('tmux', ['list-panes', '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}'], { encoding: 'utf-8' });
        return findHudWatchPaneIds(parseTmuxPaneSnapshot(output), currentPaneId);
    }
    catch {
        return [];
    }
}
/**
 * Create HUD watch pane in current window
 * Returns pane ID or null on failure
 */
export function createHudWatchPane(cwd, hudCmd) {
    try {
        const wrappedCmd = wrapWithLoginShell(hudCmd);
        const output = execFileSync('tmux', ['split-window', '-v', '-l', '4', '-d', '-c', cwd, '-P', '-F', '#{pane_id}', wrappedCmd], { encoding: 'utf-8' });
        const paneId = output.split('\n')[0]?.trim() || '';
        return paneId.startsWith('%') ? paneId : null;
    }
    catch {
        return null;
    }
}
/**
 * Kill tmux pane by ID
 */
export function killTmuxPane(paneId) {
    if (!paneId.startsWith('%'))
        return;
    try {
        execFileSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'ignore' });
    }
    catch {
        // Pane may already be gone; ignore
    }
}
//# sourceMappingURL=tmux-utils.js.map
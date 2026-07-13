// src/team/tmux-session.ts
/**
 * Tmux Session Management for MCP Team Bridge
 *
 * Create, kill, list, and manage tmux sessions for MCP worker bridge daemons.
 * Sessions are named "omc-team-{teamName}-{workerName}".
 */
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, basename, isAbsolute, win32 } from 'path';
import fs from 'fs/promises';
import { validateTeamName } from './team-name.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { tmuxExec, tmuxExecAsync, tmuxShell, tmuxCmdAsync } from '../cli/tmux-utils.js';
import { configureTmuxClipboardForSession, configureTmuxClipboardForSessionAsync } from '../cli/tmux-clipboard.js';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const execFileAsync = promisify(execFile);
const TMUX_SESSION_PREFIX = 'omc-team';
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
export async function applyMainVerticalLayout(teamTarget) {
    try {
        await tmuxExecAsync(['select-layout', '-t', teamTarget, 'main-vertical']);
    }
    catch {
        // Layout may not apply if only 1 pane; ignore.
    }
    try {
        const widthResult = await tmuxCmdAsync([
            'display-message', '-p', '-t', teamTarget, '#{window_width}',
        ]);
        const width = parseInt(widthResult.stdout.trim(), 10);
        if (Number.isFinite(width) && width >= 40) {
            const half = String(Math.floor(width / 2));
            await tmuxExecAsync(['set-window-option', '-t', teamTarget, 'main-pane-width', half]);
            await tmuxExecAsync(['select-layout', '-t', teamTarget, 'main-vertical']);
        }
    }
    catch {
        /* ignore layout sizing errors */
    }
}
function isCmuxContext() {
    return detectTeamMultiplexerContext() === 'cmux';
}
function isCmuxSurfaceTarget(value) {
    return isCmuxContext() && typeof value === 'string' && value.trim().length > 0 && !value.trim().startsWith('%');
}
async function cmuxExecAsync(args) {
    const result = await execFileAsync('cmux', args, { encoding: 'utf-8' });
    return {
        stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? ''),
        stderr: typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? ''),
    };
}
function getCmuxErrorText(error) {
    if (error instanceof Error) {
        const stderr = typeof error.stderr === 'string'
            ? error.stderr
            : '';
        return `${error.message}\n${stderr}`.trim();
    }
    return String(error);
}
function isCmuxDialectFailure(error) {
    const text = getCmuxErrorText(error);
    return /(?:unknown|unrecognized|invalid|unsupported) (?:command|subcommand|option)|no such (?:command|subcommand)|Found argument .*--surface.*wasn't expected|unexpected argument|unexpected option/i.test(text);
}
function redactCmuxFailureMessage(error, argLists) {
    let message = getCmuxErrorText(error);
    const commandNames = new Set(argLists.map(args => args[0]).filter(Boolean));
    const sensitiveArgs = [...new Set(argLists.flatMap(args => args).flatMap(arg => {
            if (!arg || commandNames.has(arg))
                return [];
            const fragments = arg.match(/[A-Za-z0-9_./:@=-]{4,}/g) ?? [];
            return [arg, ...fragments];
        }))].sort((a, b) => b.length - a.length);
    for (const arg of sensitiveArgs) {
        message = message.split(arg).join('[redacted]');
    }
    return message;
}
async function cmuxExecPrimaryWithLegacyFallback(primaryArgs, legacyArgs) {
    try {
        return await cmuxExecAsync(primaryArgs);
    }
    catch (primaryError) {
        if (!isCmuxDialectFailure(primaryError)) {
            const primaryMessage = redactCmuxFailureMessage(primaryError, [primaryArgs]);
            const error = new Error(`cmux command failed for current form: current=${primaryArgs[0] ?? '<unknown>'} (${primaryMessage})`);
            error.cause = primaryError;
            throw error;
        }
        try {
            return await cmuxExecAsync(legacyArgs);
        }
        catch (legacyError) {
            const primaryMessage = redactCmuxFailureMessage(primaryError, [primaryArgs, legacyArgs]);
            const legacyMessage = redactCmuxFailureMessage(legacyError, [primaryArgs, legacyArgs]);
            throw new Error(`cmux command failed for both current and legacy forms: current=${primaryArgs[0] ?? '<unknown>'} (${primaryMessage}); ` +
                `legacy=${legacyArgs[0] ?? '<unknown>'} (${legacyMessage})`);
        }
    }
}
function parseCmuxSurfaceId(output) {
    const trimmed = output.trim();
    const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch)
        return uuidMatch[0];
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const token = tokens[0] === 'OK' ? tokens[1] : tokens[0];
    if (!token)
        throw new Error(`Failed to resolve cmux surface id: "${trimmed}"`);
    return token;
}
async function cmuxSplitSurface(targetSurfaceId, direction, _cwd) {
    const args = ['new-split', direction, '--surface', targetSurfaceId];
    if (process.env.CMUX_WORKSPACE_ID)
        args.push('--workspace', process.env.CMUX_WORKSPACE_ID);
    const result = await cmuxExecAsync(args);
    let paneId = null;
    try {
        paneId = parseCmuxSurfaceId(result.stdout);
    }
    catch { /* successful split with unparseable identity */ }
    return { ...result, paneId };
}
async function cmuxSendSurface(surfaceId, text) {
    // cmux 0.64.x targets a specific surface with the dedicated
    // `send-surface` subcommand. `cmux send --surface ...` is parsed as the
    // focused-surface form plus an unknown option in current cmux builds, which
    // makes worker startup fail after the split/worktree has already been
    // created. The top-level `omc team` catch then prints generic usage and the
    // startup rollback tears the empty worktree down. (#3325)
    await cmuxExecPrimaryWithLegacyFallback(['send-surface', '--surface', surfaceId, text], ['send', '--surface', surfaceId, text]);
}
function normalizeCmuxKey(key) {
    const normalized = key.trim();
    const lower = normalized.toLowerCase();
    switch (lower) {
        case 'enter':
        case 'return':
        case 'tab':
        case 'escape':
        case 'esc':
        case 'backspace':
        case 'delete':
        case 'up':
        case 'down':
        case 'left':
        case 'right':
            return lower === 'return' ? 'enter' : lower === 'esc' ? 'escape' : lower;
        default:
            return normalized;
    }
}
async function cmuxSendSurfaceKey(surfaceId, key) {
    // See cmuxSendSurface(): targeting a surface uses `send-key-surface`, not a
    // `--surface` option on `send-key`. Key names are lower-case in the cmux CLI
    // reference; normalize common names while leaving advanced chord strings alone.
    const normalizedKey = normalizeCmuxKey(key);
    await cmuxExecPrimaryWithLegacyFallback(['send-key-surface', '--surface', surfaceId, normalizedKey], ['send-key', '--surface', surfaceId, key]);
}
async function cmuxCaptureSurface(surfaceId) {
    const result = await cmuxExecPrimaryWithLegacyFallback(['read-screen', '--surface', surfaceId], ['capture-pane', '--surface', surfaceId, '--scrollback']);
    return result.stdout;
}
async function cmuxCloseSurface(surfaceId) {
    await cmuxExecAsync(['close-surface', '--surface', surfaceId]);
}
const TMUX_MAILBOX_PANE_ID = /^%\d+$/;
const TMUX_MAILBOX_TARGET = /^[^\s:]+(?::[^\s:]+)?$/;
function isExactOpaqueCmuxIdentifier(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f\s]/.test(value);
}
function parseCmuxResourceIds(output, collectionName) {
    let parsed;
    try {
        parsed = JSON.parse(output);
    }
    catch {
        return null;
    }
    const entries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray(parsed[collectionName])
            ? parsed[collectionName]
            : null;
    if (!entries)
        return null;
    const ids = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return null;
        const id = entry.id;
        if (!isExactOpaqueCmuxIdentifier(id))
            return null;
        if (!ids.includes(id))
            ids.push(id);
    }
    return ids;
}
const defaultMailboxTargetOwnershipDependencies = {
    tmuxExec: (args) => tmuxExecAsync(args),
    cmuxExec: cmuxExecAsync,
};
/**
 * Proves that a configured direct-mailbox target still belongs to its exact
 * provider target. This performs read-only provider queries and never touches
 * a candidate pane/surface.
 */
export async function verifyTeamTargetOwnership(target, dependencies = defaultMailboxTargetOwnershipDependencies) {
    const expectedProvider = target.providerTarget.startsWith('cmux:') ? 'cmux' : 'tmux';
    if (target.provider !== expectedProvider)
        return { kind: 'provider_mismatch' };
    if (target.provider === 'tmux') {
        if (typeof target.providerTarget !== 'string'
            || target.providerTarget.length === 0
            || target.providerTarget !== target.providerTarget.trim()
            || !TMUX_MAILBOX_TARGET.test(target.providerTarget)
            || !TMUX_MAILBOX_PANE_ID.test(target.paneId)) {
            return { kind: 'unavailable' };
        }
        try {
            const result = await dependencies.tmuxExec([
                'list-panes', '-t', target.providerTarget, '-F', '#{pane_id}',
            ]);
            const paneIds = [];
            for (const line of result.stdout.split(/\r?\n/)) {
                const paneId = line.trim();
                if (!paneId)
                    continue;
                if (!TMUX_MAILBOX_PANE_ID.test(paneId))
                    return { kind: 'unavailable' };
                if (!paneIds.includes(paneId))
                    paneIds.push(paneId);
            }
            if (paneIds.length === 0)
                return { kind: 'unavailable' };
            return paneIds.includes(target.paneId)
                ? { kind: 'owned', provider: 'tmux', providerTarget: target.providerTarget, paneId: target.paneId }
                : { kind: 'foreign' };
        }
        catch {
            return { kind: 'unavailable' };
        }
    }
    const workspace = target.providerTarget.slice('cmux:'.length);
    if (!isExactOpaqueCmuxIdentifier(workspace)
        || !isExactOpaqueCmuxIdentifier(target.paneId)
        || TMUX_MAILBOX_PANE_ID.test(target.paneId)) {
        return { kind: 'unavailable' };
    }
    try {
        const panes = parseCmuxResourceIds((await dependencies.cmuxExec(['--json', 'list-panes', '--workspace', workspace])).stdout, 'panes');
        if (!panes || panes.length === 0)
            return { kind: 'unavailable' };
        for (const pane of panes) {
            const surfaces = parseCmuxResourceIds((await dependencies.cmuxExec([
                '--json', 'list-pane-surfaces', '--workspace', workspace, '--pane', pane,
            ])).stdout, 'surfaces');
            if (!surfaces)
                return { kind: 'unavailable' };
            if (surfaces.includes(target.paneId)) {
                return {
                    kind: 'owned',
                    provider: 'cmux',
                    providerTarget: target.providerTarget,
                    paneId: target.paneId,
                };
            }
        }
        return { kind: 'foreign' };
    }
    catch {
        return { kind: 'unavailable' };
    }
}
const defaultDirectMailboxEffectDependencies = {
    sendWorker: sendToWorker,
    sendLeader: injectToLeaderPane,
};
/**
 * Direct-mailbox-only adapter. Once the public boolean transport has been
 * called, a false result or exception is conservatively treated as uncertain.
 */
export async function invokeDirectMailboxEffect(target, message, dependencies = defaultDirectMailboxEffectDependencies) {
    if (!target.paneId || !message)
        return { kind: 'not_attempted', reason: 'mailbox_target_missing' };
    if (target.provider === 'cmux' && !isCmuxContext()) {
        return { kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' };
    }
    try {
        const notified = target.recipientRole === 'leader'
            ? await dependencies.sendLeader(target.providerTarget, target.paneId, message)
            : await dependencies.sendWorker(target.providerTarget, target.paneId, message);
        return notified
            ? {
                kind: 'confirmed',
                transport: 'tmux_send_keys',
                reason: target.recipientRole === 'leader' ? 'leader_pane_notified' : 'worker_pane_notified',
            }
            : {
                kind: 'attempted_unconfirmed',
                transport: 'tmux_send_keys',
                reason: 'notification_delivery_uncertain',
                cause: 'returned_false',
            };
    }
    catch {
        return {
            kind: 'attempted_unconfirmed',
            transport: 'tmux_send_keys',
            reason: 'notification_delivery_uncertain',
            cause: 'threw',
        };
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
function commandFingerprint(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
function redactWorkerStartCommandForLog(command) {
    return command
        // POSIX env assignments in the generated launch command.
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*)='[^']*'/g, "$1='<redacted>'")
        // Windows cmd env assignments.
        .replace(/set "([A-Za-z_][A-Za-z0-9_]*)=[^"]*"/g, 'set "$1=<redacted>"')
        // PowerShell env assignments.
        .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)='[^']*'/g, "$env:$1='<redacted>'")
        // Sensitive CLI flags that may appear in launchArgs.
        .replace(/(--?[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|password|credential|auth)[A-Za-z0-9_-]*)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1=<redacted>');
}
function workerStartCommandPreview(command, maxLength = 180) {
    const redacted = redactWorkerStartCommandForLog(command).replace(/\s+/g, ' ').trim();
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
function logWorkerSpawnDiagnostic(message) {
    process.stderr.write(`[team/tmux-session] ${message}\n`);
}
function paneCurrentCommandLooksReady(command) {
    const normalized = basename(command.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    return SUPPORTED_POSIX_SHELLS.has(normalized)
        || ['cmd', 'powershell', 'pwsh', 'nu', 'elvish'].includes(normalized);
}
async function getPaneCurrentCommandStatus(paneId) {
    try {
        const result = await tmuxCmdAsync([
            'display-message', '-p', '-t', paneId,
            '#{pane_dead} #{pane_current_command}',
        ], { timeout: 1000 });
        const status = result.stdout.trim();
        const [dead, ...commandParts] = status.split(/\s+/);
        return { dead: dead === '1', command: commandParts.join(' ') };
    }
    catch {
        return null;
    }
}
function paneCurrentCommandLooksSubmitted(command) {
    return command.length > 0 && !paneCurrentCommandLooksReady(command);
}
async function waitForShellReady(paneId, opts = {}) {
    if (isCmuxSurfaceTarget(paneId))
        return true;
    const envTimeout = Number.parseInt(process.env.OMC_TEAM_SHELL_READY_TIMEOUT_MS ?? '', 10);
    const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
        ? Number(opts.timeoutMs)
        : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5_000);
    const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0
        ? Number(opts.pollIntervalMs)
        : 50;
    const deadline = Date.now() + timeoutMs;
    let lastStatus = '';
    while (Date.now() < deadline) {
        const status = await getPaneCurrentCommandStatus(paneId);
        if (status) {
            lastStatus = `${status.dead ? '1' : '0'} ${status.command}`.trim();
            if (status.dead)
                return false;
            if (paneCurrentCommandLooksReady(status.command)) {
                return true;
            }
        }
        await sleep(pollIntervalMs);
    }
    logWorkerSpawnDiagnostic(`worker shell readiness timed out pane=${paneId} timeoutMs=${timeoutMs} lastStatus=${JSON.stringify(lastStatus)}`);
    return false;
}
async function verifyWorkerStartCommandDelivered(paneId, startCmd) {
    if (isCmuxSurfaceTarget(paneId))
        return true;
    const expected = normalizeTmuxCapture(startCmd);
    const compactExpected = normalizeTmuxCaptureForDelivery(startCmd);
    for (let attempt = 1; attempt <= 5; attempt++) {
        const captured = await capturePaneAsync(paneId, { joinWrappedLines: true });
        const normalizedCaptured = normalizeTmuxCapture(captured);
        if (normalizedCaptured.includes(expected)) {
            return true;
        }
        if (compactExpected.length > 0 && normalizeTmuxCaptureForDelivery(captured).includes(compactExpected)) {
            return true;
        }
        await sleep(50);
    }
    return false;
}
function resolvePositiveIntegerEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
async function verifyWorkerStartCommandSubmitted(paneId, startCmd, opts = {}) {
    if (isCmuxSurfaceTarget(paneId))
        return true;
    const expected = normalizeTmuxCapture(startCmd);
    const compactExpected = normalizeTmuxCaptureForDelivery(startCmd);
    const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
        ? Number(opts.timeoutMs)
        : resolvePositiveIntegerEnv('OMC_TEAM_START_SUBMIT_TIMEOUT_MS', 8_000);
    const maxPollIntervalMs = Number.isFinite(opts.maxPollIntervalMs) && (opts.maxPollIntervalMs ?? 0) > 0
        ? Number(opts.maxPollIntervalMs)
        : 500;
    let pollIntervalMs = Number.isFinite(opts.initialPollIntervalMs) && (opts.initialPollIntervalMs ?? 0) > 0
        ? Number(opts.initialPollIntervalMs)
        : 50;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const captured = await capturePaneAsync(paneId, { joinWrappedLines: true });
        const normalizedCaptured = normalizeTmuxCapture(captured);
        const commandStillBuffered = normalizedCaptured.includes(expected)
            || (compactExpected.length > 0 && normalizeTmuxCaptureForDelivery(captured).includes(compactExpected));
        if (!commandStillBuffered) {
            return true;
        }
        const status = await getPaneCurrentCommandStatus(paneId);
        if (status?.dead) {
            return false;
        }
        if (status && paneCurrentCommandLooksSubmitted(status.command)) {
            return true;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
            break;
        await sleep(Math.min(pollIntervalMs, remainingMs));
        pollIntervalMs = Math.min(Math.max(pollIntervalMs * 2, pollIntervalMs + 1), maxPollIntervalMs);
    }
    return false;
}
function workerPaneShellCommand() {
    if (process.platform === 'win32' && !isUnixLikeOnWindows()) {
        return [getDefaultShell()];
    }
    return [];
}
function escapeForCmdSet(value) {
    return value.replace(/(["%])/g, '$1$1');
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
export function validateTmux(hasTmuxContext = false) {
    if (hasTmuxContext) {
        return;
    }
    try {
        tmuxShell('-V', { stripTmux: true, timeout: 5000, stdio: 'pipe' });
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
        tmuxExec(['kill-session', '-t', name], { stripTmux: true, stdio: 'pipe', timeout: 5000 });
    }
    catch { /* ignore — session may not exist */ }
    // Create detached session with reasonable terminal size
    const args = ['new-session', '-d', '-s', name, '-x', '200', '-y', '50'];
    if (workingDirectory) {
        args.push('-c', workingDirectory);
    }
    args.push(...workerPaneShellCommand());
    tmuxExec(args, { stripTmux: true, stdio: 'pipe', timeout: 5000 });
    try {
        configureTmuxClipboardForSession(name, { stripTmux: true, stdio: 'pipe', timeout: 5000 });
    }
    catch { /* non-fatal — older tmux builds may not support these options */ }
    return name;
}
/** @deprecated Use killTeamSession() instead */
/** Kill a session by team/worker name. No-op if not found. */
export function killSession(teamName, workerName) {
    const name = sessionName(teamName, workerName);
    try {
        tmuxExec(['kill-session', '-t', name], { stripTmux: true, stdio: 'pipe', timeout: 5000 });
    }
    catch { /* ignore — session may not exist */ }
}
/** @deprecated Use isWorkerAlive() with pane ID instead */
/** Check if a session exists */
export function isSessionAlive(teamName, workerName) {
    const name = sessionName(teamName, workerName);
    try {
        tmuxExec(['has-session', '-t', name], { stripTmux: true, stdio: 'pipe', timeout: 5000 });
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
        const output = tmuxShell("list-sessions -F '#{session_name}'", {
            timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
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
 *   <current-js-runtime> dist/team/bridge-entry.js --config /tmp/omc-bridge-{worker}.json
 */
function quoteBridgeShellArg(value) {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
export function spawnBridgeInSession(tmuxSession, bridgeScriptPath, configFilePath) {
    const cmd = [process.execPath, bridgeScriptPath, '--config', configFilePath]
        .map(quoteBridgeShellArg)
        .join(' ');
    tmuxExec(['send-keys', '-t', tmuxSession, cmd, 'Enter'], { stripTmux: true, stdio: 'pipe', timeout: 5000 });
}
export async function splitTeamWorkerPaneWithEvidence(splitTarget, direction, cwd) {
    const provider = isCmuxContext() ? 'cmux' : 'tmux';
    try {
        if (provider === 'cmux') {
            const splitResult = await cmuxSplitSurface(splitTarget, direction, cwd);
            return { commandSucceeded: true, provider, splitTarget, direction, rawOutput: splitResult.stdout,
                stderr: splitResult.stderr, paneId: splitResult.paneId };
        }
        const splitType = direction === 'right' ? '-h' : '-v';
        const splitResult = await tmuxExecAsync([
            'split-window', splitType, '-t', splitTarget,
            '-d', '-P', '-F', '#{pane_id}',
            '-c', cwd,
            ...workerPaneShellCommand(),
        ]);
        const rawOutput = splitResult.stdout;
        const candidate = rawOutput.split('\n')[0]?.trim() ?? '';
        return { commandSucceeded: true, provider, splitTarget, direction, rawOutput, stderr: splitResult.stderr,
            paneId: /^%\d+$/.test(candidate) ? candidate : null };
    }
    catch (error) {
        const failure = error;
        return { commandSucceeded: false, provider, splitTarget, direction,
            rawOutput: typeof failure.stdout === 'string' ? failure.stdout : '',
            stderr: typeof failure.stderr === 'string' ? failure.stderr
                : typeof failure.message === 'string' ? failure.message : String(error),
            paneId: null };
    }
}
export async function splitTeamWorkerPane(splitTarget, direction, cwd) {
    return (await splitTeamWorkerPaneWithEvidence(splitTarget, direction, cwd)).paneId;
}
export async function createTeamSession(teamName, workerCount, cwd, options = {}) {
    const multiplexerContext = detectTeamMultiplexerContext();
    const inTmux = multiplexerContext === 'tmux';
    const inCmux = multiplexerContext === 'cmux';
    const useDedicatedWindow = Boolean(options.newWindow && inTmux);
    if (multiplexerContext === 'none') {
        validateTmux();
    }
    // Prefer the invoking pane from environment to avoid focus races when users
    // switch tmux windows during startup (issue #966).
    const envPaneIdRaw = (process.env.TMUX_PANE ?? '').trim();
    const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : '';
    let sessionAndWindow = '';
    let leaderPaneId = envPaneId;
    let sessionMode = inTmux ? 'split-pane' : 'detached-session';
    if (inCmux) {
        const cmuxLeaderSurface = (process.env.CMUX_SURFACE_ID ?? '').trim();
        if (!cmuxLeaderSurface) {
            throw new Error('CMUX_SURFACE_ID is required to create a cmux team session');
        }
        sessionAndWindow = `cmux:${process.env.CMUX_WORKSPACE_ID || 'workspace'}`;
        leaderPaneId = cmuxLeaderSurface;
        sessionMode = 'split-pane';
    }
    else if (!inTmux) {
        // Backward-compatible fallback: create an isolated detached tmux session
        // so workflows can run when launched outside any multiplexer.
        const detachedSessionName = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${Date.now().toString(36)}`;
        const detachedResult = await tmuxExecAsync([
            'new-session', '-d', '-P', '-F', '#S:0 #{pane_id}',
            '-s', detachedSessionName,
            '-c', cwd,
            ...workerPaneShellCommand(),
        ], { stripTmux: true });
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
            const targetedContextResult = await tmuxExecAsync([
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
        const contextResult = await tmuxCmdAsync([
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
        const newWindowResult = await tmuxExecAsync([
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
    const teamTarget = sessionAndWindow; // "session:window" or "cmux:workspace" form
    const resolvedSessionName = teamTarget.split(':')[0];
    if (!inCmux) {
        try {
            await configureTmuxClipboardForSessionAsync(resolvedSessionName);
        }
        catch {
            // Clipboard setup is best-effort so older tmux builds do not block team launch.
        }
    }
    const workerPaneIds = [];
    if (workerCount <= 0) {
        if (!inCmux) {
            try {
                await tmuxExecAsync(['set-option', '-t', resolvedSessionName, 'mouse', 'on']);
            }
            catch { /* ignore */ }
            if (sessionMode !== 'dedicated-window') {
                try {
                    await tmuxExecAsync(['select-pane', '-t', leaderPaneId]);
                }
                catch { /* ignore */ }
            }
        }
        return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
    }
    // Create worker panes: first via horizontal split off leader, rest stacked vertically on right.
    for (let i = 0; i < workerCount; i++) {
        const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
        if (inCmux) {
            const direction = i === 0 ? 'right' : 'down';
            const split = await cmuxSplitSurface(splitTarget, direction, cwd);
            if (!split.paneId)
                throw new Error(`Failed to resolve cmux surface id: ${JSON.stringify(split.stdout.trim())}`);
            workerPaneIds.push(split.paneId);
            continue;
        }
        const splitType = i === 0 ? '-h' : '-v';
        const splitResult = await tmuxCmdAsync([
            'split-window', splitType, '-t', splitTarget,
            '-d', '-P', '-F', '#{pane_id}',
            '-c', cwd,
            ...workerPaneShellCommand(),
        ]);
        const paneId = splitResult.stdout.split('\n')[0]?.trim();
        if (paneId) {
            workerPaneIds.push(paneId);
        }
    }
    if (!inCmux) {
        await applyMainVerticalLayout(teamTarget);
        try {
            await tmuxExecAsync(['set-option', '-t', resolvedSessionName, 'mouse', 'on']);
        }
        catch { /* ignore */ }
        if (sessionMode !== 'dedicated-window') {
            try {
                await tmuxExecAsync(['select-pane', '-t', leaderPaneId]);
            }
            catch { /* ignore */ }
        }
    }
    await Promise.all(workerPaneIds.map((workerPaneId) => waitForShellReady(workerPaneId, { timeoutMs: 5_000 })));
    return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
}
/**
 * Spawn a CLI agent in a specific pane.

 * Worker startup: env OMC_TEAM_WORKER={teamName}/workerName shell -lc "exec agentCmd"
 */
export async function spawnWorkerInPane(sessionName, paneId, config) {
    validateTeamName(config.teamName);
    const startCmd = buildWorkerStartCommand(config);
    const fingerprint = commandFingerprint(startCmd);
    const preview = workerStartCommandPreview(startCmd);
    logWorkerSpawnDiagnostic(`worker start delivery begin session=${sessionName} pane=${paneId} ` +
        `worker=${config.workerName} cmdSha=${fingerprint} cmdPreview=${JSON.stringify(preview)}`);
    if (isCmuxSurfaceTarget(paneId)) {
        try {
            await cmuxSendSurface(paneId, startCmd);
            await cmuxSendSurfaceKey(paneId, 'Enter');
            logWorkerSpawnDiagnostic(`worker start delivery sent session=${sessionName} pane=${paneId} ` +
                `worker=${config.workerName} cmdSha=${fingerprint} sendStatus=0`);
            return;
        }
        catch (error) {
            logWorkerSpawnDiagnostic(`worker start delivery failed session=${sessionName} pane=${paneId} ` +
                `worker=${config.workerName} cmdSha=${fingerprint} sendStatus=1 error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
            throw error;
        }
    }
    const shellReady = await waitForShellReady(paneId);
    if (!shellReady) {
        const reason = `worker_start_shell_not_ready:${config.workerName}:${paneId}:${fingerprint}`;
        logWorkerSpawnDiagnostic(`worker start delivery failed session=${sessionName} pane=${paneId} ` +
            `worker=${config.workerName} cmdSha=${fingerprint} sendStatus=not_attempted reason=shell_not_ready`);
        throw new Error(reason);
    }
    try {
        // Use -l (literal) flag to prevent tmux key-name parsing of the command string.
        const sendResult = await tmuxExecAsync([
            'send-keys', '-t', paneId, '-l', startCmd
        ], { timeout: 5000 });
        logWorkerSpawnDiagnostic(`worker start send-keys literal session=${sessionName} pane=${paneId} ` +
            `worker=${config.workerName} cmdSha=${fingerprint} sendStatus=0 stderr=${JSON.stringify(sendResult.stderr.trim())}`);
    }
    catch (error) {
        logWorkerSpawnDiagnostic(`worker start send-keys literal failed session=${sessionName} pane=${paneId} ` +
            `worker=${config.workerName} cmdSha=${fingerprint} sendStatus=1 error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
        throw error;
    }
    const delivered = await verifyWorkerStartCommandDelivered(paneId, startCmd);
    if (!delivered) {
        const reason = `worker_start_delivery_unverified:${config.workerName}:${paneId}:${fingerprint}`;
        logWorkerSpawnDiagnostic(`worker start delivery verification failed session=${sessionName} pane=${paneId} ` +
            `worker=${config.workerName} cmdSha=${fingerprint} cmdPreview=${JSON.stringify(preview)}`);
        throw new Error(reason);
    }
    try {
        const enterResult = await tmuxExecAsync(['send-keys', '-t', paneId, 'Enter'], { timeout: 5000 });
        logWorkerSpawnDiagnostic(`worker start submit key sent session=${sessionName} pane=${paneId} ` +
            `worker=${config.workerName} cmdSha=${fingerprint} sendStatus=0 stderr=${JSON.stringify(enterResult.stderr.trim())}`);
        const submitted = await verifyWorkerStartCommandSubmitted(paneId, startCmd);
        if (!submitted) {
            const reason = `worker_start_submit_unverified:${config.workerName}:${paneId}:${fingerprint}`;
            logWorkerSpawnDiagnostic(`worker start submit verification failed session=${sessionName} pane=${paneId} ` +
                `worker=${config.workerName} cmdSha=${fingerprint} cmdPreview=${JSON.stringify(preview)}`);
            throw new Error(reason);
        }
    }
    catch (error) {
        logWorkerSpawnDiagnostic(`worker start submit failed session=${sessionName} pane=${paneId} ` +
            `worker=${config.workerName} cmdSha=${fingerprint} sendStatus=1 error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
        throw error;
    }
}
function normalizeTmuxCapture(value) {
    return value.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeTmuxCaptureForDelivery(value) {
    return value.replace(/\r/g, '').replace(/\s+/g, '');
}
async function capturePaneAsync(paneId, opts = {}) {
    try {
        if (isCmuxSurfaceTarget(paneId)) {
            return await cmuxCaptureSurface(paneId);
        }
        const args = opts.joinWrappedLines
            ? ['capture-pane', '-J', '-t', paneId, '-p', '-S', '-80']
            : ['capture-pane', '-t', paneId, '-p', '-S', '-80'];
        const result = await tmuxExecAsync(args);
        return result.stdout;
    }
    catch {
        return '';
    }
}
export async function captureTeamPane(paneId) {
    return capturePaneAsync(paneId);
}
export async function sendTeamPaneKey(paneId, key) {
    if (isCmuxSurfaceTarget(paneId)) {
        await cmuxSendSurfaceKey(paneId, key);
        return;
    }
    await tmuxExecAsync(['send-keys', '-t', paneId, key]);
}
export async function killTeamPane(paneId) {
    if (isCmuxSurfaceTarget(paneId)) {
        await cmuxCloseSurface(paneId);
        return;
    }
    await tmuxExecAsync(['kill-pane', '-t', paneId]);
}
function detectPaneTrustPromptKind(captured) {
    const lines = captured.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
    const tail = lines.slice(-12);
    const hasDirectoryQuestion = tail.some(l => /Do you trust the contents of this directory\?/i.test(l));
    const hasDirectoryChoices = tail.some(l => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(l));
    if (hasDirectoryQuestion && hasDirectoryChoices)
        return 'directory';
    const hasHookReview = tail.some(l => /Hooks need review/i.test(l));
    const hasHookTrustChoice = tail.some(l => /Continue without trusting/i.test(l));
    const hasHookConfirm = tail.some(l => /Press enter to confirm or esc to go back/i.test(l));
    if (hasHookReview && hasHookTrustChoice && hasHookConfirm)
        return 'codex_hooks';
    return null;
}
export function paneHasTrustPrompt(captured) {
    return detectPaneTrustPromptKind(captured) !== null;
}
function paneHasClaudeStartupBanner(captured) {
    const lines = captured
        .split('\n')
        .map((line) => line.replace(/\r/g, '').trim())
        .filter((line) => line.length > 0)
        .slice(-20);
    const lastPromptIndex = lines.findLastIndex(paneLineLooksLikeIdlePrompt);
    // Claude Code v2.1.x renders the permission-mode indicator
    // ("⏵⏵ bypass permissions on (shift+tab to cycle)") *below* the prompt
    // as a persistent idle-state UI element. If a prompt is present anywhere
    // in the tail, the pane has finished bootstrapping and the banner is an
    // idle mode indicator, not a startup signal.
    if (lastPromptIndex >= 0)
        return false;
    const lastStartupBannerIndex = lines.findLastIndex((line) => /bypass\s+permissions\s+on/i.test(line)
        || /shift\+tab\s+to\s+cycle/i.test(line)
        || /^⏵⏵\s+/.test(line));
    return lastStartupBannerIndex >= 0;
}
function paneIsBootstrapping(captured) {
    if (paneHasClaudeStartupBanner(captured))
        return true;
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
function paneLineLooksLikeIdlePrompt(line) {
    // Claude Code can render its idle input prompt inside a box/left gutter
    // (for example "│ ❯"). Treat that as ready while still requiring the prompt
    // glyph to be at the visual start of the line, not embedded in arbitrary
    // output text.
    return /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯]\s*/u.test(line);
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
    if (paneHasTrustPrompt(content))
        return true;
    if (paneIsBootstrapping(content))
        return false;
    const lastLine = lines[lines.length - 1];
    if (paneLineLooksLikeIdlePrompt(lastLine))
        return true;
    return lines.some(paneLineLooksLikeIdlePrompt);
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
        const captured = await capturePaneAsync(paneId);
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
    if (isCmuxSurfaceTarget(paneId))
        return false;
    try {
        const result = await tmuxCmdAsync(['display-message', '-t', paneId, '-p', '#{pane_in_mode}']);
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
        const sendKey = async (key) => {
            await sendTeamPaneKey(paneId, key);
        };
        // Guard: copy-mode captures keys; skip injection entirely.
        if (await paneInCopyMode(paneId)) {
            return false;
        }
        // Check for trust prompt and auto-dismiss before sending our text
        const initialCapture = await capturePaneAsync(paneId);
        if (paneHasClaudeStartupBanner(initialCapture)) {
            return false;
        }
        const paneBusy = paneHasActiveTask(initialCapture);
        const trustPromptKind = detectPaneTrustPromptKind(initialCapture);
        if (trustPromptKind === 'directory') {
            await sendKey('C-m');
            await sleep(120);
            await sendKey('C-m');
            await sleep(200);
        }
        else if (trustPromptKind === 'codex_hooks') {
            // Codex CLI 0.133+ may block on a hook-trust menu. Do not choose
            // "Trust all" automatically; select the safe non-trusting continuation
            // so non-interactive team workers can bootstrap without widening trust.
            await sendKey('3');
            await sleep(120);
            await sendKey('C-m');
            await sleep(200);
        }
        // Send text in literal mode with -- separator
        if (isCmuxSurfaceTarget(paneId)) {
            await cmuxSendSurface(paneId, message);
        }
        else {
            await tmuxExecAsync(['send-keys', '-t', paneId, '-l', '--', message]);
        }
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
            const checkCapture = await capturePaneAsync(paneId);
            if (!paneTailContainsLiteralLine(checkCapture, message))
                return true;
            await sleep(140);
        }
        // Safety gate: copy-mode can turn on while we retry; never send fallback control keys when active.
        if (await paneInCopyMode(paneId)) {
            return false;
        }
        // Adaptive fallback: for busy panes, retry once without interrupting active turns.
        const finalCapture = await capturePaneAsync(paneId);
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
            if (isCmuxSurfaceTarget(paneId)) {
                await cmuxSendSurface(paneId, message);
            }
            else {
                await tmuxExecAsync(['send-keys', '-t', paneId, '-l', '--', message]);
            }
            await sleep(120);
            for (let round = 0; round < 4; round++) {
                await sendKey('C-m');
                await sleep(180);
                await sendKey('C-m');
                await sleep(140);
                const retryCapture = await capturePaneAsync(paneId);
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
        const finalCheckCapture = await capturePaneAsync(paneId);
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
        if (await paneInCopyMode(leaderPaneId)) {
            return false;
        }
        const captured = await capturePaneAsync(leaderPaneId);
        if (paneHasActiveTask(captured)) {
            if (isCmuxSurfaceTarget(leaderPaneId)) {
                await cmuxSendSurfaceKey(leaderPaneId, 'C-c');
            }
            else {
                await tmuxExecAsync(['send-keys', '-t', leaderPaneId, 'C-c']);
            }
            await new Promise(r => setTimeout(r, 250));
        }
    }
    catch { /* best-effort */ }
    return sendToWorker(sessionName, leaderPaneId, prefixed);
}
function isTmuxPaneNotFoundError(error) {
    const err = error;
    const text = [err?.stderr, err?.stdout, err?.message]
        .filter((part) => typeof part === 'string')
        .join('\n')
        .toLowerCase();
    return /can't find pane|can't find window|can't find session|no such pane|pane not found|unknown pane/.test(text);
}
export async function getWorkerLiveness(paneId) {
    if (isCmuxSurfaceTarget(paneId)) {
        try {
            await cmuxCaptureSurface(paneId);
            return 'alive';
        }
        catch {
            return 'unknown';
        }
    }
    try {
        const result = await tmuxCmdAsync([
            'display-message', '-t', paneId, '-p', '#{pane_dead}'
        ]);
        return result.stdout.trim() === '0' ? 'alive' : 'dead';
    }
    catch (error) {
        return isTmuxPaneNotFoundError(error) ? 'dead' : 'unknown';
    }
}
export async function isWorkerAlive(paneId) {
    return (await getWorkerLiveness(paneId)) === 'alive';
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
    const shutdownPath = join(getOmcRoot(cwd), 'state', 'team', teamName, 'shutdown.json');
    try {
        await fs.writeFile(shutdownPath, JSON.stringify({ requestedAt: Date.now() }));
        const aliveChecks = await Promise.all(paneIds.map(id => isWorkerAlive(id)));
        if (aliveChecks.some(alive => alive)) {
            await sleep(graceMs);
        }
    }
    catch { /* sentinel write failure is non-fatal */ }
    // 2. Force-kill each worker pane, guarding leader
    for (const paneId of paneIds) {
        if (paneId === leaderPaneId)
            continue; // GUARD — never kill leader
        try {
            await killTeamPane(paneId);
        }
        catch { /* pane already gone — OK */ }
    }
}
function isPaneId(value) {
    return typeof value === 'string' && (/^%\d+$/.test(value.trim()) || isCmuxSurfaceTarget(value));
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
        const paneResult = await tmuxCmdAsync(['list-panes', '-t', sessionName, '-F', '#{pane_id}']);
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
    const sessionMode = options.sessionMode
        ?? (sessionName.includes(':') ? 'split-pane' : 'detached-session');
    if (sessionMode === 'split-pane') {
        if (!workerPaneIds?.length)
            return;
        for (const id of workerPaneIds) {
            if (id === leaderPaneId)
                continue;
            try {
                await killTeamPane(id);
            }
            catch { /* already gone */ }
        }
        return;
    }
    if (sessionMode === 'dedicated-window') {
        try {
            await tmuxExecAsync(['kill-window', '-t', sessionName]);
        }
        catch {
            // Window may already be gone.
        }
        return;
    }
    const sessionTarget = sessionName.split(':')[0] ?? sessionName;
    if (process.env.OMC_TEAM_ALLOW_KILL_CURRENT_SESSION !== '1' && process.env.TMUX) {
        try {
            const current = await tmuxCmdAsync(['display-message', '-p', '#S']);
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
        await tmuxExecAsync(['kill-session', '-t', sessionTarget]);
    }
    catch {
        // Session may already be dead.
    }
}
//# sourceMappingURL=tmux-session.js.map
/**
 * Native tmux shell launch for omc
 * Launches Claude Code with tmux session management
 */
import { execFileSync } from 'child_process';
import { resolveLaunchPolicy, buildTmuxSessionName, buildTmuxShellCommand, isClaudeAvailable, } from './tmux-utils.js';
// Flag mapping
const MADMAX_FLAG = '--madmax';
const YOLO_FLAG = '--yolo';
const CLAUDE_BYPASS_FLAG = '--dangerously-skip-permissions';
const NOTIFY_FLAG = '--notify';
/**
 * Extract the OMC-specific --notify flag from launch args.
 * --notify false  → disable notifications (OMC_NOTIFY=0)
 * --notify true   → enable notifications (default)
 * This flag must be stripped before passing args to Claude CLI.
 */
export function extractNotifyFlag(args) {
    let notifyEnabled = true;
    const remainingArgs = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === NOTIFY_FLAG && i + 1 < args.length) {
            const val = args[i + 1].toLowerCase();
            notifyEnabled = val !== 'false' && val !== '0';
            i++; // skip value
        }
        else if (arg.startsWith(`${NOTIFY_FLAG}=`)) {
            const val = arg.slice(NOTIFY_FLAG.length + 1).toLowerCase();
            notifyEnabled = val !== 'false' && val !== '0';
        }
        else {
            remainingArgs.push(arg);
        }
    }
    return { notifyEnabled, remainingArgs };
}
/**
 * Normalize Claude launch arguments
 * Maps --madmax/--yolo to --dangerously-skip-permissions
 * All other flags pass through unchanged
 */
export function normalizeClaudeLaunchArgs(args) {
    const normalized = [];
    let wantsBypass = false;
    let hasBypass = false;
    for (const arg of args) {
        if (arg === MADMAX_FLAG || arg === YOLO_FLAG) {
            wantsBypass = true;
            continue;
        }
        if (arg === CLAUDE_BYPASS_FLAG) {
            wantsBypass = true;
            if (!hasBypass) {
                normalized.push(arg);
                hasBypass = true;
            }
            continue;
        }
        normalized.push(arg);
    }
    if (wantsBypass && !hasBypass) {
        normalized.push(CLAUDE_BYPASS_FLAG);
    }
    return normalized;
}
/**
 * preLaunch: Prepare environment before Claude starts
 * Currently a placeholder - can be extended for:
 * - Session state initialization
 * - Environment setup
 * - Pre-launch checks
 */
export async function preLaunch(_cwd, _sessionId) {
    // Placeholder for future pre-launch logic
    // e.g., session state, environment prep, etc.
}
/**
 * runClaude: Launch Claude CLI (blocks until exit)
 * Handles 3 scenarios:
 * 1. inside-tmux: Launch claude in current pane
 * 2. outside-tmux: Create new tmux session with claude
 * 3. direct: tmux not available, run claude directly
 */
export function runClaude(cwd, args, sessionId) {
    const policy = resolveLaunchPolicy(process.env);
    switch (policy) {
        case 'inside-tmux':
            runClaudeInsideTmux(cwd, args);
            break;
        case 'outside-tmux':
            runClaudeOutsideTmux(cwd, args, sessionId);
            break;
        case 'direct':
            runClaudeDirect(cwd, args);
            break;
    }
}
/**
 * Run Claude inside existing tmux session
 * Launches Claude in current pane
 */
function runClaudeInsideTmux(cwd, args) {
    // Launch Claude in current pane
    try {
        execFileSync('claude', args, { cwd, stdio: 'inherit' });
    }
    catch (error) {
        const err = error;
        if (err.code === 'ENOENT') {
            console.error('[omc] Error: claude CLI not found in PATH.');
            process.exit(1);
        }
        // Propagate Claude's exit code so omc does not swallow failures
        process.exit(typeof err.status === 'number' ? err.status : 1);
    }
}
/**
 * Run Claude outside tmux - create new session
 * Creates tmux session with Claude
 */
function runClaudeOutsideTmux(cwd, args, _sessionId) {
    const claudeCmd = buildTmuxShellCommand('claude', args);
    const sessionName = buildTmuxSessionName(cwd);
    const tmuxArgs = [
        'new-session', '-d', '-s', sessionName, '-c', cwd,
        claudeCmd,
        ';', 'set-option', '-g', 'mouse', 'on',
    ];
    // Attach to session
    tmuxArgs.push(';', 'attach-session', '-t', sessionName);
    try {
        execFileSync('tmux', tmuxArgs, { stdio: 'inherit' });
    }
    catch {
        // tmux failed, fall back to direct launch
        runClaudeDirect(cwd, args);
    }
}
/**
 * Run Claude directly (no tmux)
 * Fallback when tmux is not available
 */
function runClaudeDirect(cwd, args) {
    try {
        execFileSync('claude', args, { cwd, stdio: 'inherit' });
    }
    catch (error) {
        const err = error;
        if (err.code === 'ENOENT') {
            console.error('[omc] Error: claude CLI not found in PATH.');
            process.exit(1);
        }
        // Propagate Claude's exit code so omc does not swallow failures
        process.exit(typeof err.status === 'number' ? err.status : 1);
    }
}
/**
 * postLaunch: Cleanup after Claude exits
 * Currently a placeholder - can be extended for:
 * - Session cleanup
 * - State finalization
 * - Post-launch reporting
 */
export async function postLaunch(_cwd, _sessionId) {
    // Placeholder for future post-launch logic
    // e.g., cleanup, finalization, etc.
}
/**
 * Main launch command entry point
 * Orchestrates the 3-phase launch: preLaunch -> run -> postLaunch
 */
export async function launchCommand(args) {
    // Extract OMC-specific --notify flag before passing remaining args to Claude CLI
    const { notifyEnabled, remainingArgs } = extractNotifyFlag(args);
    if (!notifyEnabled) {
        process.env.OMC_NOTIFY = '0';
    }
    const cwd = process.cwd();
    // Pre-flight: check for nested session
    if (process.env.CLAUDECODE) {
        console.error('[omc] Error: Already inside a Claude Code session. Nested launches are not supported.');
        process.exit(1);
    }
    // Pre-flight: check claude CLI availability
    if (!isClaudeAvailable()) {
        console.error('[omc] Error: claude CLI not found. Install Claude Code first:');
        console.error('  npm install -g @anthropic-ai/claude-code');
        process.exit(1);
    }
    const normalizedArgs = normalizeClaudeLaunchArgs(remainingArgs);
    const sessionId = `omc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Phase 1: preLaunch
    try {
        await preLaunch(cwd, sessionId);
    }
    catch (err) {
        // preLaunch errors must NOT prevent Claude from starting
        console.error(`[omc] preLaunch warning: ${err instanceof Error ? err.message : err}`);
    }
    // Phase 2: run
    try {
        runClaude(cwd, normalizedArgs, sessionId);
    }
    finally {
        // Phase 3: postLaunch
        await postLaunch(cwd, sessionId);
    }
}
//# sourceMappingURL=launch.js.map
/**
 * Interop CLI Command - Split-pane tmux session with OMC and OMX
 *
 * Creates a tmux split-pane layout with Claude Code (OMC) on the left
 * and Codex CLI (OMX) on the right, with shared interop state.
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { isTmuxAvailable, isClaudeAvailable } from './tmux-utils.js';
import { initInteropSession } from '../interop/shared-state.js';
export function readInteropRuntimeFlags(env = process.env) {
    const rawMode = (env.OMX_OMC_INTEROP_MODE || 'off').toLowerCase();
    const mode = rawMode === 'observe' || rawMode === 'active' ? rawMode : 'off';
    return {
        enabled: env.OMX_OMC_INTEROP_ENABLED === '1',
        mode,
        omcInteropToolsEnabled: env.OMC_INTEROP_TOOLS_ENABLED === '1',
        failClosed: env.OMX_OMC_INTEROP_FAIL_CLOSED !== '0',
    };
}
export function validateInteropRuntimeFlags(flags) {
    if (!flags.enabled && flags.mode !== 'off') {
        return { ok: false, reason: 'OMX_OMC_INTEROP_MODE must be "off" when OMX_OMC_INTEROP_ENABLED=0.' };
    }
    if (flags.mode === 'active' && !flags.omcInteropToolsEnabled) {
        return { ok: false, reason: 'Active mode requires OMC_INTEROP_TOOLS_ENABLED=1.' };
    }
    return { ok: true };
}
/**
 * Check if codex CLI is available
 */
function isCodexAvailable() {
    try {
        execFileSync('codex', ['--version'], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Launch interop session with split tmux panes
 */
export function launchInteropSession(cwd = process.cwd()) {
    const flags = readInteropRuntimeFlags();
    const flagCheck = validateInteropRuntimeFlags(flags);
    console.log(`[interop] mode=${flags.mode}, enabled=${flags.enabled ? '1' : '0'}, tools=${flags.omcInteropToolsEnabled ? '1' : '0'}, failClosed=${flags.failClosed ? '1' : '0'}`);
    if (!flagCheck.ok) {
        console.error(`Error: ${flagCheck.reason}`);
        console.error('Refusing to start interop in invalid flag configuration.');
        process.exit(1);
    }
    // Check prerequisites
    if (!isTmuxAvailable()) {
        console.error('Error: tmux is not available. Install tmux to use interop mode.');
        process.exit(1);
    }
    const hasCodex = isCodexAvailable();
    const hasClaude = isClaudeAvailable();
    if (!hasClaude) {
        console.error('Error: claude CLI is not available. Install Claude Code CLI first.');
        process.exit(1);
    }
    if (!hasCodex) {
        console.warn('Warning: codex CLI is not available. Only Claude Code will be launched.');
        console.warn('Install oh-my-codex (npm install -g @openai/codex) for full interop support.\n');
    }
    // Check if already in tmux
    const inTmux = Boolean(process.env.TMUX);
    if (!inTmux) {
        console.error('Error: Interop mode requires running inside a tmux session.');
        console.error('Start tmux first: tmux new-session -s myproject');
        process.exit(1);
    }
    // Generate session ID
    const sessionId = `interop-${randomUUID().split('-')[0]}`;
    // Initialize interop session
    const _config = initInteropSession(sessionId, cwd, hasCodex ? cwd : undefined);
    console.log(`Initializing interop session: ${sessionId}`);
    console.log(`Working directory: ${cwd}`);
    console.log(`Config saved to: ${cwd}/.omc/state/interop/config.json\n`);
    // Get current pane ID
    let currentPaneId;
    try {
        const output = execFileSync('tmux', ['display-message', '-p', '#{pane_id}'], {
            encoding: 'utf-8',
        });
        currentPaneId = output.trim();
    }
    catch (_error) {
        console.error('Error: Failed to get current tmux pane ID');
        process.exit(1);
    }
    if (!currentPaneId.startsWith('%')) {
        console.error('Error: Invalid tmux pane ID format');
        process.exit(1);
    }
    // Split pane horizontally (left: claude, right: codex)
    try {
        if (hasCodex) {
            // Create right pane with codex
            console.log('Splitting pane: Left (Claude Code) | Right (Codex)');
            execFileSync('tmux', [
                'split-window',
                '-h',
                '-c', cwd,
                '-t', currentPaneId,
                'codex',
            ], { stdio: 'inherit' });
            // Select left pane (original/current)
            execFileSync('tmux', ['select-pane', '-t', currentPaneId], { stdio: 'ignore' });
            console.log('\nInterop session ready!');
            console.log('- Left pane: Claude Code (this terminal)');
            console.log('- Right pane: Codex CLI');
            console.log('\nYou can now use interop MCP tools to communicate between the two:');
            console.log('- interop_send_task: Send tasks between tools');
            console.log('- interop_read_results: Check task results');
            console.log('- interop_send_message: Send messages');
            console.log('- interop_read_messages: Read messages');
        }
        else {
            // Codex not available, just inform user
            console.log('\nClaude Code is ready in this pane.');
            console.log('Install oh-my-codex to enable split-pane interop mode.');
            console.log('\nInstall: npm install -g @openai/codex');
        }
    }
    catch (error) {
        console.error('Error creating split pane:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
/**
 * CLI entry point for interop command
 */
export function interopCommand(options = {}) {
    const cwd = options.cwd || process.cwd();
    launchInteropSession(cwd);
}
//# sourceMappingURL=interop.js.map
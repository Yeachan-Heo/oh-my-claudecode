import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
/**
 * Tests for Gemini prompt-mode (headless) spawn flow.
 *
 * Gemini CLI v0.29.7+ uses an Ink-based TUI that does not receive keystrokes
 * via tmux send-keys. The fix passes the initial instruction via the `-p` flag
 * (prompt mode) so the TUI is bypassed entirely. Trust-confirm and send-keys
 * notification are skipped for prompt-mode agents.
 *
 * See: https://github.com/anthropics/claude-code/issues/1000
 */
// Track all tmux calls made during spawn
const tmuxCalls = vi.hoisted(() => ({
    args: [],
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const { promisify: utilPromisify } = await import('util');
    function mockExecFile(_cmd, args, cb) {
        tmuxCalls.args.push(args);
        if (args[0] === 'split-window') {
            cb(null, '%42\n', '');
        }
        else if (args[0] === 'capture-pane') {
            cb(null, '', '');
        }
        else if (args[0] === 'display-message') {
            // pane_dead check → "0" means alive; pane_in_mode → "0" means not in copy mode
            cb(null, '0', '');
        }
        else {
            cb(null, '', '');
        }
        return {};
    }
    // Attach custom promisify so util.promisify(execFile) returns {stdout, stderr}
    mockExecFile[utilPromisify.custom] = async (_cmd, args) => {
        tmuxCalls.args.push(args);
        if (args[0] === 'split-window') {
            return { stdout: '%42\n', stderr: '' };
        }
        if (args[0] === 'capture-pane') {
            return { stdout: '', stderr: '' };
        }
        if (args[0] === 'display-message') {
            return { stdout: '0', stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    return {
        ...actual,
        spawnSync: vi.fn((_cmd, args) => {
            if (args?.[0] === '--version')
                return { status: 0 };
            return { status: 1 };
        }),
        execFile: mockExecFile,
    };
});
import { spawnWorkerForTask } from '../runtime.js';
function makeRuntime(cwd, agentType) {
    return {
        teamName: 'test-team',
        sessionName: 'test-session:0',
        leaderPaneId: '%0',
        config: {
            teamName: 'test-team',
            workerCount: 1,
            agentTypes: [agentType],
            tasks: [{ subject: 'Test task', description: 'Do something' }],
            cwd,
        },
        workerNames: ['worker-1'],
        workerPaneIds: [],
        activeWorkers: new Map(),
        cwd,
    };
}
function setupTaskDir(cwd) {
    const tasksDir = join(cwd, '.omc/state/team/test-team/tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, '1.json'), JSON.stringify({
        id: '1',
        subject: 'Test task',
        description: 'Do something',
        status: 'pending',
        owner: null,
    }));
    const workerDir = join(cwd, '.omc/state/team/test-team/workers/worker-1');
    mkdirSync(workerDir, { recursive: true });
}
describe('spawnWorkerForTask – prompt mode (Gemini & Codex)', () => {
    let cwd;
    beforeEach(() => {
        tmuxCalls.args = [];
        cwd = mkdtempSync(join(tmpdir(), 'runtime-gemini-prompt-'));
        setupTaskDir(cwd);
    });
    it('gemini worker launch args include -p flag with inbox path', async () => {
        const runtime = makeRuntime(cwd, 'gemini');
        await spawnWorkerForTask(runtime, 'worker-1', 0);
        // Find the send-keys call that launches the worker (contains -l flag)
        const launchCall = tmuxCalls.args.find(args => args[0] === 'send-keys' && args.includes('-l'));
        expect(launchCall).toBeDefined();
        const launchCmd = launchCall[launchCall.length - 1];
        // Should contain -p flag for prompt mode
        expect(launchCmd).toContain("'-p'");
        // Should contain the inbox path reference
        expect(launchCmd).toContain('.omc/state/team/test-team/workers/worker-1/inbox.md');
        rmSync(cwd, { recursive: true, force: true });
    });
    it('gemini worker skips trust-confirm (no "1" sent via send-keys)', async () => {
        const runtime = makeRuntime(cwd, 'gemini');
        await spawnWorkerForTask(runtime, 'worker-1', 0);
        // Collect all literal send-keys messages (the -l flag content)
        const literalMessages = tmuxCalls.args
            .filter(args => args[0] === 'send-keys' && args.includes('-l'))
            .map(args => args[args.length - 1]);
        // Should NOT contain the trust-confirm "1" as a literal send
        const trustConfirmSent = literalMessages.some(msg => msg === '1');
        expect(trustConfirmSent).toBe(false);
        rmSync(cwd, { recursive: true, force: true });
    });
    it('gemini worker writes inbox before spawn', async () => {
        const runtime = makeRuntime(cwd, 'gemini');
        await spawnWorkerForTask(runtime, 'worker-1', 0);
        const inboxPath = join(cwd, '.omc/state/team/test-team/workers/worker-1/inbox.md');
        const content = readFileSync(inboxPath, 'utf-8');
        expect(content).toContain('Initial Task Assignment');
        expect(content).toContain('Test task');
        expect(content).toContain('Do something');
        rmSync(cwd, { recursive: true, force: true });
    });
    it('codex worker launch args include positional prompt (no -p flag)', async () => {
        const runtime = makeRuntime(cwd, 'codex');
        await spawnWorkerForTask(runtime, 'worker-1', 0);
        // Find the send-keys call that launches the worker (contains -l flag)
        const launchCall = tmuxCalls.args.find(args => args[0] === 'send-keys' && args.includes('-l'));
        expect(launchCall).toBeDefined();
        const launchCmd = launchCall[launchCall.length - 1];
        // Should NOT contain -p flag (codex uses positional argument, not a flag)
        expect(launchCmd).not.toContain("'-p'");
        // Should contain the inbox path as a positional argument
        expect(launchCmd).toContain('.omc/state/team/test-team/workers/worker-1/inbox.md');
        rmSync(cwd, { recursive: true, force: true });
    });
    it('codex worker skips interactive send-keys notification (uses prompt mode)', async () => {
        const runtime = makeRuntime(cwd, 'codex');
        await spawnWorkerForTask(runtime, 'worker-1', 0);
        // After the initial launch send-keys, there should be NO follow-up
        // send-keys with "Read and execute" text (prompt-mode agents skip the
        // interactive notification path).
        const sendKeysCalls = tmuxCalls.args.filter(args => args[0] === 'send-keys' && args.includes('-l'));
        // Only one send-keys call: the launch command itself
        expect(sendKeysCalls.length).toBe(1);
        rmSync(cwd, { recursive: true, force: true });
    });
});
//# sourceMappingURL=runtime-prompt-mode.test.js.map
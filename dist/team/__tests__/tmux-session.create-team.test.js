import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mockedCalls = vi.hoisted(() => ({
    execFileArgs: [],
    splitCount: 0,
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const runMockExec = (args) => {
        mockedCalls.execFileArgs.push(args);
        if (args[0] === 'display-message' && args.includes('#S:#I #{pane_id}')) {
            return { stdout: 'fallback:2 %42\n', stderr: '' };
        }
        if (args[0] === 'display-message' && args.includes('#S:#I')) {
            return { stdout: 'omx:4\n', stderr: '' };
        }
        if (args[0] === 'display-message' && args.includes('#{window_width}')) {
            return { stdout: '160\n', stderr: '' };
        }
        if (args[0] === 'split-window') {
            mockedCalls.splitCount += 1;
            return { stdout: `%50${mockedCalls.splitCount}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    /** Parse a shell command like: tmux "arg1" "arg2" into ['arg1', 'arg2'] */
    const parseTmuxShellCmd = (cmd) => {
        const match = cmd.match(/^tmux\s+(.+)$/);
        if (!match)
            return null;
        return match[1].match(/"([^"]*)"/g)?.map(s => s.slice(1, -1)) ?? [];
    };
    const execFileMock = vi.fn((_cmd, args, cb) => {
        const { stdout, stderr } = runMockExec(args);
        cb(null, stdout, stderr);
        return {};
    });
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    execFileMock[promisifyCustom] =
        async (_cmd, args) => runMockExec(args);
    const execMock = vi.fn((cmd, cb) => {
        const args = parseTmuxShellCmd(cmd);
        const { stdout, stderr } = args ? runMockExec(args) : { stdout: '', stderr: '' };
        cb(null, stdout, stderr);
        return {};
    });
    execMock[promisifyCustom] =
        async (cmd) => {
            const args = parseTmuxShellCmd(cmd);
            return args ? runMockExec(args) : { stdout: '', stderr: '' };
        };
    return {
        ...actual,
        exec: execMock,
        execFile: execFileMock,
    };
});
import { createTeamSession } from '../tmux-session.js';
describe('createTeamSession context resolution', () => {
    beforeEach(() => {
        mockedCalls.execFileArgs = [];
        mockedCalls.splitCount = 0;
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });
    it('anchors context to TMUX_PANE to avoid focus races', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        const session = await createTeamSession('race-team', 1, '/tmp');
        const targetedContextCall = mockedCalls.execFileArgs.find(args => args[0] === 'display-message' &&
            args[1] === '-p' &&
            args[2] === '-t' &&
            args[3] === '%732' &&
            args[4] === '#S:#I');
        expect(targetedContextCall).toBeDefined();
        const fallbackContextCall = mockedCalls.execFileArgs.find(args => args[0] === 'display-message' &&
            args.includes('#S:#I #{pane_id}'));
        expect(fallbackContextCall).toBeUndefined();
        const firstSplitCall = mockedCalls.execFileArgs.find(args => args[0] === 'split-window');
        expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%732']));
        expect(session.leaderPaneId).toBe('%732');
        expect(session.sessionName).toBe('omx:4');
        expect(session.workerPaneIds).toEqual(['%501']);
    });
    it('falls back to default context discovery when TMUX_PANE is invalid', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', 'not-a-pane-id');
        const session = await createTeamSession('race-team', 0, '/tmp');
        const targetedContextCall = mockedCalls.execFileArgs.find(args => args[0] === 'display-message' &&
            args[1] === '-p' &&
            args[2] === '-t' &&
            args[4] === '#S:#I');
        expect(targetedContextCall).toBeUndefined();
        const fallbackContextCall = mockedCalls.execFileArgs.find(args => args[0] === 'display-message' &&
            args[1] === '-p' &&
            args[2] === '#S:#I #{pane_id}');
        expect(fallbackContextCall).toBeDefined();
        expect(session.leaderPaneId).toBe('%42');
        expect(session.sessionName).toBe('fallback:2');
        expect(session.workerPaneIds).toEqual([]);
    });
});
//# sourceMappingURL=tmux-session.create-team.test.js.map
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mockedCalls = vi.hoisted(() => ({
    execFileArgs: [],
    splitCount: 0,
    // When set, overrides the response for `display-message -p '#S:#I #{pane_id}'`
    // so a test can simulate cmux returning UUID-style pane ids.
    contextOverride: null,
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const runMockExec = (args) => {
        mockedCalls.execFileArgs.push(args);
        if (args[0] === 'new-session') {
            return { stdout: 'omc-team-race-team-detached:0 %91\n', stderr: '' };
        }
        if (args[0] === 'new-window') {
            return { stdout: 'omx:5 %99\n', stderr: '' };
        }
        if (args[0] === 'display-message' && args.includes('#S:#I #{pane_id}')) {
            if (mockedCalls.contextOverride) {
                return { stdout: mockedCalls.contextOverride, stderr: '' };
            }
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
    const parseTmuxShellCmd = (cmd) => {
        const match = cmd.match(/^tmux\s+(.+)$/);
        if (!match)
            return null;
        // Support both single-quoted (H1 fix) and double-quoted args
        const args = match[1].match(/'([^']*(?:\\.[^']*)*)'|"([^"]*)"/g);
        if (!args)
            return null;
        return args.map((s) => {
            if (s.startsWith("'"))
                return s.slice(1, -1).replace(/'\\''/g, "'");
            return s.slice(1, -1);
        });
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
import { createTeamSession, detectTeamMultiplexerContext } from '../tmux-session.js';
describe('detectTeamMultiplexerContext', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });
    it('returns tmux when TMUX is present', () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-surface');
        expect(detectTeamMultiplexerContext()).toBe('tmux');
    });
    it('returns cmux when CMUX_SURFACE_ID is present without TMUX', () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-surface');
        expect(detectTeamMultiplexerContext()).toBe('cmux');
    });
    it('returns none when neither tmux nor cmux markers are present', () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        expect(detectTeamMultiplexerContext()).toBe('none');
    });
});
describe('createTeamSession context resolution', () => {
    beforeEach(() => {
        mockedCalls.execFileArgs = [];
        mockedCalls.splitCount = 0;
        mockedCalls.contextOverride = null;
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });
    it('creates a detached session when running outside tmux', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        const session = await createTeamSession('race-team', 0, '/tmp');
        const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args[0] === 'new-session' && args.includes('-d') && args.includes('-P'));
        expect(detachedCreateCall).toBeDefined();
        expect(session.leaderPaneId).toBe('%91');
        expect(session.sessionName).toBe('omc-team-race-team-detached:0');
        expect(session.workerPaneIds).toEqual([]);
        expect(session.sessionMode).toBe('detached-session');
    });
    it('uses a detached tmux session when running inside cmux', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-surface');
        const session = await createTeamSession('race-team', 1, '/tmp', { newWindow: true });
        expect(mockedCalls.execFileArgs.some((args) => args[0] === 'new-window')).toBe(false);
        const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args[0] === 'new-session' && args.includes('-d') && args.includes('-P'));
        expect(detachedCreateCall).toBeDefined();
        const firstSplitCall = mockedCalls.execFileArgs.find((args) => args[0] === 'split-window');
        expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%91']));
        expect(session.leaderPaneId).toBe('%91');
        expect(session.sessionName).toBe('omc-team-race-team-detached:0');
        expect(session.workerPaneIds).toEqual(['%501']);
        expect(session.sessionMode).toBe('detached-session');
    });
    it('anchors context to TMUX_PANE to avoid focus races', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        const session = await createTeamSession('race-team', 1, '/tmp');
        const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args[0] === 'new-session');
        expect(detachedCreateCall).toBeUndefined();
        const targetedContextCall = mockedCalls.execFileArgs.find((args) => args[0] === 'display-message'
            && args[1] === '-p'
            && args[2] === '-t'
            && args[3] === '%732'
            && args[4] === '#S:#I');
        expect(targetedContextCall).toBeDefined();
        const fallbackContextCall = mockedCalls.execFileArgs.find((args) => args[0] === 'display-message' && args.includes('#S:#I #{pane_id}'));
        expect(fallbackContextCall).toBeUndefined();
        const firstSplitCall = mockedCalls.execFileArgs.find((args) => args[0] === 'split-window');
        expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%732']));
        expect(session.leaderPaneId).toBe('%732');
        expect(session.sessionName).toBe('omx:4');
        expect(session.workerPaneIds).toEqual(['%501']);
        expect(session.sessionMode).toBe('split-pane');
    });
    it('creates a dedicated tmux window when requested', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        const session = await createTeamSession('race-team', 1, '/tmp', { newWindow: true });
        const newWindowCall = mockedCalls.execFileArgs.find((args) => args[0] === 'new-window');
        expect(newWindowCall).toEqual(expect.arrayContaining(['new-window', '-d', '-P', '-t', 'omx', '-n', 'omc-race-team']));
        const firstSplitCall = mockedCalls.execFileArgs.find((args) => args[0] === 'split-window');
        expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%99']));
        expect(mockedCalls.execFileArgs.some((args) => args[0] === 'select-pane' && args.includes('%99'))).toBe(false);
        expect(session.leaderPaneId).toBe('%99');
        expect(session.sessionName).toBe('omx:5');
        expect(session.workerPaneIds).toEqual(['%501']);
        expect(session.sessionMode).toBe('dedicated-window');
    });
    // Regression: cmux's `__tmux-compat` shim returns UUID-format pane ids
    // (`%<UUID>`) instead of tmux's numeric `%<integer>`. The previous parser
    // (`/^(\S+)\s+(%\d+)$/`) rejected these and threw
    // `Failed to resolve tmux context: "cmux:0 %<UUID>"`, blocking
    // `cmux omc team` end-to-end. The new parser accepts both shapes.
    it('accepts UUID-style pane ids returned by cmux __tmux-compat', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-surface');
        mockedCalls.contextOverride = 'cmux:0 %7B41407B-1DE7-4A0F-9FD9-1E8DABEA2A2A\n';
        const session = await createTeamSession('cmux-uuid-team', 0, '/tmp');
        expect(session.leaderPaneId).toBe('%7B41407B-1DE7-4A0F-9FD9-1E8DABEA2A2A');
        expect(session.sessionName).toBe('cmux:0');
    });
});
//# sourceMappingURL=tmux-session.create-team.test.js.map
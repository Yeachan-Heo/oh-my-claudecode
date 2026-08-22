import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mockedCalls = vi.hoisted(() => ({
    execFileArgs: [],
    splitCount: 0,
    newSplitStdouts: [],
    tmuxSplitStdouts: [],
    tmuxSplitError: null,
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const runMockExec = (args) => {
        mockedCalls.execFileArgs.push(args);
        const tmuxArgs = args[0]?.toLowerCase().endsWith('cmd.exe') ? args.slice(1) : args;
        if (tmuxArgs[0] === 'new-session') {
            return { stdout: 'omc-team-race-team-detached:0 %91\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'new-window') {
            return { stdout: 'omx:5 %99\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#S:#I #{pane_id}')) {
            return { stdout: 'fallback:2 %42\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#S:#I')) {
            return { stdout: 'omx:4\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#{window_width}')) {
            return { stdout: '160\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#{pane_dead} #{pane_current_command}')) {
            return { stdout: '0 zsh\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'split-window') {
            mockedCalls.splitCount += 1;
            if (mockedCalls.tmuxSplitError) {
                const failure = Object.assign(new Error(mockedCalls.tmuxSplitError.message), {
                    stdout: mockedCalls.tmuxSplitError.stdout,
                    stderr: mockedCalls.tmuxSplitError.stderr,
                });
                throw failure;
            }
            return { stdout: mockedCalls.tmuxSplitStdouts.shift() ?? `%50${mockedCalls.splitCount}\n`, stderr: '' };
        }
        if (tmuxArgs[0] === 'new-split') {
            mockedCalls.splitCount += 1;
            return {
                stdout: mockedCalls.newSplitStdouts.shift() ?? `cmux-worker-${mockedCalls.splitCount}\n`,
                stderr: '',
            };
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
    const execSyncMock = vi.fn((cmd) => {
        if (cmd === 'tmux -V')
            return 'tmux 3.4\n';
        return '';
    });
    return {
        ...actual,
        exec: execMock,
        execFile: execFileMock,
        execSync: execSyncMock,
    };
});
import { createTeamSession, detectTeamMultiplexerContext, splitTeamWorkerPane, splitTeamWorkerPaneWithEvidence } from '../tmux-session.js';
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
        mockedCalls.newSplitStdouts = [];
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
        expect(mockedCalls.execFileArgs).toContainEqual(['set-option', '-t', 'omc-team-race-team-detached', 'set-clipboard', 'on']);
        expect(mockedCalls.execFileArgs).toContainEqual(['set-option', '-at', 'omc-team-race-team-detached', 'terminal-features', ',*:clipboard']);
        expect(session.leaderPaneId).toBe('%91');
        expect(session.sessionName).toBe('omc-team-race-team-detached:0');
        expect(session.workerPaneIds).toEqual([]);
        expect(session.sessionMode).toBe('detached-session');
    });
    it('uses native cmux splits instead of a detached tmux session when running inside cmux', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace-1');
        const session = await createTeamSession('race-team', 2, '/tmp', { newWindow: true });
        expect(mockedCalls.execFileArgs.some((args) => args[0] === 'new-window')).toBe(false);
        expect(mockedCalls.execFileArgs.some((args) => args[0] === 'new-session' && args.includes('-d'))).toBe(false);
        expect(mockedCalls.execFileArgs).toContainEqual(['new-split', 'right', '--surface', 'cmux-leader', '--workspace', 'workspace-1']);
        expect(mockedCalls.execFileArgs).toContainEqual(['new-split', 'down', '--surface', 'cmux-worker-1', '--workspace', 'workspace-1']);
        expect(session.leaderPaneId).toBe('cmux-leader');
        expect(session.sessionName).toBe('cmux:workspace-1');
        expect(session.workerPaneIds).toEqual(['cmux-worker-1', 'cmux-worker-2']);
        expect(session.sessionMode).toBe('split-pane');
    });
    it('parses documented cmux new-split OK output without using OK as a surface', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace-1');
        mockedCalls.newSplitStdouts = [
            '  OK   cmux-worker-1   workspace-1\n',
            '\nOK\tcmux-worker-2\tworkspace-1  \n',
        ];
        const session = await createTeamSession('race-team', 2, '/tmp', { newWindow: true });
        expect(mockedCalls.execFileArgs).toContainEqual(['new-split', 'right', '--surface', 'cmux-leader', '--workspace', 'workspace-1']);
        expect(mockedCalls.execFileArgs).toContainEqual(['new-split', 'down', '--surface', 'cmux-worker-1', '--workspace', 'workspace-1']);
        expect(mockedCalls.execFileArgs).not.toContainEqual(expect.arrayContaining(['--surface', 'OK']));
        expect(session.workerPaneIds).toEqual(['cmux-worker-1', 'cmux-worker-2']);
    });
    it('anchors context to TMUX_PANE to avoid focus races', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        const session = await createTeamSession('race-team', 1, '/tmp');
        const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args[0] === 'new-session');
        expect(detachedCreateCall).toBeUndefined();
        expect(mockedCalls.execFileArgs).toContainEqual(['set-option', '-t', 'omx', 'set-clipboard', 'on']);
        expect(mockedCalls.execFileArgs).toContainEqual(['set-option', '-at', 'omx', 'terminal-features', ',*:clipboard']);
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
    it('launches native Windows psmux detached team sessions with explicit cmd shell', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        await createTeamSession('race-team', 0, 'C:\\repo');
        const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args.includes('new-session') && args.includes('-d') && args.includes('-P'));
        expect(detachedCreateCall).toEqual(expect.arrayContaining(['new-session', '-d', '-P', '-F', '#S:0 #{pane_id}', '-s', expect.any(String), '-c', 'C:\\repo', 'C:\\Windows\\System32\\cmd.exe']));
    });
    it('launches native Windows psmux worker splits with explicit cmd shell', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        await createTeamSession('race-team', 1, 'C:\\repo');
        const firstSplitCall = mockedCalls.execFileArgs.find((args) => args.includes('split-window'));
        expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%732', '-d', '-P', '-F', '#{pane_id}', '-c', 'C:\\repo', 'C:\\Windows\\System32\\cmd.exe']));
    });
    it('keeps MSYS psmux team panes on POSIX shell defaults', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        vi.stubEnv('MSYSTEM', 'MINGW64');
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        await createTeamSession('race-team', 1, '/c/repo');
        const firstSplitCall = mockedCalls.execFileArgs.find((args) => args[0] === 'split-window');
        expect(firstSplitCall).toEqual(expect.arrayContaining(['split-window', '-h', '-t', '%732']));
        expect(firstSplitCall).not.toContain('C:\\Windows\\System32\\cmd.exe');
    });
});
describe('splitTeamWorkerPane multiplexer routing (#3267)', () => {
    beforeEach(() => {
        mockedCalls.execFileArgs = [];
        mockedCalls.splitCount = 0;
        mockedCalls.newSplitStdouts = [];
        mockedCalls.tmuxSplitStdouts = [];
        mockedCalls.tmuxSplitError = null;
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });
    it('creates a native cmux surface (not a tmux pane) for on-demand workers under cmux', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace-1');
        const paneId = await splitTeamWorkerPane('cmux-leader', 'right', '/tmp');
        // A cmux surface id (UUID/token) — NOT a tmux "%N" pane id — so that
        // spawnWorkerInPane()/waitForShellReady() short-circuit instead of polling
        // tmux and timing out with worker_start_shell_not_ready.
        expect(paneId).toBe('cmux-worker-1');
        expect(paneId?.startsWith('%')).toBe(false);
        expect(mockedCalls.execFileArgs).toContainEqual(['new-split', 'right', '--surface', 'cmux-leader', '--workspace', 'workspace-1']);
        expect(mockedCalls.execFileArgs.some((args) => args[0] === 'split-window')).toBe(false);
    });
    it('falls back to a tmux split-window pane id when running under tmux', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        const paneId = await splitTeamWorkerPane('%732', 'down', '/tmp');
        expect(paneId).toBe('%501');
        expect(mockedCalls.execFileArgs).toContainEqual(expect.arrayContaining(['split-window', '-v', '-t', '%732']));
        expect(mockedCalls.execFileArgs.some((args) => args[0] === 'new-split')).toBe(false);
    });
    it('retains successful tmux split output when the pane id is malformed', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.tmuxSplitStdouts.push('not-a-pane\n');
        await expect(splitTeamWorkerPaneWithEvidence('%732', 'right', '/tmp')).resolves.toEqual({
            commandSucceeded: true,
            provider: 'tmux',
            splitTarget: '%732',
            direction: 'right',
            rawOutput: 'not-a-pane\n',
            stderr: '',
            paneId: null,
        });
    });
    it('retains stdout and stderr when tmux split execution rejects', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.tmuxSplitError = { stdout: '%orphan\n', stderr: 'transport interrupted', message: 'split failed' };
        await expect(splitTeamWorkerPaneWithEvidence('%732', 'down', '/tmp')).resolves.toEqual({
            commandSucceeded: false,
            provider: 'tmux',
            splitTarget: '%732',
            direction: 'down',
            rawOutput: '%orphan\n',
            stderr: 'transport interrupted',
            paneId: null,
        });
    });
    it('retains successful cmux stdout when no surface identity can be parsed', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace-1');
        mockedCalls.newSplitStdouts.push('\n');
        await expect(splitTeamWorkerPaneWithEvidence('cmux-leader', 'right', '/tmp')).resolves.toEqual({
            commandSucceeded: true,
            provider: 'cmux',
            splitTarget: 'cmux-leader',
            direction: 'right',
            rawOutput: '\n',
            stderr: '',
            paneId: null,
        });
    });
});
//# sourceMappingURL=tmux-session.create-team.test.js.map
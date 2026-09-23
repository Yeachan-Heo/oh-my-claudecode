import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
const mockedCalls = vi.hoisted(() => ({
    execFileArgs: [],
    identitySocketPath: '/tmp/omc-create-team.sock',
    splitCount: 0,
    newSplitStdouts: [],
    tmuxSplitStdouts: [],
    tmuxSplitError: null,
    newWindowStdouts: [],
    newWindowError: null,
    freshServerAlive: false,
    freshServerKillCount: 0,
    freshSessionInventory: [],
    nativeWindowInventory: [],
    nativeWindowInventoryReads: [],
    nativeWindowKillCount: 0,
}));
const strictProcessStartedAt = currentStrictProcessStartIdentity();
const supportsStrictTmuxFixture = (process.platform === 'darwin' || process.platform === 'linux')
    && Boolean(strictProcessStartedAt);
const strictSocketPath = mockedCalls.identitySocketPath;
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const runMockExec = (args) => {
        mockedCalls.execFileArgs.push(args);
        const commandArgs = args[0]?.toLowerCase().endsWith('cmd.exe') ? args.slice(1) : args;
        const socket = commandArgs[0] === '-S' ? commandArgs[1] : undefined;
        const tmuxArgs = commandArgs[0] === '-S' ? commandArgs.slice(2) : commandArgs;
        if (tmuxArgs[0] === 'if-shell') {
            const commandText = tmuxArgs.join(' ');
            const marker = commandText.match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
            if (!marker)
                return { stdout: '', stderr: '' };
            if (commandText.includes('split-window')) {
                mockedCalls.splitCount += 1;
                if (mockedCalls.tmuxSplitError) {
                    const failure = Object.assign(new Error(mockedCalls.tmuxSplitError.message), {
                        stdout: mockedCalls.tmuxSplitError.stdout,
                        stderr: mockedCalls.tmuxSplitError.stderr,
                    });
                    throw failure;
                }
                const paneOutput = mockedCalls.tmuxSplitStdouts.shift() ?? `%50${mockedCalls.splitCount}\n`;
                const paneLine = paneOutput.trim() === '' || !/^%\d+$/.test(paneOutput.trim())
                    ? paneOutput
                    : `${paneOutput.trim()}\t${socket ?? mockedCalls.identitySocketPath}\t${process.pid}\n`;
                return { stdout: `${paneLine}${marker}\n`, stderr: '' };
            }
            if (commandText.includes('new-session')) {
                mockedCalls.freshServerAlive = true;
                const session = commandText.match(/'-s'\s+'([^']+)'/)?.[1] ?? 'omc-team-race-team-detached';
                mockedCalls.freshSessionInventory = [session];
                return {
                    stdout: `${session}:0\t%91\t${socket ?? mockedCalls.identitySocketPath}\t${process.pid}\n${marker}\n`,
                    stderr: '',
                };
            }
            if (commandText.includes('new-window')) {
                if (mockedCalls.newWindowError) {
                    const failure = Object.assign(new Error(mockedCalls.newWindowError.message), {
                        stdout: mockedCalls.newWindowError.stdout,
                        stderr: mockedCalls.newWindowError.stderr,
                    });
                    throw failure;
                }
                const windowOutput = mockedCalls.newWindowStdouts.shift()
                    ?? `omx:5\t%99\t${socket ?? mockedCalls.identitySocketPath}\t${process.pid}\n`;
                const normalizedWindowOutput = windowOutput.trim();
                if (/^\S+\t%\d+\t\S+\t\d+$/.test(normalizedWindowOutput)) {
                    const resource = normalizedWindowOutput.split('\t')[0] ?? '';
                    const separator = resource.lastIndexOf(':');
                    if (separator > 0 && /^\d+$/.test(resource.slice(separator + 1))) {
                        const sessionName = resource.slice(0, separator);
                        const windowIndex = resource.slice(separator + 1);
                        mockedCalls.nativeWindowInventory = [`@${windowIndex}\t$1\t${sessionName}\t${windowIndex}`];
                    }
                }
                return {
                    stdout: `${windowOutput}${marker}\n`,
                    stderr: '',
                };
            }
            if (commandText.includes('kill-server')) {
                mockedCalls.freshServerAlive = false;
                mockedCalls.freshSessionInventory = [];
                mockedCalls.freshServerKillCount += 1;
                return { stdout: `${marker}\n`, stderr: '' };
            }
            if (commandText.includes('kill-window')) {
                mockedCalls.nativeWindowInventory = [];
                mockedCalls.nativeWindowKillCount += 1;
                return { stdout: `${marker}\n`, stderr: '' };
            }
            return { stdout: `${marker}\n`, stderr: '' };
        }
        if (tmuxArgs[0] === 'new-session') {
            const sessionIndex = tmuxArgs.indexOf('-s');
            const session = sessionIndex >= 0 ? tmuxArgs[sessionIndex + 1] : 'detached';
            mockedCalls.freshServerAlive = true;
            mockedCalls.freshSessionInventory = [session];
            return {
                stdout: `${session}:0\t%91\t${socket ?? mockedCalls.identitySocketPath}\t${process.pid}\n`,
                stderr: '',
            };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#S:#I #{pane_id}')) {
            return { stdout: 'fallback:2 %42\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#S:#I')) {
            return { stdout: 'omx:4\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.some(arg => arg.includes('#{socket_path}'))) {
            if (!socket && !process.env.TMUX)
                return { stdout: '', stderr: '' };
            return { stdout: `${socket ?? mockedCalls.identitySocketPath}\t${process.pid}\n`, stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#{pid}')) {
            return { stdout: `${process.pid}\n`, stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#{window_width}')) {
            return { stdout: '160\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'display-message' && tmuxArgs.includes('#{pane_dead} #{pane_current_command}')) {
            return { stdout: '0 zsh\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'show-options') {
            return { stdout: '*:clipboard\n', stderr: '' };
        }
        if (tmuxArgs[0] === 'new-split') {
            mockedCalls.splitCount += 1;
            return {
                stdout: mockedCalls.newSplitStdouts.shift() ?? `cmux-worker-${mockedCalls.splitCount}\n`,
                stderr: '',
            };
        }
        if (tmuxArgs[0] === 'start-server') {
            mockedCalls.freshServerAlive = true;
            mockedCalls.freshSessionInventory = [];
            return { stdout: '', stderr: '' };
        }
        if (tmuxArgs[0] === 'list-windows') {
            mockedCalls.nativeWindowInventoryReads.push([...mockedCalls.nativeWindowInventory]);
            return {
                stdout: mockedCalls.nativeWindowInventory.length > 0
                    ? `${mockedCalls.nativeWindowInventory.join('\n')}\n`
                    : '',
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
    const parseShellInvocation = (cmd) => {
        // Keep the full shell command as one opaque argument for if-shell. The
        // nested condition/success/failure scripts contain quoted commands and
        // guard markers; tokenizing them with the fixture's simple parser loses
        // the native command and makes the mock unlike tmux.
        if (cmd.includes('if-shell')) {
            const socket = cmd.match(/tmux\s+'-S'\s+'([^']+)'/)?.[1];
            return socket ? ['-S', socket, 'if-shell', cmd] : ['if-shell', cmd];
        }
        return parseTmuxShellCmd(cmd);
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
        const args = parseShellInvocation(cmd);
        const { stdout, stderr } = args ? runMockExec(args) : { stdout: '', stderr: '' };
        cb(null, stdout, stderr);
        return {};
    });
    execMock[promisifyCustom] =
        async (cmd) => {
            const args = parseShellInvocation(cmd);
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
import { createTeamSession, detectTeamMultiplexerContext, splitTeamWorkerPane, splitTeamWorkerPaneWithEvidence, TeamSessionCreationError, } from '../tmux-session.js';
function destructiveProviderCalls() {
    return mockedCalls.execFileArgs.filter((args) => /\b(?:kill-server|kill-session|kill-window|kill-pane|close-surface)\b/.test(args.join(' ')));
}
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
        mockedCalls.tmuxSplitStdouts = [];
        mockedCalls.tmuxSplitError = null;
        mockedCalls.newWindowStdouts = [];
        mockedCalls.newWindowError = null;
        mockedCalls.freshServerAlive = false;
        mockedCalls.freshServerKillCount = 0;
        mockedCalls.freshSessionInventory = [];
        mockedCalls.nativeWindowInventory = [];
        mockedCalls.nativeWindowInventoryReads = [];
        mockedCalls.nativeWindowKillCount = 0;
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });
    it.skipIf(!supportsStrictTmuxFixture)('creates a detached session when running outside tmux', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        const session = await createTeamSession('race-team', 0, '/tmp');
        const keepaliveCall = mockedCalls.execFileArgs.find((args) => args.includes('start-server') && args.includes('exit-empty'));
        expect(keepaliveCall).toBeDefined();
        expect(keepaliveCall).toEqual(expect.arrayContaining([
            '-S', expect.stringMatching(/^\/tmp\/o-/),
        ]));
        const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args.join(' ').includes('new-session') && args.includes('if-shell'));
        expect(detachedCreateCall).toBeDefined();
        expect(detachedCreateCall).toEqual(expect.arrayContaining([
            '-S', keepaliveCall?.[1],
        ]));
        expect(detachedCreateCall?.find(arg => arg.includes('new-session'))).toContain('OMC_TMUX_GUARD_OK_');
        expect(mockedCalls.execFileArgs.some((args) => args.includes('if-shell') && args.join(' ').includes('set-clipboard'))).toBe(true);
        expect(mockedCalls.execFileArgs.some((args) => args.includes('if-shell') && /exit-empty(?:['"\\]|\s)+on/.test(args.join(' ')))).toBe(true);
        expect(mockedCalls.execFileArgs.some((args) => args.includes('if-shell')
            && args.join(' ').includes(`=${session.sessionName.split(':')[0]}:`)
            && args.join(' ').includes('set-option'))).toBe(true);
        expect(mockedCalls.execFileArgs.some((args) => args.includes('if-shell') && args.join(' ').includes('terminal-features'))).toBe(false);
        expect(session.leaderPaneId).toBe('%91');
        expect(session.sessionName).toMatch(/^omc-team-race-team-[^-]+:0$/);
        expect(session.workerPaneIds).toEqual([]);
        expect(session.sessionMode).toBe('detached-session');
        expect(session.tmuxServerIdentity).toMatchObject({
            server_pid: process.pid,
            process_started_at: strictProcessStartedAt,
        });
        expect(session.tmuxServerIdentity?.socket_path).toBe(keepaliveCall?.[1]);
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
    it.skipIf(!supportsStrictTmuxFixture)('anchors context to TMUX_PANE to avoid focus races', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        const session = await createTeamSession('race-team', 1, '/tmp');
        const detachedCreateCall = mockedCalls.execFileArgs.find((args) => args.includes('new-session'));
        expect(detachedCreateCall).toBeUndefined();
        expect(mockedCalls.execFileArgs.some((args) => args.includes('-S') && args.includes(strictSocketPath) && args.join(' ').includes('set-clipboard'))).toBe(true);
        expect(mockedCalls.execFileArgs.some((args) => args.includes('if-shell')
            && args.join(' ').includes('=omx:')
            && args.join(' ').includes('set-option'))).toBe(true);
        const targetedContextCall = mockedCalls.execFileArgs.find((args) => args.includes('display-message')
            && args.includes('-t')
            && args.includes('%732')
            && args.includes('#S:#I'));
        expect(targetedContextCall).toBeDefined();
        const fallbackContextCall = mockedCalls.execFileArgs.find((args) => args[0] === 'display-message' && args.includes('#S:#I #{pane_id}'));
        expect(fallbackContextCall).toBeUndefined();
        const firstSplitCall = mockedCalls.execFileArgs.find((args) => args.join(' ').includes('split-window'));
        expect(firstSplitCall?.join(' ')).toContain('split-window');
        expect(firstSplitCall).toEqual(expect.arrayContaining(['-S', strictSocketPath]));
        expect(firstSplitCall?.join(' ')).toContain('-h');
        expect(firstSplitCall?.join(' ')).toContain('%732');
        expect(session.leaderPaneId).toBe('%732');
        expect(session.sessionName).toBe('omx:4');
        expect(session.workerPaneIds).toEqual(['%501']);
        expect(session.sessionMode).toBe('split-pane');
        expect(session.tmuxServerIdentity).toMatchObject({
            socket_path: strictSocketPath,
            server_pid: process.pid,
            process_started_at: strictProcessStartedAt,
        });
    });
    it.skipIf(!supportsStrictTmuxFixture)('creates a dedicated tmux window when requested', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        const session = await createTeamSession('race-team', 1, '/tmp', { newWindow: true });
        const newWindowCall = mockedCalls.execFileArgs.find((args) => args.join(' ').includes('new-window'));
        expect(newWindowCall?.join(' ')).toContain('new-window');
        expect(newWindowCall).toEqual(expect.arrayContaining(['-S', strictSocketPath]));
        expect(newWindowCall?.join(' ')).toContain('-t');
        expect(newWindowCall?.join(' ')).toContain('omx');
        expect(newWindowCall?.join(' ')).toContain('omc-race-team');
        expect(mockedCalls.execFileArgs.some((args) => args.includes('if-shell')
            && args.join(' ').includes('=omx:')
            && args.join(' ').includes('set-option'))).toBe(true);
        const firstSplitCall = mockedCalls.execFileArgs.find((args) => args.join(' ').includes('split-window'));
        expect(firstSplitCall?.join(' ')).toContain('split-window');
        expect(firstSplitCall).toEqual(expect.arrayContaining(['-S', strictSocketPath]));
        expect(firstSplitCall?.join(' ')).toContain('-h');
        expect(firstSplitCall?.join(' ')).toContain('%99');
        expect(mockedCalls.execFileArgs.some((args) => args.join(' ').includes('select-pane') && args.includes('%99'))).toBe(false);
        expect(session.leaderPaneId).toBe('%99');
        expect(session.sessionName).toBe('omx:5');
        expect(session.workerPaneIds).toEqual(['%501']);
        expect(session.sessionMode).toBe('dedicated-window');
        expect(session.tmuxServerIdentity).toMatchObject({
            socket_path: strictSocketPath,
            server_pid: process.pid,
            process_started_at: strictProcessStartedAt,
        });
    });
    it.skipIf(!supportsStrictTmuxFixture).each([
        ['zero previously-known panes', ['malformed-split\n'], []],
        ['one previously-known pane', ['%501\n', 'malformed-split\n'], ['%501']],
    ])('keeps shared-tmux malformed split cleanup unknown with %s', async (_label, splitStdouts, expectedKnownPanes) => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.tmuxSplitStdouts = [...splitStdouts];
        let caught;
        try {
            await createTeamSession('race-team', splitStdouts.length, '/tmp');
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TeamSessionCreationError);
        const creationError = caught;
        expect(creationError.cleanupStatus).toBe('unknown');
        expect(creationError.creationEvidence).toMatchObject({
            provider: 'tmux',
            operation: 'split-window',
            rawOutput: expect.stringContaining('malformed-split'),
        });
        expect(creationError.partialSession).toMatchObject({
            sessionName: 'omx:4',
            leaderPaneId: '%732',
            workerPaneIds: expectedKnownPanes,
            sessionMode: 'split-pane',
            tmuxServerIdentity: {
                socket_path: strictSocketPath,
                server_pid: process.pid,
                process_started_at: strictProcessStartedAt,
            },
        });
        expect(destructiveProviderCalls()).toEqual([]);
    });
    it.skipIf(!supportsStrictTmuxFixture)('keeps a shared-tmux unknown split command outcome typed unknown', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.tmuxSplitError = {
            stdout: '%orphan\n',
            stderr: 'transport interrupted',
            message: 'split command response unavailable',
        };
        let caught;
        try {
            await createTeamSession('race-team', 1, '/tmp');
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TeamSessionCreationError);
        const creationError = caught;
        expect(creationError.cleanupStatus).toBe('unknown');
        expect(creationError.creationEvidence).toMatchObject({
            provider: 'tmux',
            operation: 'split-window',
            rawOutput: '',
            stderr: expect.stringContaining('split command response unavailable'),
        });
        expect(creationError.partialSession.workerPaneIds).toEqual([]);
        expect(destructiveProviderCalls()).toEqual([]);
    });
    it.skipIf(!supportsStrictTmuxFixture)('emits typed unknown evidence for a malformed dedicated new-window response without killing by name', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.newWindowStdouts = ['malformed-window-response\n'];
        let caught;
        try {
            await createTeamSession('race-team', 0, '/tmp', { newWindow: true });
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TeamSessionCreationError);
        const creationError = caught;
        expect(creationError.cleanupStatus).toBe('unknown');
        expect(creationError.creationEvidence).toMatchObject({
            provider: 'tmux',
            operation: 'new-window',
            rawOutput: expect.stringContaining('malformed-window-response'),
            tmuxServerIdentity: {
                socket_path: strictSocketPath,
                server_pid: process.pid,
                process_started_at: strictProcessStartedAt,
            },
        });
        expect(creationError.partialSession).toMatchObject({
            sessionName: 'omx:4',
            leaderPaneId: '%732',
            workerPaneIds: [],
            sessionMode: 'dedicated-window',
        });
        expect(destructiveProviderCalls()).toEqual([]);
    });
    it.skipIf(!supportsStrictTmuxFixture)('emits typed unknown evidence for an unknown dedicated new-window response without killing by name', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.newWindowError = {
            stdout: 'omx:5\t%99\t/tmp/omc-create-team.sock\t4242\n',
            stderr: 'transport interrupted',
            message: 'new-window response unavailable',
        };
        let caught;
        try {
            await createTeamSession('race-team', 0, '/tmp', { newWindow: true });
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TeamSessionCreationError);
        const creationError = caught;
        expect(creationError.cleanupStatus).toBe('unknown');
        expect(creationError.creationEvidence).toMatchObject({
            provider: 'tmux',
            operation: 'new-window',
            rawOutput: '',
            stderr: expect.stringContaining('new-window response unavailable'),
        });
        expect(creationError.partialSession).toMatchObject({
            sessionName: 'omx:4',
            leaderPaneId: '%732',
            workerPaneIds: [],
            sessionMode: 'dedicated-window',
        });
        expect(destructiveProviderCalls()).toEqual([]);
    });
    it.skipIf(!supportsStrictTmuxFixture)('verifies cleanup of a whole new owned window only after native inventory and guarded kill removal', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.tmuxSplitStdouts = ['malformed-worker-pane\n'];
        let caught;
        try {
            await createTeamSession('race-team', 1, '/tmp', { newWindow: true });
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TeamSessionCreationError);
        const creationError = caught;
        expect(creationError.cleanupStatus).toBe('verified');
        expect(creationError.creationEvidence).toMatchObject({
            provider: 'tmux',
            operation: 'split-window',
            rawOutput: expect.stringContaining('malformed-worker-pane'),
        });
        expect(creationError.partialSession).toMatchObject({
            sessionName: 'omx:5',
            leaderPaneId: '%99',
            workerPaneIds: [],
            sessionMode: 'dedicated-window',
        });
        expect(mockedCalls.nativeWindowInventoryReads).toEqual([
            ['@5\t$1\tomx\t5'],
        ]);
        expect(mockedCalls.nativeWindowInventory).toEqual([]);
        expect(mockedCalls.nativeWindowKillCount).toBe(1);
        expect(destructiveProviderCalls().filter((args) => args.join(' ').includes('kill-window'))).toHaveLength(1);
        expect(destructiveProviderCalls().some((args) => args.join(' ').includes('kill-session'))).toBe(false);
    });
    it('keeps an unparseable cmux split as typed unknown evidence without closing an unowned surface', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace-1');
        mockedCalls.newSplitStdouts = ['\n'];
        let caught;
        try {
            await createTeamSession('race-team', 1, '/tmp');
        }
        catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TeamSessionCreationError);
        const creationError = caught;
        expect(creationError.cleanupStatus).toBe('unknown');
        expect(creationError.creationEvidence).toMatchObject({
            provider: 'cmux',
            operation: 'new-split',
            rawOutput: '\n',
            stderr: '',
        });
        expect(creationError.partialSession).toMatchObject({
            sessionName: 'cmux:workspace-1',
            leaderPaneId: 'cmux-leader',
            workerPaneIds: [],
            sessionMode: 'split-pane',
        });
        expect(destructiveProviderCalls()).toEqual([]);
    });
    it('rejects native Windows psmux detached team sessions without strict tmux authority', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        await expect(createTeamSession('race-team', 0, 'C:\\repo'))
            .rejects.toThrow('tmux_server_identity_probe_unavailable');
        expect(mockedCalls.execFileArgs.some((args) => /\b(?:start-server|new-session|new-window|split-window)\b/.test(args.join(' ')))).toBe(false);
    });
    it('rejects native Windows psmux worker creation without strict tmux authority', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        await expect(createTeamSession('race-team', 1, 'C:\\repo'))
            .rejects.toThrow('tmux_server_identity_probe_unavailable');
        expect(mockedCalls.execFileArgs.some((args) => /\b(?:start-server|new-session|new-window|split-window)\b/.test(args.join(' ')))).toBe(false);
    });
    it('rejects MSYS psmux team creation without strict tmux authority', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
        vi.stubEnv('MSYSTEM', 'MINGW64');
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        await expect(createTeamSession('race-team', 1, '/c/repo'))
            .rejects.toThrow('tmux_server_identity_probe_unavailable');
        expect(mockedCalls.execFileArgs.some((args) => /\b(?:start-server|new-session|new-window|split-window)\b/.test(args.join(' ')))).toBe(false);
    });
});
describe('splitTeamWorkerPane multiplexer routing (#3267)', () => {
    beforeEach(() => {
        mockedCalls.execFileArgs = [];
        mockedCalls.splitCount = 0;
        mockedCalls.newSplitStdouts = [];
        mockedCalls.tmuxSplitStdouts = [];
        mockedCalls.tmuxSplitError = null;
        mockedCalls.newWindowStdouts = [];
        mockedCalls.newWindowError = null;
        mockedCalls.freshServerAlive = false;
        mockedCalls.freshServerKillCount = 0;
        mockedCalls.freshSessionInventory = [];
        mockedCalls.nativeWindowInventory = [];
        mockedCalls.nativeWindowInventoryReads = [];
        mockedCalls.nativeWindowKillCount = 0;
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
    it('preserves resources when tmux split lacks a server identity', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        const paneId = await splitTeamWorkerPane('%732', 'down', '/tmp');
        expect(paneId).toBeNull();
        expect(mockedCalls.execFileArgs.some((args) => args.join(' ').includes('split-window'))).toBe(false);
        expect(mockedCalls.execFileArgs.some((args) => args[0] === 'new-split')).toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('uses an original-server identity for tmux split effects', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        const evidence = await splitTeamWorkerPaneWithEvidence('%732', 'down', '/tmp', 'tmux', {
            socket_path: strictSocketPath,
            server_pid: process.pid,
            process_started_at: strictProcessStartedAt,
        });
        expect(evidence).toMatchObject({
            commandSucceeded: true,
            provider: 'tmux',
            splitTarget: '%732',
            direction: 'down',
            paneId: '%501',
            tmuxServerIdentity: {
                socket_path: strictSocketPath,
                server_pid: process.pid,
                process_started_at: strictProcessStartedAt,
            },
        });
        expect(evidence.rawOutput).toMatch(/OMC_TMUX_GUARD_OK_/);
        const guardCall = mockedCalls.execFileArgs.find(args => args.includes('if-shell'));
        expect(guardCall).toBeDefined();
        expect(guardCall).toEqual(expect.arrayContaining(['-S', strictSocketPath]));
        const rawGuard = guardCall?.find(arg => arg.includes('split-window')) ?? '';
        expect(rawGuard).toContain('split-window');
        expect(rawGuard).toContain('%732');
    });
    it.skipIf(!supportsStrictTmuxFixture)('fails closed when tmux split output has no native pane identity', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.tmuxSplitStdouts.push('not-a-pane\n');
        const result = await splitTeamWorkerPaneWithEvidence('%732', 'right', '/tmp', 'tmux', {
            socket_path: strictSocketPath,
            server_pid: process.pid,
            process_started_at: strictProcessStartedAt,
        });
        expect(result).toMatchObject({
            commandSucceeded: false,
            provider: 'tmux',
            splitTarget: '%732',
            direction: 'right',
            paneId: null,
        });
        expect(result.rawOutput).toContain('not-a-pane');
    });
    it.skipIf(!supportsStrictTmuxFixture)('preserves unknown when guarded tmux split execution rejects', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        vi.stubEnv('TMUX_PANE', '%732');
        vi.stubEnv('CMUX_SURFACE_ID', '');
        mockedCalls.tmuxSplitError = { stdout: '%orphan\n', stderr: 'transport interrupted', message: 'split failed' };
        await expect(splitTeamWorkerPaneWithEvidence('%732', 'down', '/tmp', 'tmux', {
            socket_path: strictSocketPath,
            server_pid: process.pid,
            process_started_at: strictProcessStartedAt,
        })).resolves.toEqual({
            commandSucceeded: false,
            provider: 'tmux',
            splitTarget: '%732',
            direction: 'down',
            rawOutput: '',
            stderr: 'split failed',
            paneId: null,
            tmuxServerIdentity: undefined,
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
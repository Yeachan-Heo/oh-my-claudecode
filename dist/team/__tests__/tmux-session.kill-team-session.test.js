import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
const mocked = vi.hoisted(() => ({
    execCalls: [],
    currentSession: 'leader-session',
    listedSessions: '$1\tleader-session\n$2\tworker-detached-session\n$3\tworker-detached-session-other\n',
    listedPanes: '%10\n%11\n',
    listedWindows: '@3\t$1\tleader-session\t3\n@4\t$1\tleader-session\t4\n',
    killWindowThrows: false,
    killSessionThrows: false,
    listWindowsThrows: false,
}));
const strictProcessStartedAt = currentStrictProcessStartIdentity();
const supportsStrictTmuxFixture = (process.platform === 'darwin' || process.platform === 'linux')
    && Boolean(strictProcessStartedAt);
const tmuxServerIdentity = supportsStrictTmuxFixture
    ? {
        socket_path: '/tmp/omc-kill-team-session.sock',
        server_pid: process.pid,
        process_started_at: strictProcessStartedAt,
    }
    : undefined;
function strictTmuxIdentity() {
    if (!tmuxServerIdentity)
        throw new Error('strict tmux fixture unsupported on this platform');
    return tmuxServerIdentity;
}
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const run = (args) => {
        mocked.execCalls.push(args);
        const commandArgs = args[0]?.toLowerCase().endsWith('cmd.exe') ? args.slice(1) : args;
        const socket = commandArgs[0] === '-S' ? commandArgs[1] : undefined;
        const tmuxArgs = commandArgs[0] === '-S' ? commandArgs.slice(2) : commandArgs;
        const command = tmuxArgs[0];
        if (command === 'if-shell') {
            const commandText = tmuxArgs.join(' ');
            const marker = commandText.match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
            if (!marker)
                return { stdout: '', stderr: '' };
            if (commandText.includes('kill-window') && mocked.killWindowThrows) {
                return { stdout: `OMC_TMUX_GUARD_FAIL_${marker}\n`, stderr: '' };
            }
            if (commandText.includes('kill-session') && mocked.killSessionThrows) {
                return { stdout: `OMC_TMUX_GUARD_FAIL_${marker}\n`, stderr: '' };
            }
            if (commandText.includes('kill-pane')) {
                const paneId = commandText.match(/%\d+/)?.[0];
                mocked.listedPanes = mocked.listedPanes.split('\n')
                    .filter(pane => pane && pane !== paneId).join('\n') + '\n';
            }
            return { stdout: `${marker}\n`, stderr: '' };
        }
        if (command === 'display-message' && tmuxArgs.includes('#S')) {
            return { stdout: `${mocked.currentSession}\n`, stderr: '' };
        }
        if (command === 'display-message' && tmuxArgs.some(arg => arg.includes('#{socket_path}'))) {
            return { stdout: `${socket ?? tmuxServerIdentity?.socket_path ?? ''}\t${process.pid}\n`, stderr: '' };
        }
        if (command === 'display-message' && tmuxArgs.includes('#{pid}')) {
            return { stdout: `${process.pid}\n`, stderr: '' };
        }
        if (command === 'list-panes') {
            if (tmuxArgs.some(arg => arg.includes('#{pane_dead}'))) {
                return {
                    stdout: mocked.listedPanes.split('\n').filter(Boolean).map(pane => `${pane} 0\n`).join(''),
                    stderr: '',
                };
            }
            return { stdout: mocked.listedPanes, stderr: '' };
        }
        if (command === 'list-sessions') {
            return { stdout: mocked.listedSessions, stderr: '' };
        }
        if (command === 'list-windows') {
            if (mocked.listWindowsThrows)
                return { stdout: '', stderr: '', error: new Error('tmux control mode failed') };
            return { stdout: mocked.listedWindows, stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    const parseTmuxShellCmd = (cmd) => {
        const match = cmd.match(/^tmux\s+(.+)$/);
        if (!match)
            return null;
        const args = match[1].match(/'([^']*(?:\\.[^']*)*)'|"([^"]*)"/g);
        if (!args)
            return null;
        return args.map((token) => {
            if (token.startsWith("'"))
                return token.slice(1, -1).replace(/'\\''/g, "'");
            return token.slice(1, -1);
        });
    };
    const parseShellInvocation = (cmd) => {
        // Keep if-shell opaque: the nested guard condition and native success
        // script contain quoting that the small fixture tokenizer cannot parse.
        if (cmd.includes('if-shell')) {
            const socket = cmd.match(/tmux\s+'-S'\s+'([^']+)'/)?.[1];
            return socket ? ['-S', socket, 'if-shell', cmd] : ['if-shell', cmd];
        }
        return parseTmuxShellCmd(cmd);
    };
    const execFileMock = vi.fn((_cmd, args, cb) => {
        const out = run(args);
        cb(out.error ?? null, out.stdout, out.stderr);
        return {};
    });
    execFileMock[Symbol.for('nodejs.util.promisify.custom')] =
        async (_cmd, args) => {
            const out = run(args);
            if (out.error)
                throw out.error;
            return { stdout: out.stdout, stderr: out.stderr };
        };
    const execMock = vi.fn((cmd, cb) => {
        const args = parseShellInvocation(cmd) ?? [];
        const out = run(args);
        cb(out.error ?? null, out.stdout, out.stderr);
        return {};
    });
    execMock[Symbol.for('nodejs.util.promisify.custom')] =
        async (cmd) => {
            const out = run(parseShellInvocation(cmd) ?? []);
            if (out.error)
                throw out.error;
            return { stdout: out.stdout, stderr: out.stderr };
        };
    return {
        ...actual,
        exec: execMock,
        execFile: execFileMock,
    };
});
import { killTeamSession, observeTeamSessionTargetPresence, resolveSplitPaneWorkerPaneIds } from '../tmux-session.js';
describe('killTeamSession safeguards', () => {
    afterEach(() => {
        mocked.execCalls = [];
        mocked.currentSession = 'leader-session';
        mocked.listedSessions = '$1\tleader-session\n$2\tworker-detached-session\n$3\tworker-detached-session-other\n';
        mocked.listedPanes = '%10\n%11\n';
        mocked.listedWindows = '@3\t$1\tleader-session\t3\n@4\t$1\tleader-session\t4\n';
        mocked.killWindowThrows = false;
        mocked.killSessionThrows = false;
        mocked.listWindowsThrows = false;
        vi.unstubAllEnvs();
    });
    it.skipIf(!supportsStrictTmuxFixture)('does not kill the current attached session by default', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        mocked.currentSession = 'leader-session';
        await expect(killTeamSession('leader-session', undefined, undefined, {
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
        expect(mocked.execCalls.some((args) => args.some(arg => arg === 'kill-session' || arg.includes('kill-session')))).toBe(false);
        expect(mocked.execCalls.some((args) => args[0] === '-S' && args[1] === strictTmuxIdentity().socket_path)).toBe(true);
    });
    it('preserves a tmux session when its server identity is missing', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        await expect(killTeamSession('worker-detached-session')).resolves.toBe(false);
        expect(mocked.execCalls).toEqual([]);
    });
    it.skipIf(!supportsStrictTmuxFixture)('kills a different detached session', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        mocked.currentSession = 'leader-session';
        await expect(killTeamSession('worker-detached-session', undefined, undefined, {
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        expect(mocked.execCalls.some((args) => args.join(' ').includes('$2') && args.some(arg => arg.includes('kill-session')))).toBe(true);
    });
    it.skipIf(!supportsStrictTmuxFixture)('kills only worker panes in split-pane mode', async () => {
        await expect(killTeamSession('leader-session:0', ['%10', '%11'], '%10', {
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        const killPaneTargets = mocked.execCalls
            .filter((args) => args.some(arg => arg.includes('kill-pane')))
            .map((args) => args.find(arg => arg.includes('%11')));
        expect(killPaneTargets).toHaveLength(1);
        expect(killPaneTargets[0]).toContain('%11');
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-session')))).toBe(false);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-window')))).toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('kills an owned team window when session owns that window', async () => {
        await expect(killTeamSession('leader-session:3', ['%10', '%11'], '%10', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        expect(mocked.execCalls.some((args) => args.join(' ').includes('@3') && args.some(arg => arg.includes('kill-window')))).toBe(true);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-pane')))).toBe(false);
    });
    it('uses only recorded worker panes during split-pane shutdown', async () => {
        mocked.listedPanes = '%10\n%11\n%12\n';
        const paneIds = await resolveSplitPaneWorkerPaneIds('leader-session:0', ['%11'], '%10');
        expect(paneIds).toEqual(['%11']);
        expect(mocked.execCalls.some((args) => args.includes('list-panes'))).toBe(false);
    });
    it('preserves a recorded worker pane when target membership cannot be proven', async () => {
        mocked.listedPanes = '%10\n';
        await expect(killTeamSession('leader-session:0', ['%11'], '%10')).resolves.toBe(false);
        expect(mocked.execCalls).toEqual([]);
        expect(mocked.execCalls.some((args) => args.includes('%11') && args.some(arg => arg.includes('kill-pane')))).toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('treats an exactly absent dedicated window as cleanup success', async () => {
        mocked.listedWindows = '@5\t$1\tleader-session\t0\n@6\t$1\tleader-session\t1\n';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        expect(mocked.execCalls.some((args) => args.includes('list-windows'))).toBe(true);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-window')))).toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('observes dedicated-window absence when inventory has no matching window', async () => {
        mocked.listedPanes = '';
        mocked.listedWindows = '@5\t$1\tleader-session\t0\n@6\t$1\tleader-session\t1\n';
        await expect(observeTeamSessionTargetPresence({
            sessionName: 'leader-session:3',
            sessionMode: 'dedicated-window',
            leaderPaneId: '%10',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toEqual({ kind: 'absent' });
    });
    it.skipIf(!supportsStrictTmuxFixture)('observes dedicated-window ownership when the leader pane remains', async () => {
        mocked.listedPanes = '%10\n%11\n';
        mocked.listedWindows = '@3\t$1\tleader-session\t3\n';
        await expect(observeTeamSessionTargetPresence({
            sessionName: 'leader-session:3',
            sessionMode: 'dedicated-window',
            leaderPaneId: '%10',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toEqual({ kind: 'owned' });
    });
    it.skipIf(!supportsStrictTmuxFixture)('observes a remaining dedicated window without the leader pane as present and unowned', async () => {
        mocked.listedPanes = '%11\n';
        mocked.listedWindows = '@3\t$1\tleader-session\t3\n';
        await expect(observeTeamSessionTargetPresence({
            sessionName: 'leader-session:3',
            sessionMode: 'dedicated-window',
            leaderPaneId: '%10',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toEqual({ kind: 'present_unowned' });
    });
    it.skipIf(!supportsStrictTmuxFixture)('rejects dedicated window cleanup when window is still present after kill fails', async () => {
        mocked.killWindowThrows = true;
        mocked.listedWindows = '@5\t$1\tleader-session\t0\n@3\t$1\tleader-session\t3\n';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture).each([
        ['guard failure', true],
        ['guard success', false],
    ])('handles a dedicated window guard %s without name fallback', async (_label, guardFails) => {
        mocked.killWindowThrows = true;
        mocked.killWindowThrows = guardFails;
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(!guardFails);
        const guardCall = mocked.execCalls.find(args => args.includes('if-shell'));
        expect(guardCall).toBeDefined();
        expect(guardCall).toEqual(expect.arrayContaining(['-S', strictTmuxIdentity().socket_path]));
        const rawGuard = guardCall?.find(arg => arg.includes('kill-window')) ?? '';
        expect(rawGuard).toContain('kill-window');
        expect(rawGuard).toContain('@3');
        expect(rawGuard).toContain('OMC_TMUX_GUARD_OK_');
    });
    it.skipIf(!supportsStrictTmuxFixture)('handles a failed session guard without deleting by name', async () => {
        mocked.killSessionThrows = true;
        await expect(killTeamSession('worker-detached-session', undefined, undefined, {
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
        const guardCall = mocked.execCalls.find(args => args.includes('if-shell'));
        expect(guardCall).toBeDefined();
        expect(guardCall).toEqual(expect.arrayContaining(['-S', strictTmuxIdentity().socket_path]));
        const rawGuard = guardCall?.find(arg => arg.includes('kill-session')) ?? '';
        expect(rawGuard).toContain('kill-session');
        expect(rawGuard).toContain('$2');
        expect(rawGuard).toContain('OMC_TMUX_GUARD_OK_');
    });
    it.skipIf(!supportsStrictTmuxFixture)('rejects dedicated window cleanup when list-windows command fails', async () => {
        mocked.killWindowThrows = true;
        mocked.listWindowsThrows = true;
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('treats empty list-windows output as unknown, not confirmed absence', async () => {
        mocked.killWindowThrows = true;
        mocked.listedWindows = '';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('resolves the exact window before destroying a similarly indexed window', async () => {
        mocked.listedWindows = '@30\t$1\tleader-session\t30\n@13\t$1\tleader-session\t13\n';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-window')))).toBe(false);
        mocked.execCalls = [];
        mocked.listedWindows = '@30\t$1\tleader-session\t30\n@13\t$1\tleader-session\t13\n@3\t$1\tleader-session\t3\n';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        const guardCall = mocked.execCalls.find(args => args.includes('if-shell'));
        expect(guardCall?.join(' ')).toContain('@3');
    });
    it.skipIf(!supportsStrictTmuxFixture)('does not use a similarly named session as the exact window target', async () => {
        mocked.listedWindows = '@3\t$1\tleader-session-other\t3\n';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-window')))).toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('rejects malformed/ambiguous list-windows output', async () => {
        mocked.killWindowThrows = true;
        mocked.listedWindows = 'garbage\nnot-a-window\n';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-window')))).toBe(false);
        mocked.execCalls = [];
        // No window index in session name → ambiguous → fail closed
        await expect(killTeamSession('leader-session', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('rejects duplicate exact window evidence instead of choosing one', async () => {
        mocked.listedWindows = '@3\t$1\tleader-session\t3\n@4\t$1\tleader-session\t3\n';
        await expect(killTeamSession('leader-session:3', [], '%0', {
            sessionMode: 'dedicated-window',
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(false);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-window')))).toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('resolves an exact session ID before destroying a colliding session name', async () => {
        mocked.listedSessions = '$7\tworker-detached-session\n$8\tworker-detached-session-other\n';
        await expect(killTeamSession('worker-detached-session', undefined, undefined, {
            tmuxServerIdentity: strictTmuxIdentity(),
        })).resolves.toBe(true);
        const guardCall = mocked.execCalls.find(args => args.includes('if-shell'));
        expect(guardCall?.join(' ')).toContain('$7');
        expect(guardCall?.join(' ')).not.toContain('worker-detached-session-other');
    });
    it.skipIf(!supportsStrictTmuxFixture)('rejects malformed or empty session evidence without destroying anything', async () => {
        mocked.listedSessions = 'not-a-session-record\n';
        await expect(killTeamSession('worker-detached-session', undefined, undefined, {
            ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
        })).resolves.toBe(false);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-session')))).toBe(false);
        mocked.execCalls = [];
        mocked.listedSessions = '';
        await expect(killTeamSession('worker-detached-session', undefined, undefined, {
            ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
        })).resolves.toBe(false);
        expect(mocked.execCalls.some((args) => args.some(arg => arg.includes('kill-session')))).toBe(false);
    });
});
//# sourceMappingURL=tmux-session.kill-team-session.test.js.map
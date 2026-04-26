import { afterEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
    execCalls: [],
    currentSession: 'leader-session',
    listedPanes: '%10\n%11\n',
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const run = (args) => {
        mocked.execCalls.push(args);
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
            return { stdout: `${mocked.currentSession}\n`, stderr: '' };
        }
        if (args[0] === 'list-panes') {
            return { stdout: mocked.listedPanes, stderr: '' };
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
    const execFileMock = vi.fn((_cmd, args, cb) => {
        const out = run(args);
        cb(null, out.stdout, out.stderr);
        return {};
    });
    execFileMock[Symbol.for('nodejs.util.promisify.custom')] =
        async (_cmd, args) => run(args);
    const execMock = vi.fn((cmd, cb) => {
        const args = parseTmuxShellCmd(cmd) ?? [];
        const out = run(args);
        cb(null, out.stdout, out.stderr);
        return {};
    });
    execMock[Symbol.for('nodejs.util.promisify.custom')] =
        async (cmd) => run(parseTmuxShellCmd(cmd) ?? []);
    return {
        ...actual,
        exec: execMock,
        execFile: execFileMock,
    };
});
import { killTeamSession, resolveSplitPaneWorkerPaneIds } from '../tmux-session.js';
describe('killTeamSession safeguards', () => {
    afterEach(() => {
        mocked.execCalls = [];
        mocked.currentSession = 'leader-session';
        mocked.listedPanes = '%10\n%11\n';
        vi.unstubAllEnvs();
    });
    it('does not kill the current attached session by default', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        mocked.currentSession = 'leader-session';
        await killTeamSession('leader-session');
        expect(mocked.execCalls.some((args) => args[0] === 'kill-session')).toBe(false);
    });
    it('kills a different detached session', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        mocked.currentSession = 'leader-session';
        await killTeamSession('worker-detached-session');
        expect(mocked.execCalls.some((args) => args[0] === 'kill-session' && args.includes('worker-detached-session'))).toBe(true);
    });
    it('kills only worker panes in split-pane mode', async () => {
        await killTeamSession('leader-session:0', ['%10', '%11'], '%10');
        const killPaneTargets = mocked.execCalls
            .filter((args) => args[0] === 'kill-pane')
            .map((args) => args[2]);
        expect(killPaneTargets).toEqual(['%11']);
        expect(mocked.execCalls.some((args) => args[0] === 'kill-session')).toBe(false);
        expect(mocked.execCalls.some((args) => args[0] === 'kill-window')).toBe(false);
    });
    it('kills an owned team window when session owns that window', async () => {
        await killTeamSession('leader-session:3', ['%10', '%11'], '%10', { sessionMode: 'dedicated-window' });
        expect(mocked.execCalls.some((args) => args[0] === 'kill-window' && args.includes('leader-session:3'))).toBe(true);
        expect(mocked.execCalls.some((args) => args[0] === 'kill-pane')).toBe(false);
    });
    it('discovers additional split-pane worker panes from the recorded team target', async () => {
        mocked.listedPanes = '%10\n%11\n%12\n';
        const paneIds = await resolveSplitPaneWorkerPaneIds('leader-session:0', ['%11'], '%10');
        expect(paneIds).toEqual(['%11', '%12']);
        expect(mocked.execCalls.some((args) => args[0] === 'list-panes' && args.includes('leader-session:0'))).toBe(true);
    });
});
//# sourceMappingURL=tmux-session.kill-team-session.test.js.map
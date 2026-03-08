import { afterEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
    execFileCalls: [],
    currentSession: 'leader-session',
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const run = (args) => {
        mocked.execFileCalls.push(args);
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
            return { stdout: `${mocked.currentSession}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    const execFileMock = vi.fn((_cmd, args, cb) => {
        const out = run(args);
        cb(null, out.stdout, out.stderr);
        return {};
    });
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    execFileMock[promisifyCustom] =
        async (_cmd, args) => run(args);
    return {
        ...actual,
        execFile: execFileMock,
    };
});
import { killTeamSession } from '../tmux-session.js';
describe('killTeamSession safeguards', () => {
    afterEach(() => {
        mocked.execFileCalls = [];
        mocked.currentSession = 'leader-session';
        vi.unstubAllEnvs();
    });
    it('does not kill the current attached session by default', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        mocked.currentSession = 'leader-session';
        await killTeamSession('leader-session');
        expect(mocked.execFileCalls.some((args) => args[0] === 'kill-session')).toBe(false);
    });
    it('kills a different detached session', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,1');
        mocked.currentSession = 'leader-session';
        await killTeamSession('worker-detached-session');
        expect(mocked.execFileCalls.some((args) => args[0] === 'kill-session' && args.includes('worker-detached-session'))).toBe(true);
    });
    it('kills only worker panes in split-pane mode', async () => {
        await killTeamSession('leader-session:0', ['%10', '%11'], '%10');
        const killPaneTargets = mocked.execFileCalls
            .filter((args) => args[0] === 'kill-pane')
            .map((args) => args[2]);
        expect(killPaneTargets).toEqual(['%11']);
        expect(mocked.execFileCalls.some((args) => args[0] === 'kill-session')).toBe(false);
        expect(mocked.execFileCalls.some((args) => args[0] === 'kill-window')).toBe(false);
    });
    it('kills an owned team window when session owns that window', async () => {
        await killTeamSession('leader-session:3', ['%10', '%11'], '%10', { sessionMode: 'dedicated-window' });
        expect(mocked.execFileCalls.some((args) => args[0] === 'kill-window' && args.includes('leader-session:3'))).toBe(true);
        expect(mocked.execFileCalls.some((args) => args[0] === 'kill-pane')).toBe(false);
    });
});
//# sourceMappingURL=tmux-session.kill-team-session.test.js.map
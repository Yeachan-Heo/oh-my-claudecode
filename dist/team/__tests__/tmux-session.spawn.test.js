import { beforeEach, describe, expect, it, vi } from 'vitest';
const mockedCalls = vi.hoisted(() => ({
    tmuxArgs: [],
    cmuxArgs: [],
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const execFileMock = vi.fn((_cmd, args, cb) => {
        mockedCalls.cmuxArgs.push(args);
        cb(null, '', '');
        return {};
    });
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    execFileMock[promisifyCustom] = async (_cmd, args) => {
        mockedCalls.cmuxArgs.push(args);
        return { stdout: '', stderr: '' };
    };
    return {
        ...actual,
        execFile: execFileMock,
    };
});
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExec: vi.fn((args) => {
            mockedCalls.tmuxArgs.push(args);
            return '';
        }),
        tmuxExecAsync: vi.fn(async (args) => {
            mockedCalls.tmuxArgs.push(args);
            return { stdout: '', stderr: '' };
        }),
    };
});
import { sendTeamPaneKey, spawnBridgeInSession, spawnWorkerInPane } from '../tmux-session.js';
describe('spawnWorkerInPane', () => {
    beforeEach(() => {
        mockedCalls.tmuxArgs = [];
        mockedCalls.cmuxArgs = [];
        vi.unstubAllEnvs();
    });
    it('uses argv-style launch with literal tmux send-keys', async () => {
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto', '--model', 'gpt-5;touch /tmp/pwn'],
            cwd: '/tmp',
        });
        const literalSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.includes('-l'));
        expect(literalSend).toBeDefined();
        const launchLine = literalSend?.[literalSend.length - 1] ?? '';
        expect(launchLine).toContain('exec "$@"');
        expect(launchLine).toContain("'--'");
        expect(launchLine).toContain("'gpt-5;touch /tmp/pwn'");
        expect(launchLine).not.toContain('exec codex --full-auto');
    });
    it('sends cmux worker command text and submits with send-key', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        await spawnWorkerInPane('cmux:workspace-1', 'cmux-worker-1', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        });
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys')).toBe(false);
        expect(mockedCalls.cmuxArgs).toHaveLength(2);
        expect(mockedCalls.cmuxArgs[0]).toEqual(expect.arrayContaining(['send', '--surface', 'cmux-worker-1']));
        expect(mockedCalls.cmuxArgs[0]?.[0]).toBe('send');
        expect(mockedCalls.cmuxArgs[0]?.at(-1)).toContain('exec "$@"');
        expect(mockedCalls.cmuxArgs[1]).toEqual(['send-key', '--surface', 'cmux-worker-1', 'Enter']);
    });
    it('uses cmux send-key semantics for Enter and control keys', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        await sendTeamPaneKey('cmux-worker-1', 'Enter');
        await sendTeamPaneKey('cmux-worker-1', 'Tab');
        await sendTeamPaneKey('cmux-worker-1', 'C-m');
        await sendTeamPaneKey('cmux-worker-1', 'C-u');
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys')).toBe(false);
        expect(mockedCalls.cmuxArgs).toEqual([
            ['send-key', '--surface', 'cmux-worker-1', 'Enter'],
            ['send-key', '--surface', 'cmux-worker-1', 'Tab'],
            ['send-key', '--surface', 'cmux-worker-1', 'C-m'],
            ['send-key', '--surface', 'cmux-worker-1', 'C-u'],
        ]);
    });
    it('uses current JS runtime when launching bridge-entry helpers', () => {
        spawnBridgeInSession('session:0', '/tmp/bridge-entry.js', '/tmp/bridge-config.json');
        const sendKeys = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys');
        expect(sendKeys).toBeDefined();
        const launchLine = sendKeys?.[3] ?? '';
        expect(launchLine).toContain(process.execPath);
        expect(launchLine).toContain('/tmp/bridge-entry.js');
        expect(launchLine).toContain('--config');
        expect(launchLine).not.toMatch(/^node\s/);
    });
    it('rejects invalid team names before command construction', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'Bad-Team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'Bad-Team' },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow('Invalid team name');
    });
    it('rejects invalid environment keys', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { 'BAD-KEY': 'x' },
            launchBinary: 'codex',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid environment key');
    });
    it('rejects unsafe launchBinary values', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'safe-team' },
            launchBinary: 'codex;touch /tmp/pwn',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid launchBinary');
    });
});
//# sourceMappingURL=tmux-session.spawn.test.js.map
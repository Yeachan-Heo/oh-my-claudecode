import { describe, expect, it, vi, beforeEach } from 'vitest';
const tmuxMocks = vi.hoisted(() => ({
    tmuxCmdAsync: vi.fn(),
}));
vi.mock('../../cli/tmux-utils.js', () => ({
    tmuxExec: vi.fn(),
    tmuxExecAsync: vi.fn(),
    tmuxShell: vi.fn(),
    tmuxCmdAsync: tmuxMocks.tmuxCmdAsync,
}));
import { getOwnedWorkerLiveness, getWorkerLiveness, } from '../tmux-session.js';
const supportsStrictTmuxFixture = process.platform === 'darwin' || process.platform === 'linux';
const fixtureServerIdentity = supportsStrictTmuxFixture ? {
    socket_path: '/tmp/omc-liveness-test.sock',
    server_pid: 4242,
    process_started_at: process.platform === 'darwin'
        ? 'darwin:1700000000:123456'
        : 'linux:fixture:424242',
} : undefined;
function fixtureOwnership() {
    if (!fixtureServerIdentity)
        throw new Error('strict tmux fixture unsupported on this platform');
    return {
        provider: 'tmux',
        providerTarget: 'omc-team-liveness:0',
        paneId: '%1',
        splitTarget: '%0',
        leaderPaneId: '%0',
        reservedPaneIds: [],
        source: 'adopted',
        tmuxServerIdentity: fixtureServerIdentity,
    };
}
function matchingServerDependencies() {
    if (!fixtureServerIdentity)
        throw new Error('strict tmux fixture unsupported on this platform');
    return {
        tmuxQuery: vi.fn(async () => ({
            stdout: `${fixtureServerIdentity.server_pid}\n`,
            stderr: '',
        })),
        processIdentity: vi.fn(() => fixtureServerIdentity.process_started_at),
        processObservation: vi.fn(() => 'matching'),
    };
}
describe('getWorkerLiveness', () => {
    beforeEach(() => {
        tmuxMocks.tmuxCmdAsync.mockReset();
    });
    it('returns alive when tmux reports pane_dead=0', async () => {
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '0\n', stderr: '' });
        await expect(getWorkerLiveness('%1')).resolves.toBe('alive');
    });
    it('returns dead when tmux reports pane_dead=1', async () => {
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '1\n', stderr: '' });
        await expect(getWorkerLiveness('%1')).resolves.toBe('dead');
    });
    it.each(['', '\n', 'garbage\n', '0\n1\n'])('keeps malformed pane_dead output unknown: %j', async (stdout) => {
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout, stderr: '' });
        await expect(getWorkerLiveness('%1')).resolves.toBe('unknown');
    });
    it('treats missing pane errors as dead after successful cleanup kills', async () => {
        const error = new Error('display-message failed');
        error.stderr = "can't find pane: %1";
        tmuxMocks.tmuxCmdAsync.mockRejectedValueOnce(error);
        await expect(getWorkerLiveness('%1')).resolves.toBe('dead');
    });
    it('keeps ambiguous tmux failures unknown', async () => {
        const error = new Error('tmux server unavailable');
        error.stderr = 'error connecting to /tmp/tmux-1000/default (No such file or directory)';
        tmuxMocks.tmuxCmdAsync.mockRejectedValueOnce(error);
        await expect(getWorkerLiveness('%1')).resolves.toBe('unknown');
    });
    it.skipIf(!supportsStrictTmuxFixture)('revalidates the owned server before accepting a missing pane in stderr', async () => {
        const dependencies = matchingServerDependencies();
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({
            stdout: '',
            stderr: "can't find pane: %1",
        });
        await expect(getOwnedWorkerLiveness(fixtureOwnership(), dependencies)).resolves.toBe('dead');
        expect(dependencies.tmuxQuery).toHaveBeenCalled();
    });
    it.skipIf(!supportsStrictTmuxFixture)('checks a blank pane state against the identity-bound inventory', async () => {
        const dependencies = matchingServerDependencies();
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '\n', stderr: '' });
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '%1 0\n', stderr: '' });
        await expect(getOwnedWorkerLiveness(fixtureOwnership(), dependencies)).resolves.toBe('alive');
    });
    it.skipIf(!supportsStrictTmuxFixture)('proves a blank pane state dead when complete inventory omits that pane', async () => {
        const dependencies = matchingServerDependencies();
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '\n', stderr: '' });
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '%2 0\n', stderr: '' });
        await expect(getOwnedWorkerLiveness(fixtureOwnership(), dependencies)).resolves.toBe('dead');
    });
    it.skipIf(!supportsStrictTmuxFixture)('keeps empty or malformed blank-state inventories unknown', async () => {
        for (const inventoryOutput of ['', 'malformed\n']) {
            const dependencies = matchingServerDependencies();
            tmuxMocks.tmuxCmdAsync.mockReset();
            tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '\n', stderr: '' });
            tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: inventoryOutput, stderr: '' });
            await expect(getOwnedWorkerLiveness(fixtureOwnership(), dependencies)).resolves.toBe('unknown');
        }
    });
    it.skipIf(!supportsStrictTmuxFixture)('accepts original server death observed during the pane query', async () => {
        const dependencies = matchingServerDependencies();
        const processObservation = dependencies.processObservation;
        processObservation
            .mockReturnValueOnce('matching')
            .mockReturnValueOnce('dead');
        const error = new Error('tmux server exited');
        error.stderr = 'server exited';
        tmuxMocks.tmuxCmdAsync.mockRejectedValueOnce(error);
        await expect(getOwnedWorkerLiveness(fixtureOwnership(), dependencies)).resolves.toBe('dead');
        expect(dependencies.tmuxQuery).toHaveBeenCalledTimes(1);
    });
    it.skipIf(!supportsStrictTmuxFixture)('boundedly rechecks a server that dies before the pane observation', async () => {
        const dependencies = matchingServerDependencies();
        const processObservation = dependencies.processObservation;
        processObservation
            .mockReturnValueOnce('matching')
            .mockReturnValueOnce('dead');
        const serverQuery = dependencies.tmuxQuery;
        serverQuery.mockRejectedValueOnce(new Error('server exited during shutdown'));
        await expect(getOwnedWorkerLiveness(fixtureOwnership(), dependencies)).resolves.toBe('dead');
        expect(dependencies.tmuxQuery).toHaveBeenCalledTimes(1);
        expect(tmuxMocks.tmuxCmdAsync).not.toHaveBeenCalled();
    });
    it.skipIf(!supportsStrictTmuxFixture)('keeps a replacement server mismatch unknown without retrying the server query', async () => {
        const dependencies = matchingServerDependencies();
        const processIdentity = dependencies.processIdentity;
        processIdentity
            .mockReturnValueOnce(fixtureServerIdentity.process_started_at)
            .mockReturnValue('linux:replacement:999999');
        tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({
            stdout: '',
            stderr: "can't find pane: %1",
        });
        await expect(getOwnedWorkerLiveness(fixtureOwnership(), dependencies)).resolves.toBe('unknown');
        expect(dependencies.tmuxQuery).toHaveBeenCalledTimes(2);
    });
});
//# sourceMappingURL=tmux-session-liveness.test.js.map
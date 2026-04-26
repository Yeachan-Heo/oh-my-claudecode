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
import { getWorkerLiveness } from '../tmux-session.js';
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
});
//# sourceMappingURL=tmux-session-liveness.test.js.map
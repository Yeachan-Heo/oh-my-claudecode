import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const mocks = vi.hoisted(() => ({
    sendToWorker: vi.fn(),
}));
vi.mock('../tmux-session.js', async () => {
    const actual = await vi.importActual('../tmux-session.js');
    return {
        ...actual,
        sendToWorker: mocks.sendToWorker,
    };
});
describe('assignTask trigger delivery', () => {
    beforeEach(() => {
        mocks.sendToWorker.mockReset();
    });
    it('rolls task assignment back when tmux trigger cannot be delivered', async () => {
        const { assignTask } = await import('../runtime.js');
        const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-assign-'));
        const teamName = 'assign-team';
        const root = join(cwd, '.omc', 'state', 'team', teamName);
        mkdirSync(join(root, 'tasks'), { recursive: true });
        writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({
            id: '1',
            subject: 's',
            description: 'd',
            status: 'pending',
            owner: null,
            createdAt: new Date().toISOString(),
        }), 'utf-8');
        mocks.sendToWorker.mockResolvedValue(false);
        await expect(assignTask(teamName, '1', 'worker-1', '%1', 'session:0', cwd))
            .rejects.toThrow('worker_notify_failed:worker-1:new-task:1');
        const task = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf-8'));
        expect(task.status).toBe('pending');
        expect(task.owner).toBeNull();
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(6);
        rmSync(cwd, { recursive: true, force: true });
    });
});
//# sourceMappingURL=runtime-assign.test.js.map
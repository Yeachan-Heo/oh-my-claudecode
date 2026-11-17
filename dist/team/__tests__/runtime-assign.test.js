import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    let previousHome;
    let previousUserProfile;
    let previousStateDir;
    beforeEach(() => {
        mocks.sendToWorker.mockReset();
    });
    afterEach(() => {
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        if (previousStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = previousStateDir;
    });
    it('rolls task assignment back when tmux trigger cannot be delivered', async () => {
        const { assignTask } = await import('../runtime.js');
        const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-assign-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        previousStateDir = process.env.OMC_STATE_DIR;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        delete process.env.OMC_STATE_DIR;
        const teamName = 'assign-team';
        const root = join(cwd, '.omc', 'state', 'team', teamName);
        mkdirSync(join(root, 'tasks'), { recursive: true });
        writeFileSync(join(root, 'tasks', 'task-1.json'), JSON.stringify({
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
        const task = JSON.parse(readFileSync(join(root, 'tasks', 'task-1.json'), 'utf-8'));
        expect(task.status).toBe('pending');
        expect(task.owner).toBeNull();
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(6);
        rmSync(cwd, { recursive: true, force: true });
    });
    it('instructs the worker to use the canonical task file that was updated', async () => {
        const { assignTask } = await import('../runtime.js');
        const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-assign-success-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        const root = join(cwd, '.omc', 'state', 'team', 'assign-team');
        mkdirSync(join(root, 'tasks'), { recursive: true });
        writeFileSync(join(root, 'tasks', 'task-1.json'), JSON.stringify({
            id: '1',
            subject: 's',
            description: 'd',
            status: 'pending',
            owner: null,
            createdAt: new Date().toISOString(),
        }), 'utf-8');
        mocks.sendToWorker.mockResolvedValue(true);
        await assignTask('assign-team', '1', 'worker-1', '%1', 'session:0', cwd);
        const inbox = readFileSync(join(root, 'workers', 'worker-1', 'inbox.md'), 'utf-8');
        expect(inbox).toContain(join(root, 'tasks', 'task-1.json'));
        const task = JSON.parse(readFileSync(join(root, 'tasks', 'task-1.json'), 'utf-8'));
        expect(task).toMatchObject({ status: 'in_progress', owner: 'worker-1' });
        rmSync(cwd, { recursive: true, force: true });
    });
});
//# sourceMappingURL=runtime-assign.test.js.map
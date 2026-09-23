import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { findNextTask } from '../task-file-ops.js';
/**
 * The old done.json polling protocol is intentionally retired. Completion and
 * recovery now cross the durable task primitive boundary, so these tests only
 * protect terminal-task and transferred-task ownership invariants.
 */
describe('task completion and recovery ownership boundary', () => {
    let cwd;
    let previousHome;
    let previousUserProfile;
    let previousStateDir;
    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), 'runtime-task-recovery-boundary-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        previousStateDir = process.env.OMC_STATE_DIR;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        delete process.env.OMC_STATE_DIR;
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
        rmSync(cwd, { recursive: true, force: true });
    });
    it('does not select or rewrite an already-terminal task', async () => {
        const teamName = 'terminal-task-preservation';
        const taskPath = writeTask(cwd, teamName, {
            status: 'completed',
            owner: 'worker-1',
            metadata: { summary: 'completed by the original worker' },
        });
        const original = readFileSync(taskPath, 'utf8');
        expect(await findNextTask(teamName, 'replacement-worker', { cwd })).toBeNull();
        expect(readFileSync(taskPath, 'utf8')).toBe(original);
    });
    it('does not steal a pending task transferred to another worker', async () => {
        const teamName = 'transferred-task-preservation';
        const taskPath = writeTask(cwd, teamName, {
            status: 'pending',
            owner: 'worker-2',
            metadata: { transferredFrom: 'worker-1' },
        });
        const original = readFileSync(taskPath, 'utf8');
        expect(await findNextTask(teamName, 'replacement-worker', { cwd })).toBeNull();
        expect(readFileSync(taskPath, 'utf8')).toBe(original);
        const claimed = await findNextTask(teamName, 'worker-2', { cwd });
        expect(claimed).toMatchObject({ id: '1', owner: 'worker-2', status: 'in_progress' });
        expect(readFileSync(taskPath, 'utf8')).not.toBe(original);
    });
});
function writeTask(cwd, teamName, overrides) {
    const tasksDir = join(getOmcRoot(cwd), 'state', 'team', teamName, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const task = {
        id: '1',
        subject: 'Task 1',
        description: 'Continue the task safely',
        status: 'pending',
        owner: 'worker-1',
        blocks: [],
        blockedBy: [],
        ...overrides,
    };
    const taskPath = join(tasksDir, 'task-1.json');
    writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf8');
    return taskPath;
}
//# sourceMappingURL=runtime-done-recovery.test.js.map
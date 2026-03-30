import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
// ---------------------------------------------------------------------------
// BUG 3: team-ops teamCreateTask must use locking for task ID generation
// ---------------------------------------------------------------------------
describe('team-ops teamCreateTask locking', () => {
    let tempDir;
    const teamName = 'lock-test-team';
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'team-ops-lock-test-'));
        // Set up minimal team config
        const root = join(tempDir, '.omc', 'state', 'team', teamName);
        mkdirSync(join(root, 'tasks'), { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'test',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            tmux_session: 'test-session',
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            next_task_id: 1,
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        }));
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('teamCreateTask source uses locking around task creation', () => {
        const { readFileSync } = require('fs');
        const sourcePath = join(__dirname, '..', 'team', 'team-ops.ts');
        const source = readFileSync(sourcePath, 'utf-8');
        // Extract the teamCreateTask function
        const fnStart = source.indexOf('export async function teamCreateTask');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, fnStart + 2000);
        // Must use locking (either withLock or withFileLockSync)
        expect(fnBody).toContain('withLock');
        expect(fnBody).toContain('lock-create-task');
    });
    it('two sequential task creations produce different IDs', async () => {
        const { teamCreateTask } = await import('../team/team-ops.js');
        const task1 = await teamCreateTask(teamName, { subject: 'Task A', description: 'first', status: 'pending' }, tempDir);
        const task2 = await teamCreateTask(teamName, { subject: 'Task B', description: 'second', status: 'pending' }, tempDir);
        expect(task1.id).not.toBe(task2.id);
        expect(Number(task1.id)).toBeLessThan(Number(task2.id));
    });
    it('concurrent task creations produce different IDs', async () => {
        const { teamCreateTask } = await import('../team/team-ops.js');
        const results = await Promise.all([
            teamCreateTask(teamName, { subject: 'Task 1', description: 'c1', status: 'pending' }, tempDir),
            teamCreateTask(teamName, { subject: 'Task 2', description: 'c2', status: 'pending' }, tempDir),
            teamCreateTask(teamName, { subject: 'Task 3', description: 'c3', status: 'pending' }, tempDir),
        ]);
        const ids = results.map(t => t.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(3);
    });
});
//# sourceMappingURL=team-ops-task-locking.test.js.map
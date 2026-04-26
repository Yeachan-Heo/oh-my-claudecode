import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeTeamApiOperation } from '../api-interop.js';
describe('team api working-directory resolution', () => {
    let cwd;
    const teamName = 'resolution-team';
    async function seedTeamState() {
        const base = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(join(base, 'tasks'), { recursive: true });
        await mkdir(join(base, 'mailbox'), { recursive: true });
        await writeFile(join(base, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'resolution test',
            agent_type: 'claude',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: '2026-03-06T00:00:00.000Z',
            next_task_id: 2,
            team_state_root: base,
        }, null, 2));
        await writeFile(join(base, 'tasks', 'task-1.json'), JSON.stringify({
            id: '1',
            subject: 'Resolution test task',
            description: 'Ensure API finds the real team root',
            status: 'pending',
            owner: null,
            created_at: '2026-03-06T00:00:00.000Z',
            version: 1,
        }, null, 2));
        return base;
    }
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-team-api-resolution-'));
    });
    afterEach(async () => {
        delete process.env.OMC_TEAM_STATE_ROOT;
        await rm(cwd, { recursive: true, force: true });
    });
    it('resolves workspace cwd from a team-specific config.team_state_root', async () => {
        await seedTeamState();
        const readResult = await executeTeamApiOperation('read-task', {
            team_name: teamName,
            task_id: '1',
        }, cwd);
        expect(readResult.ok).toBe(true);
        if (!readResult.ok)
            return;
        expect(readResult.data.task?.id).toBe('1');
        const claimResult = await executeTeamApiOperation('claim-task', {
            team_name: teamName,
            task_id: '1',
            worker: 'worker-1',
        }, cwd);
        expect(claimResult.ok).toBe(true);
        if (!claimResult.ok)
            return;
        expect(typeof claimResult.data.claimToken).toBe('string');
    });
    it('resolves workspace cwd from OMC_TEAM_STATE_ROOT when it points at a team-specific root', async () => {
        const teamStateRoot = await seedTeamState();
        process.env.OMC_TEAM_STATE_ROOT = teamStateRoot;
        const nestedCwd = join(cwd, 'nested', 'worker');
        await mkdir(nestedCwd, { recursive: true });
        const claimResult = await executeTeamApiOperation('claim-task', {
            team_name: teamName,
            task_id: '1',
            worker: 'worker-1',
        }, nestedCwd);
        expect(claimResult.ok).toBe(true);
        if (!claimResult.ok)
            return;
        expect(typeof claimResult.data.claimToken).toBe('string');
    });
    it('claims tasks using config workers even when manifest workers are stale', async () => {
        const teamStateRoot = await seedTeamState();
        await writeFile(join(teamStateRoot, 'manifest.json'), JSON.stringify({
            schema_version: 2,
            name: teamName,
            task: 'resolution test',
            worker_count: 0,
            workers: [],
            created_at: '2026-03-06T00:00:00.000Z',
            team_state_root: teamStateRoot,
        }, null, 2));
        const claimResult = await executeTeamApiOperation('claim-task', {
            team_name: teamName,
            task_id: '1',
            worker: 'worker-1',
        }, cwd);
        expect(claimResult.ok).toBe(true);
        if (!claimResult.ok)
            return;
        expect(claimResult.data.ok).toBe(true);
        expect(typeof claimResult.data.claimToken).toBe('string');
    });
});
//# sourceMappingURL=api-interop.cwd-resolution.test.js.map
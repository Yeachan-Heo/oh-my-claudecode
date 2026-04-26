import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeTeamApiOperation } from '../api-interop.js';
// Step 1.1: lifecycle_profile type compilation tests
describe('lifecycle_profile type field', () => {
    it('TeamConfig accepts lifecycle_profile as optional field', () => {
        const config = {
            lifecycle_profile: 'default',
        };
        expect(config.lifecycle_profile).toBe('default');
    });
    it('TeamConfig accepts linked_ralph lifecycle_profile', () => {
        const config = {
            lifecycle_profile: 'linked_ralph',
        };
        expect(config.lifecycle_profile).toBe('linked_ralph');
    });
    it('TeamConfig allows lifecycle_profile to be undefined', () => {
        const config = {};
        expect(config.lifecycle_profile).toBeUndefined();
    });
    it('TeamManifestV2 accepts lifecycle_profile as optional field', () => {
        const manifest = {
            lifecycle_profile: 'default',
        };
        expect(manifest.lifecycle_profile).toBe('default');
    });
    it('TeamManifestV2 accepts linked_ralph lifecycle_profile', () => {
        const manifest = {
            lifecycle_profile: 'linked_ralph',
        };
        expect(manifest.lifecycle_profile).toBe('linked_ralph');
    });
    it('TeamManifestV2 allows lifecycle_profile to be undefined', () => {
        const manifest = {};
        expect(manifest.lifecycle_profile).toBeUndefined();
    });
});
// Step 1.2: state root resolution priority tests
describe('state root resolution priority: config > manifest > cwd-walk', () => {
    let cwd;
    const teamName = 'priority-test-team';
    async function seedBase() {
        const base = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(join(base, 'tasks'), { recursive: true });
        await mkdir(join(base, 'mailbox'), { recursive: true });
        await writeFile(join(base, 'tasks', 'task-1.json'), JSON.stringify({
            id: '1',
            subject: 'Priority test task',
            description: 'Tests state root resolution priority',
            status: 'pending',
            owner: null,
            created_at: '2026-03-15T00:00:00.000Z',
            version: 1,
        }, null, 2));
        return base;
    }
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-phase1-priority-'));
    });
    afterEach(async () => {
        delete process.env.OMC_TEAM_STATE_ROOT;
        await rm(cwd, { recursive: true, force: true });
    });
    it('uses config.team_state_root when only config is present', async () => {
        const base = await seedBase();
        await writeFile(join(base, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'test',
            agent_type: 'claude',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: '2026-03-15T00:00:00.000Z',
            next_task_id: 2,
            team_state_root: base,
        }, null, 2));
        const result = await executeTeamApiOperation('read-task', {
            team_name: teamName,
            task_id: '1',
        }, cwd);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.task?.id).toBe('1');
        }
    });
    it('uses config.team_state_root over manifest.team_state_root when both present', async () => {
        const base = await seedBase();
        // Create a separate "wrong" directory that manifest points to
        const wrongRoot = join(cwd, 'wrong-root', '.omc', 'state', 'team', teamName);
        await mkdir(join(wrongRoot, 'tasks'), { recursive: true });
        await mkdir(join(wrongRoot, 'mailbox'), { recursive: true });
        // Manifest points to wrong root
        await writeFile(join(base, 'manifest.v2.json'), JSON.stringify({
            schema_version: 2,
            name: teamName,
            task: 'test',
            team_state_root: wrongRoot,
        }, null, 2));
        // Config points to correct root (base)
        await writeFile(join(base, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'test',
            agent_type: 'claude',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: '2026-03-15T00:00:00.000Z',
            next_task_id: 2,
            team_state_root: base,
        }, null, 2));
        const result = await executeTeamApiOperation('read-task', {
            team_name: teamName,
            task_id: '1',
        }, cwd);
        // Should succeed using config's root (which has task-1.json), not manifest's wrong root
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.task?.id).toBe('1');
        }
    });
    it('env OMC_TEAM_STATE_ROOT takes precedence over config.team_state_root', async () => {
        const base = await seedBase();
        await writeFile(join(base, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'test',
            agent_type: 'claude',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: '2026-03-15T00:00:00.000Z',
            next_task_id: 2,
            team_state_root: base,
        }, null, 2));
        // Set env to the correct team state root
        process.env.OMC_TEAM_STATE_ROOT = base;
        const nestedCwd = join(cwd, 'nested', 'deep', 'worker');
        await mkdir(nestedCwd, { recursive: true });
        const result = await executeTeamApiOperation('read-task', {
            team_name: teamName,
            task_id: '1',
        }, nestedCwd);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.task?.id).toBe('1');
        }
    });
});
//# sourceMappingURL=phase1-foundation.test.js.map
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const { shutdownTeamV2Mock, shutdownTeamMock } = vi.hoisted(() => ({
    shutdownTeamV2Mock: vi.fn(async () => { }),
    shutdownTeamMock: vi.fn(async () => { }),
}));
vi.mock('../runtime-v2.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        shutdownTeamV2: shutdownTeamV2Mock,
    };
});
vi.mock('../runtime.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        shutdownTeam: shutdownTeamMock,
    };
});
import { executeTeamApiOperation } from '../api-interop.js';
async function writeJson(cwd, relativePath, value) {
    const fullPath = join(cwd, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}
async function writeText(cwd, relativePath, value) {
    const fullPath = join(cwd, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, value, 'utf-8');
}
async function expectCleanupBlockedAndStatePreserved(cwd, teamName, evidencePath) {
    const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
    const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);
    expect(result.ok).toBe(false);
    if (result.ok)
        throw new Error('expected cleanup to be blocked');
    expect(result.error.code).toBe('operation_failed');
    expect(result.error.message).toContain('cleanup_blocked:worktree_cleanup_evidence_present');
    await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
    await expect(readFile(evidencePath, 'utf-8')).resolves.toBeTruthy();
    expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
    expect(shutdownTeamMock).not.toHaveBeenCalled();
}
describe('team api cleanup', () => {
    let cwd = '';
    afterEach(async () => {
        shutdownTeamV2Mock.mockClear();
        shutdownTeamMock.mockClear();
        if (cwd) {
            await rm(cwd, { recursive: true, force: true });
            cwd = '';
        }
    });
    it('routes cleanup through runtime-v2 shutdown when a v2 team config exists', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-v2-'));
        const teamName = 'cleanup-v2';
        await writeJson(cwd, `.omc/state/team/${teamName}/config.json`, {
            name: teamName,
            task: 'test',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            governance: {
                delegation_only: false,
                plan_approval_required: false,
                nested_teams_allowed: false,
                one_team_per_leader_session: true,
                cleanup_requires_all_workers_inactive: true,
            },
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: '',
            next_task_id: 1,
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);
        expect(result).toEqual({ ok: true, operation: 'cleanup', data: { team_name: teamName } });
        expect(shutdownTeamV2Mock).toHaveBeenCalledWith(teamName, cwd);
        expect(shutdownTeamMock).not.toHaveBeenCalled();
    });
    it('surfaces shutdown gate failures instead of deleting team state directly', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-gated-'));
        const teamName = 'cleanup-gated';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        await writeJson(cwd, `.omc/state/team/${teamName}/config.json`, {
            name: teamName,
            task: 'test',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            governance: {
                delegation_only: false,
                plan_approval_required: false,
                nested_teams_allowed: false,
                one_team_per_leader_session: true,
                cleanup_requires_all_workers_inactive: true,
            },
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: '',
            next_task_id: 2,
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        await writeJson(cwd, `.omc/state/team/${teamName}/tasks/task-1.json`, {
            id: '1',
            subject: 'pending work',
            description: 'still pending',
            status: 'pending',
            created_at: new Date().toISOString(),
        });
        shutdownTeamV2Mock.mockImplementationOnce(async () => {
            throw new Error('shutdown_gate_blocked:pending=1,blocked=0,in_progress=0,failed=0');
        });
        const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);
        expect(result.ok).toBe(false);
        if (result.ok)
            throw new Error('expected failure');
        expect(result.error.code).toBe('operation_failed');
        expect(result.error.message).toContain('shutdown_gate_blocked');
        await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).resolves.toContain(teamName);
        expect(shutdownTeamV2Mock).toHaveBeenCalledWith(teamName, cwd);
    });
    it('falls back to raw cleanup when no config or native worktree evidence exists', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-orphan-'));
        const teamName = 'cleanup-orphan';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(join(teamRoot, 'tasks'), { recursive: true });
        await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
        const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);
        expect(result).toEqual({ ok: true, operation: 'cleanup', data: { team_name: teamName } });
        await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
        expect(shutdownTeamMock).not.toHaveBeenCalled();
    });
    it('blocks orphan-cleanup when worktree recovery evidence exists without explicit acknowledgement', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-orphan-cleanup-guard-'));
        const teamName = 'orphan-cleanup-guard';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
        const backupPath = join(teamRoot, 'workers', 'worker-1', 'worktree-root-agents.json');
        await writeJson(cwd, `.omc/state/team/${teamName}/workers/worker-1/worktree-root-agents.json`, {
            worktreePath: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
            hadOriginal: false,
            installedContent: 'worker overlay',
            installedAt: new Date().toISOString(),
        });
        const result = await executeTeamApiOperation('orphan-cleanup', { team_name: teamName }, cwd);
        expect(result.ok).toBe(false);
        if (result.ok)
            throw new Error('expected orphan-cleanup to be blocked');
        expect(result.error.code).toBe('invalid_input');
        expect(result.error.message).toContain('orphan_cleanup_blocked:worktree_recovery_evidence_present');
        await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
        await expect(readFile(backupPath, 'utf-8')).resolves.toBeTruthy();
        expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
        expect(shutdownTeamMock).not.toHaveBeenCalled();
    });
    it('allows acknowledged orphan-cleanup to remove team state despite worktree recovery evidence', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-orphan-cleanup-ack-'));
        const teamName = 'orphan-cleanup-ack';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
        await writeJson(cwd, `.omc/state/team/${teamName}/workers/worker-1/worktree-root-agents.json`, {
            worktreePath: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
            hadOriginal: false,
            installedContent: 'worker overlay',
            installedAt: new Date().toISOString(),
        });
        const result = await executeTeamApiOperation('orphan-cleanup', {
            team_name: teamName,
            acknowledge_lost_worktree_recovery: true,
        }, cwd);
        expect(result).toEqual({ ok: true, operation: 'orphan-cleanup', data: { team_name: teamName } });
        await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
        expect(shutdownTeamMock).not.toHaveBeenCalled();
    });
    it('blocks no-config cleanup when worktree metadata is unreadable', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-corrupt-worktrees-'));
        const teamName = 'cleanup-corrupt-worktrees';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
        const metadataPath = join(teamRoot, 'worktrees.json');
        await writeFile(metadataPath, '{not-json', 'utf-8');
        await expectCleanupBlockedAndStatePreserved(cwd, teamName, metadataPath);
    });
    it('blocks no-config cleanup when only a root AGENTS backup remains', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-backup-only-'));
        const teamName = 'cleanup-backup-only';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
        const backupPath = join(teamRoot, 'workers', 'worker-1', 'worktree-root-agents.json');
        await writeJson(cwd, `.omc/state/team/${teamName}/workers/worker-1/worktree-root-agents.json`, {
            worktreePath: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
            hadOriginal: true,
            originalContent: 'root agents',
            installedContent: 'worker overlay',
            installedAt: new Date().toISOString(),
        });
        await expectCleanupBlockedAndStatePreserved(cwd, teamName, backupPath);
    });
    it('blocks corrupt-config cleanup when native worktree recovery evidence exists', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-corrupt-config-'));
        const teamName = 'cleanup-corrupt-config';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
        await writeText(cwd, `.omc/state/team/${teamName}/config.json`, '{bad-config');
        const metadataPath = join(teamRoot, 'worktrees.json');
        await writeJson(cwd, `.omc/state/team/${teamName}/worktrees.json`, [{
                workerName: 'worker-1',
                path: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
                branch: `omc/${teamName}/worker-1`,
                createdAt: new Date().toISOString(),
            }]);
        await expectCleanupBlockedAndStatePreserved(cwd, teamName, metadataPath);
    });
});
//# sourceMappingURL=api-interop.cleanup.test.js.map
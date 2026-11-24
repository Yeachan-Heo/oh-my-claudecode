import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { monitorTeam, resumeTeam, startTeam } from '../runtime.js';
describe('runtime types', () => {
    it('TeamConfig has required fields', () => {
        const config = {
            teamName: 'test',
            workerCount: 2,
            agentTypes: ['codex', 'gemini'],
            tasks: [{ subject: 'Task 1', description: 'Do something' }],
            cwd: '/tmp',
        };
        expect(config.teamName).toBe('test');
        expect(config.workerCount).toBe(2);
    });
    it('monitorTeam returns performance telemetry', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-monitor-'));
        const previousHome = process.env.HOME;
        const previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = cwd;
        process.env.USERPROFILE = cwd;
        const teamName = 'monitor-team';
        const tasksDir = join(cwd, '.omc', 'state', 'team', teamName, 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, 'task-1.json'), JSON.stringify({ status: 'pending' }), 'utf-8');
        writeFileSync(join(tasksDir, 'task-2.json'), JSON.stringify({ status: 'completed' }), 'utf-8');
        const snapshot = await monitorTeam(teamName, cwd, []);
        expect(snapshot.taskCounts.pending).toBe(1);
        expect(snapshot.taskCounts.completed).toBe(1);
        expect(snapshot.monitorPerformance.listTasksMs).toBeGreaterThanOrEqual(0);
        expect(snapshot.monitorPerformance.workerScanMs).toBeGreaterThanOrEqual(0);
        expect(snapshot.monitorPerformance.totalMs).toBeGreaterThanOrEqual(snapshot.monitorPerformance.listTasksMs);
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        rmSync(cwd, { recursive: true, force: true });
    });
    it('monitorTeam rejects invalid team names before path usage', async () => {
        await expect(monitorTeam('Bad-Team', '/tmp', [])).rejects.toThrow('Invalid team name');
    });
    it('legacy startTeam fails closed before creating native state', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-v1-start-'));
        try {
            await expect(startTeam({
                teamName: 'legacy-start',
                workerCount: 1,
                agentTypes: ['claude'],
                tasks: [{ subject: 'task', description: 'task' }],
                cwd,
            })).rejects.toThrow('team_start_unsafe_runtime_v1');
            expect(existsSync(join(cwd, '.omc', 'state', 'team', 'legacy-start'))).toBe(false);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('resumeTeam refuses state without immutable instance ownership', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-v1-resume-'));
        try {
            const root = join(cwd, '.omc', 'state', 'team', 'legacy-resume');
            mkdirSync(root, { recursive: true });
            writeFileSync(join(root, 'config.json'), JSON.stringify({
                teamName: 'legacy-resume',
                workerCount: 0,
                agentTypes: ['claude'],
                tasks: [],
                cwd,
                tmuxSession: 'legacy-resume',
                leaderPaneId: '%1',
            }), 'utf-8');
            await expect(resumeTeam('legacy-resume', cwd)).resolves.toBeNull();
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('does not expose retired legacy mutation entrypoints', async () => {
        const runtimeModule = await import('../runtime.js');
        const teamModule = await import('../index.js');
        for (const name of ['watchdogCliWorkers', 'spawnWorkerForTask', 'killWorkerPane', 'assignTask']) {
            expect(runtimeModule[name]).toBeUndefined();
            expect(teamModule[name]).toBeUndefined();
        }
    });
});
//# sourceMappingURL=runtime.test.js.map
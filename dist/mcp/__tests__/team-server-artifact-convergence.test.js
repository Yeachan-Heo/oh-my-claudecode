import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorkerWorktree } from '../../team/git-worktree.js';
vi.mock('../../team/tmux-session.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        killWorkerPanes: vi.fn(async () => undefined),
    };
});
const originalEnv = { ...process.env };
function parseResponseText(text) {
    return JSON.parse(text);
}
async function importTeamServerWithJobsDir(jobsDir) {
    process.env.OMC_TEAM_SERVER_DISABLE_AUTOSTART = '1';
    process.env.NODE_ENV = 'test';
    process.env.OMC_JOBS_DIR = jobsDir;
    vi.resetModules();
    return import('../team-server.js');
}
describe('team-server artifact convergence + scoped cleanup', () => {
    let testRoot;
    let jobsDir;
    beforeEach(() => {
        testRoot = join(tmpdir(), `omc-team-server-test-${process.pid}-${Date.now()}`);
        jobsDir = join(testRoot, 'jobs');
        mkdirSync(jobsDir, { recursive: true });
    });
    afterEach(() => {
        rmSync(testRoot, { recursive: true, force: true });
        process.env = { ...originalEnv };
        vi.clearAllMocks();
    });
    it('handleStatus converges to terminal artifact before pid liveness', async () => {
        const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art1';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now() - 1000,
            pid: 999999, // intentionally dead if checked
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({ status: 'completed', teamName: 'artifact-team', taskResults: [] }), 'utf-8');
        const response = await handleStatus({ job_id: jobId });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.status).toBe('completed');
        expect(payload.result).toMatchObject({ status: 'completed', teamName: 'artifact-team' });
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('completed');
    });
    it('handleWait deterministically fails on parse-failed artifact and persists failure', async () => {
        const { handleWait } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art2';
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
            status: 'running',
            startedAt: Date.now() - 500,
            pid: process.pid,
        }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-result.json`), '{not-json', 'utf-8');
        const response = await handleWait({ job_id: jobId, timeout_ms: 2000 });
        const payload = parseResponseText(response.content[0].text);
        expect(payload.status).toBe('failed');
        expect(payload.result).toMatchObject({
            error: { code: 'RESULT_ARTIFACT_PARSE_FAILED' },
        });
        const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
        expect(persisted.status).toBe('failed');
    });
    it('handleCleanup removes only scoped .omc/state/team/<teamName> directory', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art3';
        const cwd = join(testRoot, 'workspace');
        const teamOneDir = join(cwd, '.omc', 'state', 'team', 'team-one');
        const teamTwoDir = join(cwd, '.omc', 'state', 'team', 'team-two');
        mkdirSync(teamOneDir, { recursive: true });
        mkdirSync(teamTwoDir, { recursive: true });
        writeFileSync(join(teamOneDir, 'a.json'), '{}', 'utf-8');
        writeFileSync(join(teamTwoDir, 'b.json'), '{}', 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify({ paneIds: ['%2'], leaderPaneId: '%1' }), 'utf-8');
        const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(response.content[0].text).toContain('team state dir removed');
        expect(existsSync(teamOneDir)).toBe(false);
        expect(existsSync(teamTwoDir)).toBe(true);
    });
    it('handleCleanup also removes dormant scoped team worktrees when present', async () => {
        const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);
        const jobId = 'omc-art4';
        const cwd = join(testRoot, 'workspace-worktree');
        mkdirSync(cwd, { recursive: true });
        execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
        writeFileSync(join(cwd, 'README.md'), 'hello\n', 'utf-8');
        execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
        const teamOneDir = join(cwd, '.omc', 'state', 'team', 'team-one');
        mkdirSync(teamOneDir, { recursive: true });
        const worktree = createWorkerWorktree('team-one', 'worker1', cwd);
        expect(existsSync(worktree.path)).toBe(true);
        writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }), 'utf-8');
        writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify({ paneIds: ['%2'], leaderPaneId: '%1' }), 'utf-8');
        await handleCleanup({ job_id: jobId, grace_ms: 0 });
        expect(existsSync(worktree.path)).toBe(false);
        expect(existsSync(teamOneDir)).toBe(false);
    });
});
//# sourceMappingURL=team-server-artifact-convergence.test.js.map
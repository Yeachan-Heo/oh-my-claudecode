/**
 * Tests that getActiveJobsSummary reads from the correct worktree DB
 * when multiple DBs are open simultaneously (closes #862).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createCompactCheckpoint } from '../hooks/pre-compact/index.js';
import { initJobDb, upsertJob, closeAllJobDbs } from '../lib/job-state-db.js';
const TEST_BASE = join(process.cwd(), '.test-pre-compact-cwd-' + process.pid);
const DIR_A = join(TEST_BASE, 'worktree-a');
const DIR_B = join(TEST_BASE, 'worktree-b');
function makeJob(overrides = {}) {
    return {
        provider: 'codex',
        jobId: 'default-id',
        slug: 'test',
        status: 'running',
        promptFile: '/tmp/prompt.md',
        responseFile: '/tmp/response.md',
        model: 'gpt-5.3-codex',
        agentRole: 'architect',
        spawnedAt: new Date().toISOString(),
        ...overrides,
    };
}
describe('pre-compact: getActiveJobsSummary respects cwd', () => {
    beforeEach(async () => {
        if (existsSync(TEST_BASE))
            rmSync(TEST_BASE, { recursive: true, force: true });
        mkdirSync(DIR_A, { recursive: true });
        mkdirSync(DIR_B, { recursive: true });
        // Initialize both DBs so both are open simultaneously
        await initJobDb(DIR_A);
        await initJobDb(DIR_B);
        // Insert distinct jobs into each worktree DB
        upsertJob(makeJob({ jobId: 'job-worktree-a', agentRole: 'planner' }), DIR_A);
        upsertJob(makeJob({ jobId: 'job-worktree-b', agentRole: 'executor' }), DIR_B);
    });
    afterEach(() => {
        closeAllJobDbs();
        if (existsSync(TEST_BASE))
            rmSync(TEST_BASE, { recursive: true, force: true });
    });
    it('reads active jobs from worktree-a only when called with DIR_A', async () => {
        const checkpoint = await createCompactCheckpoint(DIR_A, 'auto');
        const activeIds = checkpoint.background_jobs?.active.map(j => j.jobId) ?? [];
        expect(activeIds).toContain('job-worktree-a');
        expect(activeIds).not.toContain('job-worktree-b');
    });
    it('reads active jobs from worktree-b only when called with DIR_B', async () => {
        const checkpoint = await createCompactCheckpoint(DIR_B, 'auto');
        const activeIds = checkpoint.background_jobs?.active.map(j => j.jobId) ?? [];
        expect(activeIds).toContain('job-worktree-b');
        expect(activeIds).not.toContain('job-worktree-a');
    });
    it('stats reflect only the target worktree DB', async () => {
        const checkpointA = await createCompactCheckpoint(DIR_A, 'auto');
        const checkpointB = await createCompactCheckpoint(DIR_B, 'auto');
        expect(checkpointA.background_jobs?.stats?.total).toBe(1);
        expect(checkpointB.background_jobs?.stats?.total).toBe(1);
    });
});
//# sourceMappingURL=pre-compact-cwd.test.js.map
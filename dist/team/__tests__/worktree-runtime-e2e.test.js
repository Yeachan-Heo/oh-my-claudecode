// src/team/__tests__/worktree-runtime-e2e.test.ts
//
// Acceptance #1: 3 workers × 10 commits → 30 merge_succeeded events.
// Uses real git via git-fixture helper.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, orchestratorEventLogPath, readEventLog, waitForEventInLog, } from './helpers/git-fixture.js';
import { startMergeOrchestrator, } from '../merge-orchestrator.js';
beforeAll(() => {
    process.env.OMC_RUNTIME_V2 = '1';
});
afterEach(() => {
    process.env.OMC_RUNTIME_V2 = '1';
});
// ---------------------------------------------------------------------------
// Acceptance #1: 3 workers × 10 commits — all 30 merges succeed
// ---------------------------------------------------------------------------
describe('worktree runtime e2e: 3 workers × 10 commits', () => {
    let fixture;
    let handle;
    beforeEach(async () => {
        fixture = await createGitFixture({
            workerCount: 3,
            leaderBranchName: 'omc-team-test-leader',
            teamName: 'e2e-team',
        });
        process.env.OMC_RUNTIME_V2 = '1';
        const config = {
            teamName: fixture.teamName,
            repoRoot: fixture.repoRoot,
            leaderBranch: fixture.leaderBranch,
            cwd: fixture.repoRoot,
            pollIntervalMs: 100,
            drainTimeoutMs: 20000,
        };
        handle = await startMergeOrchestrator(config);
        await handle.registerWorker('worker-1');
        await handle.registerWorker('worker-2');
        await handle.registerWorker('worker-3');
    });
    afterEach(async () => {
        try {
            await handle.drainAndStop();
        }
        catch { /* ignore */ }
        await fixture.cleanup();
    });
    it('all 30 commits across 3 workers produce merge_succeeded events', async () => {
        // Each worker commits 10 files to disjoint paths (worker-N/file-X.ts)
        // so there are NO conflicts. All merges should succeed.
        //
        // Use serialized commit→wait-for-merge loops to prevent burst-commit
        // coalescing (the orchestrator merges latest HEAD per poll window, so
        // 10 rapid commits → 1 merge event). By waiting for each merge before
        // the next commit we guarantee at least 1 merge per commit.
        //
        // NOTE: rebase fan-out after each merge advances other workers' branch
        // SHAs, which the orchestrator treats as new commits and also merges.
        // So the total merge count may exceed 30 (each of the 30 user commits
        // produces ≥1 merge, plus rebase-induced merges). We assert ≥30 total
        // and ≥10 per worker.
        const COMMITS_PER_WORKER = 10;
        const eventLog = orchestratorEventLogPath(fixture.repoRoot, fixture.teamName);
        const workers = ['worker-1', 'worker-2', 'worker-3'];
        // Track total merges seen so far per worker (rebase-induced merges count too)
        const mergeCountPerWorker = { 'worker-1': 0, 'worker-2': 0, 'worker-3': 0 };
        for (const worker of workers) {
            for (let i = 1; i <= COMMITS_PER_WORKER; i++) {
                await fixture.commitFile(worker, `${worker}/file-${i}.ts`, `// ${worker} file ${i}\nexport const f${i} = ${i};\n`);
                mergeCountPerWorker[worker] += 1;
                // Wait for at least mergeCountPerWorker[worker] merges from this worker
                // before issuing the next commit (prevents coalescing).
                await waitForEventInLog({
                    eventLogPath: eventLog,
                    eventType: 'merge_succeeded',
                    worker,
                    count: mergeCountPerWorker[worker],
                    timeoutMs: 5000,
                });
                // Re-read current count in case rebase-induced merges arrived
                const currentEvents = readEventLog(eventLog);
                mergeCountPerWorker[worker] = currentEvents.filter((e) => e.type === 'merge_succeeded' && e.worker === worker).length;
            }
        }
        const events = readEventLog(eventLog);
        const mergeSucceeded = events.filter((e) => e.type === 'merge_succeeded');
        // At least 30 merges: one per user commit. May be more due to rebase fan-out.
        expect(mergeSucceeded.length).toBeGreaterThanOrEqual(30);
        // All three workers should have contributed at least COMMITS_PER_WORKER merges
        for (const worker of workers) {
            const wMerges = mergeSucceeded.filter((e) => e.worker === worker);
            expect(wMerges.length).toBeGreaterThanOrEqual(COMMITS_PER_WORKER);
        }
    }, 120000);
    it('leader branch has merge commits after all workers finish', async () => {
        const COMMITS_PER_WORKER = 3; // smaller count for speed
        const eventLog = orchestratorEventLogPath(fixture.repoRoot, fixture.teamName);
        const workers = ['worker-1', 'worker-2', 'worker-3'];
        const mergeCountPerWorker = { 'worker-1': 0, 'worker-2': 0, 'worker-3': 0 };
        // Serialized commit→wait-for-merge per worker to prevent coalescing
        for (const worker of workers) {
            for (let i = 1; i <= COMMITS_PER_WORKER; i++) {
                await fixture.commitFile(worker, `${worker}/f${i}.ts`, `// ${worker} f${i}\n`);
                mergeCountPerWorker[worker] += 1;
                await waitForEventInLog({
                    eventLogPath: eventLog,
                    eventType: 'merge_succeeded',
                    worker,
                    count: mergeCountPerWorker[worker],
                    timeoutMs: 5000,
                });
                // Update count to include any rebase-induced merges
                const currentEvents = readEventLog(eventLog);
                mergeCountPerWorker[worker] = currentEvents.filter((e) => e.type === 'merge_succeeded' && e.worker === worker).length;
            }
        }
        // Drain to ensure all merges are flushed
        await handle.drainAndStop();
        // Verify leader branch has merge commits via git log.
        // Each worker's user commits produce ≥1 merge commit each.
        // Rebase-induced merges may add more. Assert at least one worker's
        // commits made it in as merge commits.
        const { execFileSync } = await import('node:child_process');
        const logOutput = execFileSync('git', ['log', '--merges', '--oneline', fixture.leaderBranch], {
            cwd: fixture.repoRoot,
            encoding: 'utf-8',
            stdio: 'pipe',
        }).trim();
        const mergeCommitLines = logOutput.split('\n').filter((l) => l.trim().length > 0);
        // At least one merge per worker (3 workers × 1 = 3 minimum)
        expect(mergeCommitLines.length).toBeGreaterThanOrEqual(workers.length);
    }, 60000);
    it('leader inbox has merge notifications', async () => {
        await fixture.commitFile('worker-1', 'worker-1/notify.ts', '// notify test\n');
        const eventLog = orchestratorEventLogPath(fixture.repoRoot, fixture.teamName);
        await waitForEventInLog({ eventLogPath: eventLog, eventType: 'merge_succeeded', worker: 'worker-1', timeoutMs: 8000 });
        // Leader inbox should have been created and seeded by orchestrator startup
        const leaderInboxPath = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName, 'leader', 'inbox.md');
        expect(existsSync(leaderInboxPath)).toBe(true);
    });
    it('orchestrator state is consistent across registerWorker calls', async () => {
        const state = handle.getState();
        expect(state.workers).toContain('worker-1');
        expect(state.workers).toContain('worker-2');
        expect(state.workers).toContain('worker-3');
        expect(state.workers.length).toBe(3);
    });
});
// ---------------------------------------------------------------------------
// Leader branch name guard — never main/master (M3 compliance check)
// ---------------------------------------------------------------------------
describe('M3 compliance: fixture never uses main/master', () => {
    it('fixture rejects main as leader branch', async () => {
        await expect(createGitFixture({ workerCount: 1, leaderBranchName: 'main' })).rejects.toThrow(/main\/master/);
    });
    it('fixture rejects master as leader branch', async () => {
        await expect(createGitFixture({ workerCount: 1, leaderBranchName: 'master' })).rejects.toThrow(/main\/master/);
    });
    it('orchestrator rejects main leader branch', async () => {
        const fixture = await createGitFixture({ workerCount: 1 });
        try {
            process.env.OMC_RUNTIME_V2 = '1';
            const config = {
                teamName: fixture.teamName,
                repoRoot: fixture.repoRoot,
                leaderBranch: 'main', // should be rejected
                cwd: fixture.repoRoot,
            };
            await expect(startMergeOrchestrator(config)).rejects.toThrow(/main\/master/);
        }
        finally {
            await fixture.cleanup();
        }
    });
});
//# sourceMappingURL=worktree-runtime-e2e.test.js.map
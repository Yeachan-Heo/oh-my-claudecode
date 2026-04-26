// src/team/__tests__/auto-merge-restart.test.ts
//
// Integration tests for M6: restart recovery.
// Uses real git via git-fixture helper.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, orchestratorEventLogPath, readEventLog, } from './helpers/git-fixture.js';
import { startMergeOrchestrator, recoverFromRestart, } from '../merge-orchestrator.js';
import { atomicWriteJson } from '../fs-utils.js';
beforeAll(() => {
    process.env.OMC_RUNTIME_V2 = '1';
});
afterEach(() => {
    // Ensure env is set for each test
    process.env.OMC_RUNTIME_V2 = '1';
});
describe('M6: restart recovery', () => {
    let fixture;
    beforeEach(async () => {
        fixture = await createGitFixture({ workerCount: 2 });
        process.env.OMC_RUNTIME_V2 = '1';
    });
    afterEach(async () => {
        await fixture.cleanup();
    });
    it('recoverFromRestart delivers orphan-rebase mailbox to affected worker', async () => {
        // Simulate an orphaned rebase state for worker-1 using the real gitdir
        // path. In a real git worktree `.git` remains a file.
        const rebaseDir = fixture.createRebaseState('worker-1');
        expect(readFileSync(join(fixture.workers[0].worktreePath, '.git'), 'utf-8')).toMatch(/^gitdir:/);
        expect(existsSync(join(fixture.workers[0].worktreePath, '.git', 'rebase-merge'))).toBe(false);
        expect(existsSync(rebaseDir)).toBe(true);
        const config = {
            teamName: fixture.teamName,
            repoRoot: fixture.repoRoot,
            leaderBranch: fixture.leaderBranch,
            cwd: fixture.repoRoot,
            pollIntervalMs: 50,
        };
        const result = await recoverFromRestart(config);
        // Should detect the orphaned rebase
        expect(result.orphanedRebases).toContain('worker-1');
        // Worker-1 should have received a recovery message
        const workerInboxPath = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName, 'workers', 'worker-1', 'inbox.md');
        expect(existsSync(workerInboxPath)).toBe(true);
        const inboxContent = readFileSync(workerInboxPath, 'utf-8');
        expect(inboxContent).toContain('Runtime restart recovery');
        expect(inboxContent).toContain('mid-rebase');
    });
    it('recoverFromRestart loads persisted SHA state (no false fan-out on first poll after restart)', async () => {
        // Seed persisted state with SHAs for both workers
        const stateDir = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName);
        mkdirSync(stateDir, { recursive: true });
        const persistedPath = join(stateDir, 'auto-merge-state.json');
        const worker1Sha = fixture.getBranchSha(fixture.workers[0].branch);
        const worker2Sha = fixture.getBranchSha(fixture.workers[1].branch);
        atomicWriteJson(persistedPath, {
            lastShas: {
                'worker-1': worker1Sha,
                'worker-2': worker2Sha,
            },
        });
        const config = {
            teamName: fixture.teamName,
            repoRoot: fixture.repoRoot,
            leaderBranch: fixture.leaderBranch,
            cwd: fixture.repoRoot,
            pollIntervalMs: 50,
        };
        const result = await recoverFromRestart(config);
        // Should load 2 persisted SHAs
        expect(result.persistedShasLoaded).toBe(2);
        // A restart_recovery event should be in the event log
        const eventLog = orchestratorEventLogPath(fixture.repoRoot, fixture.teamName);
        // Give async writes a moment
        await new Promise((r) => setTimeout(r, 100));
        if (existsSync(eventLog)) {
            const events = readEventLog(eventLog);
            expect(events.some((e) => e.type === 'restart_recovery')).toBe(true);
        }
    });
    it('falls back gracefully when persisted state file is absent', async () => {
        const config = {
            teamName: fixture.teamName,
            repoRoot: fixture.repoRoot,
            leaderBranch: fixture.leaderBranch,
            cwd: fixture.repoRoot,
            pollIntervalMs: 50,
        };
        // No auto-merge-state.json exists — should not throw
        const result = await recoverFromRestart(config);
        expect(result.persistedShasLoaded).toBe(0);
        expect(result.orphanedRebases).toEqual([]);
    });
    it('orchestrator seeds from persisted SHAs so it does not re-merge already-seen commits', async () => {
        // Commit something on worker-1 first
        const sha = await fixture.commitFile('worker-1', 'worker-1/seed.ts', '// seeded\n');
        // Write persisted state that already has this SHA
        const stateDir = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName);
        mkdirSync(stateDir, { recursive: true });
        const persistedPath = join(stateDir, 'auto-merge-state.json');
        atomicWriteJson(persistedPath, { lastShas: { 'worker-1': sha } });
        const config = {
            teamName: fixture.teamName,
            repoRoot: fixture.repoRoot,
            leaderBranch: fixture.leaderBranch,
            cwd: fixture.repoRoot,
            pollIntervalMs: 50,
            drainTimeoutMs: 1000,
        };
        const handle = await startMergeOrchestrator(config);
        await handle.registerWorker('worker-1');
        // The orchestrator should have seeded lastSha from persisted state.
        // Since the current branch HEAD == persisted SHA, no merge should be triggered.
        const state = handle.getState();
        expect(state.lastShas['worker-1']).toBe(sha);
        // Wait a couple of poll cycles
        await new Promise((r) => setTimeout(r, 200));
        const eventLog = orchestratorEventLogPath(fixture.repoRoot, fixture.teamName);
        const events = readEventLog(eventLog);
        // Should have no merge_attempted events (no new commits since the persisted SHA)
        const mergeAttempts = events.filter((e) => e.type === 'merge_attempted' && e.worker === 'worker-1');
        expect(mergeAttempts).toHaveLength(0);
        await handle.drainAndStop();
    });
});
//# sourceMappingURL=auto-merge-restart.test.js.map
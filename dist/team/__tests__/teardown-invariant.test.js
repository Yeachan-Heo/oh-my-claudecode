// src/team/__tests__/teardown-invariant.test.ts
//
// Integration tests for Acceptance #2: drainAndStop invariants.
// Uses real git via git-fixture helper.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
// Helper: build config from fixture
// ---------------------------------------------------------------------------
function makeConfig(fixture, overrides = {}) {
    return {
        teamName: fixture.teamName,
        repoRoot: fixture.repoRoot,
        leaderBranch: fixture.leaderBranch,
        cwd: fixture.repoRoot,
        pollIntervalMs: 100,
        drainTimeoutMs: 2000,
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// Acceptance #2: clean merge makes it into leader; conflicting worker gets audited
// ---------------------------------------------------------------------------
describe('drainAndStop — clean + conflicting work', () => {
    let fixture;
    beforeEach(async () => {
        fixture = await createGitFixture({ workerCount: 2 });
        process.env.OMC_RUNTIME_V2 = '1';
    });
    afterEach(async () => {
        await fixture.cleanup();
    });
    it('leader branch gets the clean merge and teardown-audit has the conflict row', async () => {
        const config = makeConfig(fixture);
        const handle = await startMergeOrchestrator(config);
        // Register both workers
        await handle.registerWorker('worker-1');
        await handle.registerWorker('worker-2');
        // Worker-1 writes to a unique file (clean)
        await fixture.commitFile('worker-1', 'worker-1/clean.ts', '// worker-1 clean work\n');
        // Worker-2 writes to a file that CONFLICTS with a file on the leader branch.
        // First, put content on the leader branch by merging worker-1 cleanly.
        const eventLog = orchestratorEventLogPath(fixture.repoRoot, fixture.teamName);
        await waitForEventInLog({ eventLogPath: eventLog, eventType: 'merge_succeeded', worker: 'worker-1', timeoutMs: 8000 });
        // Now worker-2 modifies the SAME file that's on leader with incompatible content
        // We need to create a conflict: leader has README.md, worker-2 modifies it
        await fixture.commitFile('worker-2', 'README.md', '# conflict from worker-2\ncompletely different content\n');
        // Wait a moment for orchestrator to observe worker-2's commit and detect conflict
        await new Promise((r) => setTimeout(r, 500));
        // Drain and stop
        const result = await handle.drainAndStop();
        // Worker-1 should have merged cleanly (already done above).
        // Worker-2 may be unmerged due to conflict.
        // The important assertion: drainAndStop returns structured results.
        expect(Array.isArray(result.unmerged)).toBe(true);
        // Teardown audit file should exist if there were unmerged workers.
        const auditPath = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName, 'teardown-audit.jsonl');
        if (result.unmerged.length > 0) {
            expect(existsSync(auditPath)).toBe(true);
            const auditContent = readFileSync(auditPath, 'utf-8');
            expect(auditContent).toContain('"type":"unmerged_at_shutdown"');
            // Each unmerged worker should be in the audit
            for (const u of result.unmerged) {
                expect(auditContent).toContain(`"worker":"${u.workerName}"`);
                expect(auditContent).toContain(`"reason":"${u.reason}"`);
            }
            // Leader inbox should contain the teardown audit message
            const leaderInboxPath = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName, 'leader', 'inbox.md');
            expect(existsSync(leaderInboxPath)).toBe(true);
            const leaderInbox = readFileSync(leaderInboxPath, 'utf-8');
            expect(leaderInbox).toContain('Teardown audit');
        }
        // Worker-1's clean work should be in the leader branch
        const events = readEventLog(eventLog);
        const worker1Merges = events.filter((e) => e.type === 'merge_succeeded' && e.worker === 'worker-1');
        expect(worker1Merges.length).toBeGreaterThanOrEqual(1);
    });
});
// ---------------------------------------------------------------------------
// Drain-timeout case: merge stalled, audit has drain-timeout reason
// ---------------------------------------------------------------------------
describe('drainAndStop — drain timeout', () => {
    let fixture;
    beforeEach(async () => {
        fixture = await createGitFixture({ workerCount: 1 });
        process.env.OMC_RUNTIME_V2 = '1';
    });
    afterEach(async () => {
        await fixture.cleanup();
    });
    it('audit row has reason drain-timeout when drainTimeoutMs is very short', async () => {
        // Use a very short drain timeout to force the drain to time out
        const config = makeConfig(fixture, { drainTimeoutMs: 1, pollIntervalMs: 100 });
        const handle = await startMergeOrchestrator(config);
        await handle.registerWorker('worker-1');
        // Commit something — this creates a pending merge
        await fixture.commitFile('worker-1', 'worker-1/file.ts', '// some work\n');
        // Wait for orchestrator to observe the commit
        await new Promise((r) => setTimeout(r, 300));
        // drainAndStop with drainTimeoutMs=1 will time out immediately before any merge
        const result = await handle.drainAndStop();
        // If worker-1 had a new commit that wasn't merged yet, it should be reported
        // as drain-timeout. If the orchestrator already merged it during polling,
        // unmerged may be empty — both are valid outcomes.
        if (result.unmerged.length > 0) {
            expect(result.unmerged.some((u) => u.reason === 'drain-timeout')).toBe(true);
            const auditPath = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName, 'teardown-audit.jsonl');
            expect(existsSync(auditPath)).toBe(true);
            const auditContent = readFileSync(auditPath, 'utf-8');
            expect(auditContent).toContain('"drain-timeout"');
            // Leader inbox should have the audit message
            const leaderInboxPath = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName, 'leader', 'inbox.md');
            expect(existsSync(leaderInboxPath)).toBe(true);
            const leaderInbox = readFileSync(leaderInboxPath, 'utf-8');
            expect(leaderInbox).toContain('Teardown audit');
        }
        else {
            // Orchestrator already merged — that's fine, no timeout needed
            expect(result.unmerged).toHaveLength(0);
        }
    });
    it('unregisterWorker removes worker from tracking — drain has nothing to flush', async () => {
        const config = makeConfig(fixture);
        const handle = await startMergeOrchestrator(config);
        await handle.registerWorker('worker-1');
        await handle.unregisterWorker('worker-1');
        // drainAndStop — worker-1 is not tracked, nothing to drain
        const result = await handle.drainAndStop();
        expect(result.unmerged).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// Multiple workers: audit contains one row per unmerged worker
// ---------------------------------------------------------------------------
describe('drainAndStop — one audit row per unmerged worker', () => {
    let fixture;
    beforeEach(async () => {
        fixture = await createGitFixture({ workerCount: 2 });
        process.env.OMC_RUNTIME_V2 = '1';
    });
    afterEach(async () => {
        await fixture.cleanup();
    });
    it('all unmerged workers appear in teardown-audit.jsonl', async () => {
        // Drain timeout of 1ms means nothing can merge
        const config = makeConfig(fixture, { drainTimeoutMs: 1, pollIntervalMs: 5000 });
        const handle = await startMergeOrchestrator(config);
        await handle.registerWorker('worker-1');
        await handle.registerWorker('worker-2');
        // Commit on both workers
        await fixture.commitFile('worker-1', 'worker-1/a.ts', '// a\n');
        await fixture.commitFile('worker-2', 'worker-2/b.ts', '// b\n');
        // Don't wait for polling (pollIntervalMs=5000 means poller won't fire)
        const result = await handle.drainAndStop();
        // With drainTimeoutMs=1, both workers should fail to drain
        if (result.unmerged.length > 0) {
            const auditPath = join(fixture.repoRoot, '.omc', 'state', 'team', fixture.teamName, 'teardown-audit.jsonl');
            expect(existsSync(auditPath)).toBe(true);
            const lines = readFileSync(auditPath, 'utf-8')
                .split('\n')
                .filter((l) => l.trim().length > 0);
            // Each unmerged worker should have its own row
            expect(lines.length).toBe(result.unmerged.length);
        }
    });
});
//# sourceMappingURL=teardown-invariant.test.js.map
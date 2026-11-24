/**
 * Multi-repo workspace anchor tests for ultragoal artifacts.
 *
 * Companion to artifacts.test.ts. Verifies that when a .omc-workspace marker
 * exists in a parent directory, ultragoal artifacts are written to the
 * workspace anchor's .omc/ instead of the sub-repo's .omc/.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { clearWorktreeCache } from '../../lib/worktree-paths.js';
import { createUltragoalPlan, startNextUltragoal, checkpointUltragoal, readUltragoalPlan, } from '../artifacts.js';
function cleanQualityGate() {
    return {
        aiSlopCleaner: { status: 'passed', evidence: 'ai-slop-cleaner ran on changed files' },
        verification: { status: 'passed', commands: ['npm test'], evidence: 'tests passed after cleaner' },
        codeReview: { recommendation: 'APPROVE', architectStatus: 'CLEAR', evidence: '$code-review approved with CLEAR architecture' },
    };
}
describe('ultragoal artifacts — multi-repo workspace anchor', () => {
    it('writes artifacts to workspace anchor .omc/ when .omc-workspace marker is in a parent dir', async () => {
        const workspaceRoot = await mkdtemp(join(homedir(), 'omc-multirepo-anchor-'));
        try {
            // Drop workspace marker so getOmcRoot() anchors to workspaceRoot
            writeFileSync(join(workspaceRoot, '.omc-workspace'), '{}');
            // Create a sub-git-repo inside the workspace
            const subDir = join(workspaceRoot, 'sub-repo');
            mkdirSync(subDir, { recursive: true });
            execSync('git init', { cwd: subDir, stdio: 'pipe' });
            clearWorktreeCache();
            await createUltragoalPlan(subDir, { brief: '- Task A\n- Task B' });
            // Artifacts must land under the workspace anchor, not in the sub-repo
            expect(existsSync(join(workspaceRoot, '.omc', 'ultragoal', 'goals.json'))).toBe(true);
            expect(existsSync(join(subDir, '.omc', 'ultragoal'))).toBe(false);
        }
        finally {
            clearWorktreeCache();
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
    it('sibling sub-repos share one workspace .omc/ when rooted at the same .omc-workspace', async () => {
        const workspaceRoot = await mkdtemp(join(homedir(), 'omc-multirepo-sibling-'));
        try {
            writeFileSync(join(workspaceRoot, '.omc-workspace'), '{}');
            const repoA = join(workspaceRoot, 'repo-a');
            const repoB = join(workspaceRoot, 'repo-b');
            mkdirSync(repoA, { recursive: true });
            mkdirSync(repoB, { recursive: true });
            execSync('git init', { cwd: repoA, stdio: 'pipe' });
            execSync('git init', { cwd: repoB, stdio: 'pipe' });
            clearWorktreeCache();
            // Plans with explicit planId so they don't collide on the shared goals.json
            await createUltragoalPlan(repoA, { brief: '- Feature A', planId: 'plan-a' });
            await createUltragoalPlan(repoB, { brief: '- Feature B', planId: 'plan-b' });
            // Both plans land under the single workspace .omc/
            expect(existsSync(join(workspaceRoot, '.omc', 'ultragoal', 'plans', 'plan-a', 'goals.json'))).toBe(true);
            expect(existsSync(join(workspaceRoot, '.omc', 'ultragoal', 'plans', 'plan-b', 'goals.json'))).toBe(true);
            // Sub-repos must not have their own .omc/ultragoal
            expect(existsSync(join(repoA, '.omc', 'ultragoal'))).toBe(false);
            expect(existsSync(join(repoB, '.omc', 'ultragoal'))).toBe(false);
            // Plans read back from either sub-repo have the correct goal counts
            const planA = await readUltragoalPlan(repoA, 'plan-a');
            const planB = await readUltragoalPlan(repoB, 'plan-b');
            expect(planA.goals.length).toBe(1);
            expect(planB.goals.length).toBe(1);
        }
        finally {
            clearWorktreeCache();
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
    it('full lifecycle (start → checkpoint) resolves through workspace anchor', async () => {
        const workspaceRoot = await mkdtemp(join(homedir(), 'omc-multirepo-lifecycle-'));
        try {
            writeFileSync(join(workspaceRoot, '.omc-workspace'), '{}');
            const subDir = join(workspaceRoot, 'app');
            mkdirSync(subDir, { recursive: true });
            execSync('git init', { cwd: subDir, stdio: 'pipe' });
            clearWorktreeCache();
            await createUltragoalPlan(subDir, {
                brief: '- Ship it',
                goals: [{ title: 'Ship it', objective: 'Ship the feature.' }],
            });
            const started = await startNextUltragoal(subDir);
            expect(started.goal?.id).toBe('G001-ship-it');
            expect(started.goal?.status).toBe('in_progress');
            const objective = started.plan.claudeObjective;
            await checkpointUltragoal(subDir, {
                goalId: started.goal.id,
                status: 'complete',
                evidence: 'planned work done; tests passed clean; review APPROVED CLEAR',
                claudeGoal: { goal: { objective, status: 'complete' } },
                qualityGate: cleanQualityGate(),
            });
            const plan = await readUltragoalPlan(subDir);
            expect(plan.goals[0]?.status).toBe('complete');
            // Ledger is in the workspace anchor, not the sub-repo
            const ledger = await readFile(join(workspaceRoot, '.omc', 'ultragoal', 'ledger.jsonl'), 'utf-8');
            expect(ledger).toMatch(/"event":"plan_created"/);
            expect(ledger).toMatch(/"event":"goal_started"/);
        }
        finally {
            clearWorktreeCache();
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=artifacts.multirepo.test.js.map
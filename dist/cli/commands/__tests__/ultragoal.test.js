import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ultragoalCommand } from '../ultragoal.js';
async function withTempCwd(run) {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-ultragoal-cli-'));
    const original = process.cwd();
    process.chdir(cwd);
    try {
        return await run(cwd);
    }
    finally {
        process.chdir(original);
        await rm(cwd, { recursive: true, force: true });
    }
}
function captureConsole() {
    const out = [];
    const err = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
        out.push(args.map(String).join(' '));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
        err.push(args.map(String).join(' '));
    });
    return {
        out,
        err,
        restore: () => {
            log.mockRestore();
            error.mockRestore();
        },
    };
}
describe('omc ultragoal CLI', () => {
    let captured;
    beforeEach(() => {
        captured = captureConsole();
        process.exitCode = 0;
    });
    afterEach(() => {
        captured.restore();
        process.exitCode = 0;
    });
    it('prints help when invoked with no subcommand', async () => {
        await ultragoalCommand([]);
        const joined = captured.out.join('\n');
        expect(joined).toMatch(/omc ultragoal/);
        expect(joined).toMatch(/Artifacts[^\n]*[\s\S]*\.omc\/ultragoal\/brief\.md/);
        expect(joined).toMatch(/Claude \/goal integration/);
        expect(joined).not.toMatch(/\bomx\b/);
    });
    it('create-goals from positional brief writes .omc/ultragoal artifacts', async () => {
        await withTempCwd(async (cwd) => {
            await ultragoalCommand(['create-goals', '- First story\n- Second story']);
            expect(process.exitCode).toBe(0);
            const goals = JSON.parse(await readFile(join(cwd, '.omc/ultragoal/goals.json'), 'utf-8'));
            expect(goals.claudeGoalMode).toBe('aggregate');
            expect(goals.goals.map((g) => g.id)).toEqual(['G001-first-story', 'G002-second-story']);
            const brief = await readFile(join(cwd, '.omc/ultragoal/brief.md'), 'utf-8');
            expect(brief).toMatch(/First story/);
            expect(brief).toMatch(/Second story/);
            const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
            expect(ledger).toMatch(/"event":"plan_created"/);
        });
    });
    it('complete-goals emits Claude /goal handoff text for the active story', async () => {
        await withTempCwd(async () => {
            await ultragoalCommand([
                'create-goals',
                '--brief', 'brief',
                '--goal', 'First::Complete first milestone.',
                '--goal', 'Second::Complete second milestone.',
                '--claude-goal-mode', 'aggregate',
            ]);
            captured.out.length = 0;
            await ultragoalCommand(['complete-goals']);
            const joined = captured.out.join('\n');
            expect(joined).toMatch(/Ultragoal aggregate-goal handoff/);
            expect(joined).toMatch(/invoke \/goal/);
            expect(joined).toMatch(/--claude-goal-json/);
            expect(joined).toMatch(/does not satisfy the PreToolUse \/goal guard/);
            expect(joined).toMatch(/Complete first milestone/);
            expect(joined).not.toMatch(/\bomx\b/);
            expect(joined).not.toMatch(/get_goal|create_goal|update_goal/);
        });
    });
    it('checkpoint accepts a Claude /goal snapshot via inline JSON', async () => {
        await withTempCwd(async (cwd) => {
            await ultragoalCommand([
                'create-goals',
                '--brief', 'brief',
                '--goal', 'First::Complete first milestone.',
                '--goal', 'Second::Complete second milestone.',
            ]);
            const plan = JSON.parse(await readFile(join(cwd, '.omc/ultragoal/goals.json'), 'utf-8'));
            await ultragoalCommand(['complete-goals']);
            captured.out.length = 0;
            const snapshot = JSON.stringify({ goal: { objective: plan.claudeObjective, status: 'active' } });
            await ultragoalCommand([
                'checkpoint',
                '--goal-id', 'G001-first',
                '--status', 'complete',
                '--evidence', 'unit tests passed',
                '--claude-goal-json', snapshot,
            ]);
            expect(process.exitCode).toBe(0);
            const updated = JSON.parse(await readFile(join(cwd, '.omc/ultragoal/goals.json'), 'utf-8'));
            expect(updated.goals.find((g) => g.id === 'G001-first')?.status).toBe('complete');
            expect(updated.goals.find((g) => g.id === 'G002-second')?.status).toBe('pending');
        });
    });
    it('checkpoint accepts a Claude /goal snapshot file path', async () => {
        await withTempCwd(async (cwd) => {
            await ultragoalCommand([
                'create-goals',
                '--brief', 'brief',
                '--goal', 'First::Complete first milestone.',
            ]);
            const plan = JSON.parse(await readFile(join(cwd, '.omc/ultragoal/goals.json'), 'utf-8'));
            await ultragoalCommand(['complete-goals']);
            const snapshotPath = join(cwd, 'goal-snapshot.json');
            await writeFile(snapshotPath, JSON.stringify({ goal: { objective: plan.claudeObjective, status: 'complete' } }));
            const qualityGate = {
                aiSlopCleaner: { status: 'passed', evidence: 'cleaner ran' },
                verification: { status: 'passed', commands: ['npm test'], evidence: 'tests passed' },
                codeReview: { recommendation: 'APPROVE', architectStatus: 'CLEAR', evidence: 'review clean' },
            };
            const qualityPath = join(cwd, 'quality.json');
            await writeFile(qualityPath, JSON.stringify(qualityGate));
            captured.out.length = 0;
            await ultragoalCommand([
                'checkpoint',
                '--goal-id', 'G001-first',
                '--status', 'complete',
                '--evidence', 'final gates passed',
                '--claude-goal-json', 'goal-snapshot.json',
                '--quality-gate-json', 'quality.json',
            ]);
            expect(process.exitCode).toBe(0);
            const updated = JSON.parse(await readFile(join(cwd, '.omc/ultragoal/goals.json'), 'utf-8'));
            expect(updated.goals[0]?.status).toBe('complete');
        });
    });
    it('reports unknown subcommands as a CLI error', async () => {
        await withTempCwd(async () => {
            await ultragoalCommand(['frobnicate']);
            expect(process.exitCode).toBe(1);
            expect(captured.err.join('\n')).toMatch(/\[ultragoal\] Unknown ultragoal command: frobnicate/);
        });
    });
});
//# sourceMappingURL=ultragoal.test.js.map
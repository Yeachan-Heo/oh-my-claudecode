import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertModeStartAllowed, assertResetSafeWorktree, buildAutoresearchInstructions, getAutoresearchMissionArtifactLayout, loadAutoresearchRunManifest, materializeAutoresearchMissionToWorktree, prepareAutoresearchRuntime, processAutoresearchCandidate, } from '../runtime.js';
import { readModeState, writeModeState } from '../../lib/mode-state-io.js';
async function initRepo() {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-autoresearch-runtime-'));
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
    return cwd;
}
async function makeContract(repo) {
    const missionDir = join(repo, 'missions', 'demo');
    await mkdir(missionDir, { recursive: true });
    await mkdir(join(repo, 'scripts'), { recursive: true });
    const missionFile = join(missionDir, 'mission.md');
    const sandboxFile = join(missionDir, 'sandbox.md');
    const missionContent = '# Mission\nSolve the task.\n';
    const sandboxContent = `---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n---\nStay inside the mission boundary.\n`;
    await writeFile(missionFile, missionContent, 'utf-8');
    await writeFile(sandboxFile, sandboxContent, 'utf-8');
    await writeFile(join(repo, 'score.txt'), '1\n', 'utf-8');
    await writeFile(join(repo, 'scripts', 'eval.js'), "import { readFileSync } from 'node:fs';\nconst score = Number(readFileSync('score.txt', 'utf-8').trim());\nprocess.stdout.write(JSON.stringify({ pass: true, score }));\n", 'utf-8');
    execFileSync('git', ['add', 'missions/demo/mission.md', 'missions/demo/sandbox.md', 'scripts/eval.js', 'score.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add autoresearch fixtures'], { cwd: repo, stdio: 'ignore' });
    return {
        missionDir,
        repoRoot: repo,
        missionFile,
        sandboxFile,
        missionRelativeDir: 'missions/demo',
        missionContent,
        sandboxContent,
        sandbox: {
            frontmatter: { evaluator: { command: 'node scripts/eval.js', format: 'json' } },
            evaluator: { command: 'node scripts/eval.js', format: 'json' },
            body: 'Stay inside the mission boundary.',
        },
        missionSlug: 'missions-demo',
    };
}
describe('autoresearch runtime', () => {
    it('builds bootstrap instructions with mission, sandbox, and evaluator contract', async () => {
        const repo = await initRepo();
        try {
            const contract = await makeContract(repo);
            const instructions = buildAutoresearchInstructions(contract, { runId: 'missions-demo-20260314t000000z', iteration: 1, baselineCommit: 'abc1234', lastKeptCommit: 'abc1234', resultsFile: 'results.tsv', candidateFile: '.omc/logs/autoresearch/missions-demo-20260314t000000z/candidate.json', keepPolicy: 'score_improvement' });
            expect(instructions).toMatch(/exactly one experiment cycle/i);
            expect(instructions).toMatch(/required output field: pass/i);
            expect(instructions).toMatch(/optional output field: score/i);
            expect(instructions).toMatch(/Iteration state snapshot:/i);
            expect(instructions).toMatch(/Mission file:/i);
            expect(instructions).toMatch(/Sandbox policy:/i);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('allows untracked .omc runtime files when checking reset safety', async () => {
        const repo = await initRepo();
        try {
            await mkdir(join(repo, '.omc', 'logs'), { recursive: true });
            await mkdir(join(repo, '.omc', 'state'), { recursive: true });
            await writeFile(join(repo, '.omc', 'logs', 'hooks-2026-03-15.jsonl'), '{}\n', 'utf-8');
            await writeFile(join(repo, '.omc', 'metrics.json'), '{}\n', 'utf-8');
            await writeFile(join(repo, '.omc', 'state', 'hud-state.json'), '{}\n', 'utf-8');
            expect(() => assertResetSafeWorktree(repo)).not.toThrow();
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('prepares runtime artifacts and persists autoresearch mode state', async () => {
        const repo = await initRepo();
        try {
            const contract = await makeContract(repo);
            await mkdir(join(repo, 'node_modules', 'fixture-dep'), { recursive: true });
            await writeFile(join(repo, 'node_modules', 'fixture-dep', 'index.js'), 'export default 1;\n', 'utf-8');
            const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t000000z');
            execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t000000z', worktreePath, 'HEAD'], {
                cwd: repo,
                stdio: 'ignore',
            });
            const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
            const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T000000Z' });
            expect(existsSync(worktreeContract.missionFile)).toBe(true);
            expect(existsSync(worktreeContract.sandboxFile)).toBe(true);
            expect(existsSync(runtime.instructionsFile)).toBe(true);
            expect(existsSync(runtime.manifestFile)).toBe(true);
            expect(existsSync(runtime.ledgerFile)).toBe(true);
            expect(existsSync(runtime.latestEvaluatorFile)).toBe(true);
            expect(existsSync(runtime.resultsFile)).toBe(true);
            expect(existsSync(join(worktreePath, 'node_modules'))).toBe(true);
            expect(() => assertResetSafeWorktree(worktreePath)).not.toThrow();
            const manifest = JSON.parse(await readFile(runtime.manifestFile, 'utf-8'));
            expect(manifest.mission_slug).toBe('missions-demo');
            expect(manifest.branch_name).toBe('autoresearch/missions-demo/20260314t000000z');
            expect(manifest.mission_dir).toBe(join(worktreePath, 'missions', 'demo'));
            expect(manifest.worktree_path).toBe(worktreePath);
            expect(manifest.results_file).toBe(runtime.resultsFile);
            expect(typeof manifest.baseline_commit).toBe('string');
            const ledger = JSON.parse(await readFile(runtime.ledgerFile, 'utf-8'));
            expect(Array.isArray(ledger.entries)).toBe(true);
            expect(ledger.entries.length).toBe(1);
            const latestEvaluator = JSON.parse(await readFile(runtime.latestEvaluatorFile, 'utf-8'));
            expect(latestEvaluator.status).toBe('pass');
            expect(latestEvaluator.pass).toBe(true);
            expect(latestEvaluator.score).toBe(1);
            const results = await readFile(runtime.resultsFile, 'utf-8');
            expect(results).toMatch(/^iteration	commit	pass	score	status	description$/m);
            expect(results).toMatch(/^0	.+	true	1	baseline	initial baseline evaluation$/m);
            const state = readModeState('autoresearch', repo);
            expect(state).toBeTruthy();
            const worktreeState = readModeState('autoresearch', worktreePath);
            expect(worktreeState).toBeNull();
            expect(state?.active).toBe(true);
            expect(state?.current_phase).toBe('running');
            expect(state?.mission_slug).toBe('missions-demo');
            expect(state?.mission_dir).toBe(join(worktreePath, 'missions', 'demo'));
            expect(state?.worktree_path).toBe(worktreePath);
            expect(state?.bootstrap_instructions_path).toBe(runtime.instructionsFile);
            expect(state?.latest_evaluator_status).toBe('pass');
            expect(state?.results_file).toBe(runtime.resultsFile);
            expect(state?.baseline_commit).toBe(manifest.baseline_commit);
            expect(state?.mission_spec_file).toBe(join(repo, '.omc', 'autoresearch', 'missions-demo', 'mission.md'));
            expect(state?.evaluator_reference_file).toBe(join(repo, '.omc', 'autoresearch', 'missions-demo', 'evaluator.json'));
            const instructions = await readFile(runtime.instructionsFile, 'utf-8');
            expect(instructions).toMatch(/Last kept score:\s+1/i);
            expect(instructions).toMatch(/previous_iteration_outcome/i);
            expect(instructions).toMatch(/baseline established/i);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('materializes canonical mission artifacts and markdown decision log paths', async () => {
        const repo = await initRepo();
        try {
            const contract = await makeContract(repo);
            const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t000500z');
            execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t000500z', worktreePath, 'HEAD'], {
                cwd: repo,
                stdio: 'ignore',
            });
            const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
            const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, {
                runTag: '20260314T000500Z',
                maxRuntimeMs: 60000,
            });
            const layout = getAutoresearchMissionArtifactLayout(repo, contract.missionSlug, runtime.runId);
            expect(existsSync(layout.missionSpecFile)).toBe(true);
            expect(existsSync(layout.evaluatorReferenceFile)).toBe(true);
            expect(existsSync(layout.decisionLogFile)).toBe(true);
            const decisionLog = await readFile(layout.decisionLogFile, 'utf-8');
            expect(decisionLog).toContain('# Autoresearch Decision Log');
            expect(decisionLog).toContain('## Iteration 0 — baseline');
            const missionSpec = await readFile(layout.missionSpecFile, 'utf-8');
            expect(missionSpec).toContain('# Mission');
            const evaluatorRef = JSON.parse(await readFile(layout.evaluatorReferenceFile, 'utf-8'));
            expect(evaluatorRef.command).toBe('node scripts/eval.js');
            expect(evaluatorRef.format).toBe('json');
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
describe('autoresearch parity decisions', () => {
    it('keeps improved candidates and resets discarded candidates back to the last kept commit', async () => {
        const repo = await initRepo();
        try {
            const contract = await makeContract(repo);
            const worktreePath = join(repo, '..', `${repo.split('/').pop()}.omc-worktrees`, 'autoresearch-missions-demo-20260314t010000z');
            execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t010000z', worktreePath, 'HEAD'], {
                cwd: repo,
                stdio: 'ignore',
            });
            const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
            const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T010000Z' });
            await writeFile(join(worktreePath, 'score.txt'), '2\n', 'utf-8');
            execFileSync('git', ['add', 'score.txt'], { cwd: worktreePath, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'improve score'], { cwd: worktreePath, stdio: 'ignore' });
            const improvedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
            const initialManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
            await writeFile(runtime.candidateFile, `${JSON.stringify({
                status: 'candidate',
                candidate_commit: improvedCommit,
                base_commit: initialManifest.last_kept_commit,
                description: 'improved score',
                notes: ['score raised to 2'],
                created_at: '2026-03-14T01:00:00.000Z',
            }, null, 2)}\n`, 'utf-8');
            const keepDecision = await processAutoresearchCandidate(worktreeContract, initialManifest, repo);
            expect(keepDecision).toBe('keep');
            const keptManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
            expect(keptManifest.last_kept_commit).toBe(improvedCommit);
            await writeFile(join(worktreePath, 'score.txt'), '1\n', 'utf-8');
            execFileSync('git', ['add', 'score.txt'], { cwd: worktreePath, stdio: 'ignore' });
            execFileSync('git', ['commit', '-m', 'worse score'], { cwd: worktreePath, stdio: 'ignore' });
            const worseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
            const beforeDiscardManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
            await writeFile(runtime.candidateFile, `${JSON.stringify({
                status: 'candidate',
                candidate_commit: worseCommit,
                base_commit: beforeDiscardManifest.last_kept_commit,
                description: 'worse score',
                notes: ['score dropped back to 1'],
                created_at: '2026-03-14T01:05:00.000Z',
            }, null, 2)}\n`, 'utf-8');
            const discardDecision = await processAutoresearchCandidate(worktreeContract, beforeDiscardManifest, repo);
            expect(discardDecision).toBe('discard');
            const headAfterDiscard = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
            expect(headAfterDiscard).toBe(improvedCommit);
            const finalManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
            const results = await readFile(runtime.resultsFile, 'utf-8');
            expect(results).toMatch(/^1\t.+\ttrue\t2\tkeep\timproved score$/m);
            expect(results).toMatch(/^2\t.+\ttrue\t1\tdiscard\tworse score$/m);
            const ledger = JSON.parse(await readFile(runtime.ledgerFile, 'utf-8'));
            expect(ledger.entries.length).toBe(3);
            expect(ledger.entries.map((entry) => [entry.decision, entry.description])).toEqual([
                ['baseline', 'initial baseline evaluation'],
                ['keep', 'improved score'],
                ['discard', 'worse score'],
            ]);
            const instructions = await readFile(runtime.instructionsFile, 'utf-8');
            expect(instructions).toMatch(/"previous_iteration_outcome": "discard:score did not improve"/);
            expect(instructions).toMatch(/"decision": "keep"/);
            expect(instructions).toMatch(/"decision": "discard"/);
            expect(finalManifest.last_kept_commit).toBe(improvedCommit);
            const decisionLog = await readFile(join(repo, '.omc', 'autoresearch', 'missions-demo', 'runs', runtime.runId, 'decision-log.md'), 'utf-8');
            expect(decisionLog).toContain('## Iteration 1 — keep');
            expect(decisionLog).toContain('## Iteration 2 — discard');
            const evaluationOne = JSON.parse(await readFile(join(repo, '.omc', 'autoresearch', 'missions-demo', 'runs', runtime.runId, 'evaluations', 'iteration-0001.json'), 'utf-8'));
            expect(evaluationOne.pass).toBe(true);
            expect(evaluationOne.score).toBe(2);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
describe('autoresearch startup exclusivity', () => {
    it('blocks startup when a session-scoped ralph state is active', async () => {
        const repo = await initRepo();
        try {
            expect(writeModeState('ralph', { active: true }, repo, 'session-a')).toBe(true);
            await expect(assertModeStartAllowed('autoresearch', repo)).rejects.toThrow('Cannot start autoresearch: ralph is already active');
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('blocks startup when legacy shared exclusive-mode state is active', async () => {
        const repo = await initRepo();
        try {
            expect(writeModeState('autopilot', { active: true }, repo)).toBe(true);
            await expect(assertModeStartAllowed('autoresearch', repo)).rejects.toThrow('Cannot start autoresearch: autopilot is already active');
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=runtime.test.js.map
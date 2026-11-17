import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLaunchReadyEvaluatorCommand, resolveAutoresearchDeepInterviewResult, writeAutoresearchDeepInterviewArtifacts, writeAutoresearchDraftArtifact, } from '../autoresearch-intake.js';
async function initRepo() {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-autoresearch-intake-test-'));
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
    return cwd;
}
describe('autoresearch intake draft artifacts', () => {
    it('writes a canonical deep-interview autoresearch draft artifact from vague input', async () => {
        const repo = await initRepo();
        try {
            const artifact = await writeAutoresearchDraftArtifact({
                repoRoot: repo,
                topic: 'Improve onboarding for first-time contributors',
                keepPolicy: 'score_improvement',
                seedInputs: { topic: 'Improve onboarding for first-time contributors' },
            });
            expect(artifact.path).toMatch(/\.omc\/specs\/deep-interview-autoresearch-improve-onboarding-for-first-time-contributors\.md$/);
            expect(artifact.launchReady).toBe(false);
            expect(artifact.content).toMatch(/## Mission Draft/);
            expect(artifact.content).toMatch(/## Evaluator Draft/);
            expect(artifact.content).toMatch(/## Launch Readiness/);
            expect(artifact.content).toMatch(/## Seed Inputs/);
            expect(artifact.content).toMatch(/## Confirmation Bridge/);
            expect(artifact.content).toMatch(/TODO replace with evaluator command/i);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('rejects placeholder evaluator commands and accepts concrete commands', () => {
        expect(isLaunchReadyEvaluatorCommand('TODO replace me')).toBe(false);
        expect(isLaunchReadyEvaluatorCommand('node scripts/eval.js')).toBe(true);
        expect(isLaunchReadyEvaluatorCommand('bash scripts/eval.sh')).toBe(true);
    });
    it('writes launch-consumable mission/sandbox/result artifacts', async () => {
        const repo = await initRepo();
        try {
            const artifacts = await writeAutoresearchDeepInterviewArtifacts({
                repoRoot: repo,
                topic: 'Measure onboarding friction',
                evaluatorCommand: 'node scripts/eval.js',
                keepPolicy: 'pass_only',
                slug: 'onboarding-friction',
                seedInputs: { topic: 'Measure onboarding friction' },
            });
            expect(artifacts.draftArtifactPath).toMatch(/deep-interview-autoresearch-onboarding-friction\.md$/);
            expect(artifacts.missionArtifactPath).toMatch(/autoresearch-onboarding-friction\/mission\.md$/);
            expect(artifacts.sandboxArtifactPath).toMatch(/autoresearch-onboarding-friction\/sandbox\.md$/);
            expect(artifacts.resultPath).toMatch(/autoresearch-onboarding-friction\/result\.json$/);
            const resultJson = JSON.parse(await readFile(artifacts.resultPath, 'utf-8'));
            const missionContent = await readFile(artifacts.missionArtifactPath, 'utf-8');
            const sandboxContent = await readFile(artifacts.sandboxArtifactPath, 'utf-8');
            expect(resultJson.kind).toBe('omc.autoresearch.deep-interview/v1');
            expect(resultJson.compileTarget.slug).toBe('onboarding-friction');
            expect(resultJson.compileTarget.keepPolicy).toBe('pass_only');
            expect(resultJson.launchReady).toBe(true);
            expect(missionContent).toMatch(/Measure onboarding friction/);
            expect(sandboxContent).toMatch(/command: node scripts\/eval\.js/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('throws a domain error when mission.md is missing from a persisted result', async () => {
        const repo = await initRepo();
        try {
            const artifacts = await writeAutoresearchDeepInterviewArtifacts({
                repoRoot: repo,
                topic: 'Partial write test',
                evaluatorCommand: 'node scripts/eval.js',
                keepPolicy: 'score_improvement',
                slug: 'partial-write',
                seedInputs: { topic: 'Partial write test' },
            });
            await unlink(artifacts.missionArtifactPath);
            await expect(resolveAutoresearchDeepInterviewResult(repo, { slug: 'partial-write' })).rejects.toThrow(/Missing mission artifact/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('throws a domain error when sandbox.md is missing from a persisted result', async () => {
        const repo = await initRepo();
        try {
            const artifacts = await writeAutoresearchDeepInterviewArtifacts({
                repoRoot: repo,
                topic: 'Partial write test',
                evaluatorCommand: 'node scripts/eval.js',
                keepPolicy: 'score_improvement',
                slug: 'partial-sandbox',
                seedInputs: { topic: 'Partial write test' },
            });
            await unlink(artifacts.sandboxArtifactPath);
            await expect(resolveAutoresearchDeepInterviewResult(repo, { slug: 'partial-sandbox' })).rejects.toThrow(/Missing sandbox artifact/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('writes a blocked draft artifact when evaluator is still a placeholder', async () => {
        const repo = await initRepo();
        try {
            const artifact = await writeAutoresearchDraftArtifact({
                repoRoot: repo,
                topic: 'Draft only mission',
                evaluatorCommand: 'TODO replace with evaluator command',
                keepPolicy: 'score_improvement',
                slug: 'draft-only-mission',
            });
            expect(artifact.compileTarget.slug).toBe('draft-only-mission');
            expect(artifact.launchReady).toBe(false);
            expect(artifact.blockedReasons[0]).toMatch(/placeholder\/template/);
            const draftContent = await readFile(artifact.path, 'utf-8');
            expect(draftContent).toMatch(/Launch-ready: no/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=autoresearch-intake.test.js.map
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAutoresearchMissionContract, parseEvaluatorResult, parseSandboxContract, slugifyMissionName, } from '../contracts.js';
async function initRepo() {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-autoresearch-contracts-'));
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
    return cwd;
}
describe('autoresearch contracts', () => {
    it('slugifies mission names deterministically', () => {
        expect(slugifyMissionName('Missions/My Demo Mission')).toBe('missions-my-demo-mission');
    });
    it('parses sandbox contract with evaluator command and json format', () => {
        const parsed = parseSandboxContract(`---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n---\nStay in bounds.\n`);
        expect(parsed.evaluator.command).toBe('node scripts/eval.js');
        expect(parsed.evaluator.format).toBe('json');
        expect(parsed.body).toBe('Stay in bounds.');
    });
    it('rejects sandbox contract without frontmatter', () => {
        expect(() => parseSandboxContract('No frontmatter here')).toThrow(/sandbox\.md must start with YAML frontmatter/i);
    });
    it('rejects sandbox contract without evaluator command', () => {
        expect(() => parseSandboxContract(`---\nevaluator:\n  format: json\n---\nPolicy\n`)).toThrow(/evaluator\.command is required/i);
    });
    it('rejects sandbox contract without evaluator format', () => {
        expect(() => parseSandboxContract(`---\nevaluator:\n  command: node eval.js\n---\nPolicy\n`)).toThrow(/evaluator\.format is required/i);
    });
    it('rejects sandbox contract with non-json evaluator format', () => {
        expect(() => parseSandboxContract(`---\nevaluator:\n  command: node eval.js\n  format: text\n---\nPolicy\n`)).toThrow(/evaluator\.format must be json/i);
    });
    it('parses optional evaluator keep_policy', () => {
        const parsed = parseSandboxContract(`---
evaluator:
  command: node scripts/eval.js
  format: json
  keep_policy: pass_only
---
Stay in bounds.
`);
        expect(parsed.evaluator.keep_policy).toBe('pass_only');
    });
    it('rejects unsupported evaluator keep_policy', () => {
        expect(() => parseSandboxContract(`---
evaluator:
  command: node scripts/eval.js
  format: json
  keep_policy: maybe
---
Stay in bounds.
`)).toThrow(/keep_policy must be one of/i);
    });
    it('accepts evaluator result with pass only', () => {
        expect(parseEvaluatorResult('{"pass":true}')).toEqual({ pass: true });
    });
    it('accepts evaluator result with pass and score', () => {
        expect(parseEvaluatorResult('{"pass":false,"score":61}')).toEqual({ pass: false, score: 61 });
    });
    it('rejects evaluator result without pass', () => {
        expect(() => parseEvaluatorResult('{"score":61}')).toThrow(/must include boolean pass/i);
    });
    it('rejects evaluator result with non-numeric score', () => {
        expect(() => parseEvaluatorResult('{"pass":true,"score":"high"}')).toThrow(/score must be numeric/i);
    });
    it('loads mission contract from in-repo mission directory', async () => {
        const repo = realpathSync(await initRepo());
        try {
            const missionDir = join(repo, 'missions', 'demo');
            await mkdir(missionDir, { recursive: true });
            await writeFile(join(missionDir, 'mission.md'), '# Mission\nShip it\n', 'utf-8');
            await writeFile(join(missionDir, 'sandbox.md'), `---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n---\nStay in bounds.\n`, 'utf-8');
            const contract = await loadAutoresearchMissionContract(missionDir);
            expect(contract.repoRoot).toBe(repo);
            expect(contract.missionRelativeDir.replace(/\\/g, '/')).toBe('missions/demo');
            expect(contract.missionSlug).toBe('missions-demo');
            expect(contract.sandbox.evaluator.command).toBe('node scripts/eval.js');
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=contracts.test.js.map
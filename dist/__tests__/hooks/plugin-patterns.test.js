import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateCommitMessage, runPreCommitChecks, runLint, } from '../../hooks/plugin-patterns/index.js';
function makeTempDir() {
    const dir = join(tmpdir(), `omc-plugin-patterns-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}
describe('validateCommitMessage', () => {
    describe('default types (no config)', () => {
        it('accepts a valid conventional commit message', () => {
            const result = validateCommitMessage('feat: add new feature');
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
        it('accepts all default types', () => {
            const defaultTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
            for (const type of defaultTypes) {
                const result = validateCommitMessage(`${type}: some description`);
                expect(result.valid).toBe(true);
            }
        });
        it('rejects an unknown type', () => {
            const result = validateCommitMessage('ship: deploy changes');
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('conventional commit format'))).toBe(true);
        });
        it('includes default type list in error message', () => {
            const result = validateCommitMessage('ship: deploy changes');
            expect(result.errors.some(e => e.includes('feat'))).toBe(true);
        });
    });
    describe('custom types via config.types', () => {
        it('accepts a custom type when configured', () => {
            const result = validateCommitMessage('ship: deploy changes', { types: ['ship', 'rollback'] });
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
        it('rejects a default type not present in the custom list', () => {
            const result = validateCommitMessage('feat: add feature', { types: ['ship', 'rollback'] });
            expect(result.valid).toBe(false);
        });
        it('includes custom types in the error message', () => {
            const result = validateCommitMessage('unknown: change', { types: ['ship', 'rollback'] });
            expect(result.errors.some(e => e.includes('ship'))).toBe(true);
            expect(result.errors.some(e => e.includes('rollback'))).toBe(true);
        });
        it('does not mention default types when custom types are provided', () => {
            const result = validateCommitMessage('unknown: change', { types: ['ship'] });
            // Error should list 'ship', not the whole default set
            const typeError = result.errors.find(e => e.startsWith('Allowed types:'));
            expect(typeError).toBeDefined();
            expect(typeError).toContain('ship');
            expect(typeError).not.toContain('feat');
        });
        it('falls back to default types when config.types is an empty array', () => {
            const result = validateCommitMessage('feat: add feature', { types: [] });
            expect(result.valid).toBe(true);
        });
        it('accepts a custom type with scope', () => {
            const result = validateCommitMessage('ship(api): deploy api changes', { types: ['ship'] });
            expect(result.valid).toBe(true);
        });
        it('accepts a custom type with breaking-change marker', () => {
            const result = validateCommitMessage('ship!: breaking deploy', { types: ['ship'] });
            expect(result.valid).toBe(true);
        });
    });
    describe('other config options still work alongside custom types', () => {
        it('enforces maxSubjectLength with custom types', () => {
            const result = validateCommitMessage('ship: ' + 'a'.repeat(70), {
                types: ['ship'],
                maxSubjectLength: 50,
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('exceeds'))).toBe(true);
        });
        it('enforces requireScope with custom types', () => {
            const result = validateCommitMessage('ship: change without scope', {
                types: ['ship'],
                requireScope: true,
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('Scope is required'))).toBe(true);
        });
        it('enforces requireBody with custom types', () => {
            const result = validateCommitMessage('ship: change without body', {
                types: ['ship'],
                requireBody: true,
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('body is required'))).toBe(true);
        });
    });
    describe('edge cases', () => {
        it('rejects an empty commit message', () => {
            const result = validateCommitMessage('', { types: ['ship'] });
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Commit message cannot be empty');
        });
        it('rejects a whitespace-only commit message', () => {
            const result = validateCommitMessage('   ', { types: ['ship'] });
            expect(result.valid).toBe(false);
        });
    });
});
describe('runPreCommitChecks', () => {
    let testDir;
    beforeEach(() => {
        testDir = makeTempDir();
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });
    it('includes a Tests check in results', () => {
        const result = runPreCommitChecks(testDir);
        const names = result.checks.map(c => c.name);
        expect(names).toContain('Tests');
    });
    it('includes a Lint check in results', () => {
        const result = runPreCommitChecks(testDir);
        const names = result.checks.map(c => c.name);
        expect(names).toContain('Lint');
    });
    it('includes a Type Check in results', () => {
        const result = runPreCommitChecks(testDir);
        const names = result.checks.map(c => c.name);
        expect(names).toContain('Type Check');
    });
    it('returns canCommit: false when tests fail', () => {
        writeFileSync(join(testDir, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
        const result = runPreCommitChecks(testDir);
        const testCheck = result.checks.find(c => c.name === 'Tests');
        expect(testCheck).toBeDefined();
        expect(testCheck.passed).toBe(false);
        expect(result.canCommit).toBe(false);
    });
    it('returns canCommit: false when lint fails', () => {
        writeFileSync(join(testDir, 'package.json'), JSON.stringify({ scripts: { lint: 'exit 1' } }));
        const result = runPreCommitChecks(testDir);
        const lintCheck = result.checks.find(c => c.name === 'Lint');
        expect(lintCheck).toBeDefined();
        expect(lintCheck.passed).toBe(false);
        expect(result.canCommit).toBe(false);
    });
    it('returns canCommit: true when no test runner and no lint script found', () => {
        const result = runPreCommitChecks(testDir);
        expect(result.canCommit).toBe(true);
        const testCheck = result.checks.find(c => c.name === 'Tests');
        const lintCheck = result.checks.find(c => c.name === 'Lint');
        expect(testCheck.passed).toBe(true);
        expect(lintCheck.passed).toBe(true);
    });
    it('returns canCommit: false when commit message is invalid', () => {
        const result = runPreCommitChecks(testDir, 'bad commit message without type');
        const commitCheck = result.checks.find(c => c.name === 'Commit Message');
        expect(commitCheck).toBeDefined();
        expect(commitCheck.passed).toBe(false);
        expect(result.canCommit).toBe(false);
    });
    it('includes Commit Message check only when commitMessage is provided', () => {
        const withoutMsg = runPreCommitChecks(testDir);
        expect(withoutMsg.checks.find(c => c.name === 'Commit Message')).toBeUndefined();
        const withMsg = runPreCommitChecks(testDir, 'feat(scope): add feature');
        expect(withMsg.checks.find(c => c.name === 'Commit Message')).toBeDefined();
    });
});
describe('runLint', () => {
    let testDir;
    beforeEach(() => {
        testDir = makeTempDir();
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    it('returns success when no package.json exists', () => {
        const result = runLint(testDir);
        expect(result.success).toBe(true);
        expect(result.message).toContain('No lint script found');
    });
    it('returns success when package.json has no lint script', () => {
        writeFileSync(join(testDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
        const result = runLint(testDir);
        expect(result.success).toBe(true);
        expect(result.message).toContain('No lint script found');
    });
    it('returns failure when lint script exits with error', () => {
        writeFileSync(join(testDir, 'package.json'), JSON.stringify({ scripts: { lint: 'this-command-should-fail' } }));
        const result = runLint(testDir);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Lint errors found');
    });
    it('returns success when lint script passes', () => {
        writeFileSync(join(testDir, 'package.json'), JSON.stringify({ scripts: { lint: 'echo lint-ok' } }));
        const result = runLint(testDir);
        expect(result.success).toBe(true);
        expect(result.message).toContain('Lint passed');
    });
});
//# sourceMappingURL=plugin-patterns.test.js.map
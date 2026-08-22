/**
 * Regression tests for issue #3653: rules-injector unbounded upward walk
 * when no project root exists.
 *
 * findRuleFiles(projectRoot, currentFile) used to ascend from the current
 * file's directory all the way to the filesystem root whenever projectRoot
 * was null, so unrelated ancestor .cursor/rules, .claude/rules, and
 * .github/instructions directories were treated as project rules. With no
 * project root, only the current file's own directory's project-rule
 * subdirectories are in scope; the explicit user-level
 * [$CLAUDE_CONFIG_DIR|~/.claude]/rules lookup is separate and unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findProjectRoot, findRuleFiles } from './finder.js';
const PROJECT_RULE_SUBDIRS = [
    ['.github', 'instructions'],
    ['.cursor', 'rules'],
    ['.claude', 'rules'],
];
function tmpDir() {
    const p = join(tmpdir(), `omc-3653-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(p, { recursive: true });
    return p;
}
/** Write a rule file into <dir>/<parent>/<subdir>/<name>. */
function addRule(dir, parent, subdir, name) {
    const ruleDir = join(dir, parent, subdir);
    mkdirSync(ruleDir, { recursive: true });
    const full = join(ruleDir, name);
    writeFileSync(full, `# ${name}\nRule content`);
    return full;
}
function addFile(dir, relPath) {
    const full = join(dir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// test');
    return full;
}
function nonGlobal(candidates) {
    return candidates.filter((c) => !c.isGlobal);
}
describe('findRuleFiles with no project root (issue #3653)', () => {
    let base;
    beforeEach(() => {
        base = tmpDir();
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });
    it('does not discover ancestor rules when projectRoot is null', () => {
        // Ancestor dir with all three project-rule subdir kinds, but NO project
        // marker anywhere, and the current file deep beneath them.
        const ancestor = join(base, 'ancestor');
        for (const [parent, subdir] of PROJECT_RULE_SUBDIRS) {
            const name = subdir === 'instructions'
                ? 'coding.instructions.md'
                : `ancestor-${subdir}.mdc`;
            addRule(ancestor, parent, subdir, name);
        }
        const currentFile = addFile(ancestor, 'sub/deep/no-marker-project/src/current.ts');
        expect(findProjectRoot(currentFile)).toBeNull();
        const candidates = findRuleFiles(null, currentFile);
        const projectRules = nonGlobal(candidates);
        for (const rule of projectRules) {
            expect(rule.path).not.toContain('ancestor');
        }
        expect(projectRules).toHaveLength(0);
    });
    it.each(PROJECT_RULE_SUBDIRS)('still inspects the current file\'s own directory for %s/%s', (parent, subdir) => {
        const own = join(base, 'own');
        const name = subdir === 'instructions' ? 'coding.instructions.md' : 'own.mdc';
        addRule(own, parent, subdir, name);
        const currentFile = addFile(own, 'current.ts');
        expect(findProjectRoot(currentFile)).toBeNull();
        const candidates = findRuleFiles(null, currentFile);
        const projectRules = nonGlobal(candidates);
        expect(projectRules).toHaveLength(1);
        expect(projectRules[0].path).toBe(join(own, parent, subdir, name));
        expect(projectRules[0].isGlobal).toBe(false);
        expect(projectRules[0].distance).toBe(0);
    });
    it('preserves explicit user-level CLAUDE_CONFIG_DIR/rules discovery', () => {
        const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
        try {
            // Unrelated ancestor .claude/rules that must NOT be treated as project
            // rules when no project root exists.
            addRule(join(base, 'ancestor'), '.claude', 'rules', 'ancestor.mdc');
            const currentFile = addFile(base, 'sub/no-marker/src/current.ts');
            const configDir = join(base, 'config');
            const userRule = addRule(configDir, '.', 'rules', 'user-rule.md');
            process.env.CLAUDE_CONFIG_DIR = configDir;
            expect(findProjectRoot(currentFile)).toBeNull();
            const candidates = findRuleFiles(null, currentFile);
            const globalRules = candidates.filter((c) => c.isGlobal);
            const projectRules = nonGlobal(candidates);
            expect(projectRules).toHaveLength(0);
            expect(globalRules.some((c) => c.path === userRule)).toBe(true);
        }
        finally {
            if (originalConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            }
            else {
                process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
            }
        }
    });
});
describe('findRuleFiles with a project root (unchanged bounded walk)', () => {
    let base;
    beforeEach(() => {
        base = tmpDir();
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });
    it('discovers rules up to the project root but never above it', () => {
        // A rule dir ABOVE the project root must stay out of scope.
        addRule(join(base, 'parent'), '.cursor', 'rules', 'parent-ancestor.mdc');
        const project = join(base, 'parent', 'project');
        mkdirSync(join(project, '.git'), { recursive: true });
        const projectRule = addRule(project, '.claude', 'rules', 'project.mdc');
        const currentFile = addFile(project, 'src/deep/current.ts');
        expect(findProjectRoot(currentFile)).toBe(project);
        const candidates = findRuleFiles(project, currentFile);
        const projectRules = nonGlobal(candidates);
        expect(projectRules.some((c) => c.path === projectRule)).toBe(true);
        expect(projectRules.some((c) => c.path.includes('parent-ancestor'))).toBe(false);
    });
    it('computes distance from the current file up to the rule directory', () => {
        const project = join(base, 'project');
        mkdirSync(join(project, '.git'), { recursive: true });
        addRule(project, '.cursor', 'rules', 'root.mdc');
        // One level deep: current.ts sits in <root>/src, rule in <root>/.cursor.
        const currentFile = addFile(project, 'src/current.ts');
        const candidates = findRuleFiles(project, currentFile);
        const projectRules = nonGlobal(candidates);
        expect(projectRules).toHaveLength(1);
        // src -> root is one ascent step.
        expect(projectRules[0].distance).toBe(1);
    });
});
//# sourceMappingURL=finder.test.js.map
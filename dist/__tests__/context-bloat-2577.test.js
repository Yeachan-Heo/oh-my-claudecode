/**
 * Regression tests for issue #2577: context window bloat
 *
 * Three bugs fixed:
 *  Bug 1 – Skill-injector fallback used an in-memory Map that reset on every
 *           process spawn.  Fixed by persisting state to a JSON file.
 *  Bug 2 – Rules-injector module was never wired into hooks.json.
 *           Fixed by adding post-tool-rules-injector.mjs to PostToolUse.
 *  Bug 3 – In a git worktree nested inside the parent repo, rules from the
 *           parent repo could bleed into the worktree session.
 *           Fixed: projectRoot is derived from the accessed FILE's path via
 *           findProjectRoot, not from data.cwd, so the .git FILE at the
 *           worktree root terminates the upward walk before the parent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRulesInjectorHook, clearInjectedRules, } from '../hooks/rules-injector/index.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tmpDir() {
    const p = join(tmpdir(), `omc-2577-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(p, { recursive: true });
    return p;
}
function makeProjectRoot(dir) {
    // Simulate a git repo root by writing a .git FILE (as git worktree does)
    writeFileSync(join(dir, '.git'), 'gitdir: placeholder');
}
/** Wrap content with alwaysApply frontmatter so shouldApplyRule returns applies:true */
function ruleContent(body) {
    return `---\nalwaysApply: true\n---\n${body}`;
}
function addRule(projectDir, name, content, subdir = '.claude/rules') {
    const rulesDir = join(projectDir, subdir);
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, name), content);
}
function addFile(projectDir, relPath) {
    const full = join(projectDir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// test');
    return full;
}
// ---------------------------------------------------------------------------
// Bug 2 – rules-injector injection correctness
// ---------------------------------------------------------------------------
describe('Bug 2 – rules-injector injects on first access, deduplicates on second', () => {
    let dir;
    let sessionId;
    beforeEach(() => {
        dir = tmpDir();
        makeProjectRoot(dir);
        sessionId = `s-${Date.now()}`;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        clearInjectedRules(sessionId);
    });
    it('injects rule content on the first read of a project file', () => {
        addRule(dir, 'style.md', ruleContent('# Style Guide\nUse single quotes.'));
        const file = addFile(dir, 'src/foo.ts');
        const hook = createRulesInjectorHook(dir);
        const result = hook.processToolExecution('read', file, sessionId);
        expect(result).toContain('Style Guide');
        expect(result).toContain('style.md');
    });
    it('does NOT re-inject the same rule on a subsequent file access (content-hash dedup)', () => {
        addRule(dir, 'style.md', ruleContent('# Style Guide\nUse single quotes.'));
        const file1 = addFile(dir, 'src/foo.ts');
        const file2 = addFile(dir, 'src/bar.ts');
        const hook = createRulesInjectorHook(dir);
        const first = hook.processToolExecution('read', file1, sessionId);
        const second = hook.processToolExecution('read', file2, sessionId);
        expect(first).toBeTruthy(); // injected first time
        expect(second).toBe(''); // same content-hash → skip
    });
    it('does NOT re-inject when a new hook instance loads the same session (file-backed dedup)', () => {
        addRule(dir, 'style.md', ruleContent('# Style Guide\nUse single quotes.'));
        const file = addFile(dir, 'src/foo.ts');
        // First hook instance (simulates first process spawn)
        const hook1 = createRulesInjectorHook(dir);
        hook1.processToolExecution('read', file, sessionId);
        // Second hook instance with same sessionId (simulates next process spawn)
        const hook2 = createRulesInjectorHook(dir);
        const result = hook2.processToolExecution('read', file, sessionId);
        expect(result).toBe(''); // already injected → skip
    });
    it('returns empty string for non-tracked tools', () => {
        addRule(dir, 'style.md', ruleContent('# Style Guide\nUse single quotes.'));
        const file = addFile(dir, 'src/foo.ts');
        const hook = createRulesInjectorHook(dir);
        expect(hook.processToolExecution('bash', file, sessionId)).toBe('');
        expect(hook.processToolExecution('listfiles', file, sessionId)).toBe('');
    });
    it('injects rules from .github/instructions', () => {
        addRule(dir, 'coding.instructions.md', ruleContent('# Coding Instructions\nAlways add tests.'), '.github/instructions');
        const file = addFile(dir, 'src/feature.ts');
        const hook = createRulesInjectorHook(dir);
        const result = hook.processToolExecution('edit', file, sessionId);
        expect(result).toContain('Always add tests');
    });
    it('handles multiedit tool', () => {
        addRule(dir, 'style.md', ruleContent('# Style\nNo semicolons.'));
        const file = addFile(dir, 'src/multi.ts');
        const hook = createRulesInjectorHook(dir);
        const result = hook.processToolExecution('multiedit', file, sessionId);
        expect(result).toContain('No semicolons');
    });
});
// ---------------------------------------------------------------------------
// Bug 3 – worktree isolation: parent-repo rules must not bleed in
// ---------------------------------------------------------------------------
describe('Bug 3 – nested worktree isolation: only worktree rules are injected', () => {
    let base;
    let mainRepo;
    let worktree;
    let sessionId;
    beforeEach(() => {
        // Layout:
        //   base/               ← main repo (.git/ directory)
        //     .claude/rules/main.md
        //     src/main.ts
        //     feature/          ← nested git worktree (.git FILE)
        //       .claude/rules/feature.md
        //       src/feature.ts
        base = tmpDir();
        mainRepo = base;
        worktree = join(base, 'feature');
        // Main repo: use a .git DIRECTORY to simulate a real repo root
        mkdirSync(join(mainRepo, '.git'), { recursive: true });
        addRule(mainRepo, 'main.md', ruleContent('# Main Repo Rule'));
        addFile(mainRepo, 'src/main.ts');
        // Nested worktree: .git FILE stops findProjectRoot before the parent
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(worktree, '.git'), 'gitdir: ../.git/worktrees/feature');
        addRule(worktree, 'feature.md', ruleContent('# Feature Branch Rule'));
        addFile(worktree, 'src/feature.ts');
        sessionId = `wt-${Date.now()}`;
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
        clearInjectedRules(sessionId);
    });
    it('injects only worktree rules when accessing a worktree file, even when cwd=mainRepo', () => {
        // Claude was started from mainRepo (data.cwd = mainRepo) but accesses a
        // worktree file.  findProjectRoot(file) finds worktree/.git FILE first.
        const hook = createRulesInjectorHook(mainRepo);
        const result = hook.processToolExecution('read', join(worktree, 'src', 'feature.ts'), sessionId);
        expect(result).toContain('Feature Branch Rule');
        expect(result).not.toContain('Main Repo Rule');
    });
    it('injects only main-repo rules when accessing a main-repo file', () => {
        const hook = createRulesInjectorHook(mainRepo);
        const result = hook.processToolExecution('read', join(mainRepo, 'src', 'main.ts'), sessionId);
        expect(result).toContain('Main Repo Rule');
        expect(result).not.toContain('Feature Branch Rule');
    });
    it('deduplicates across roots within the same session', () => {
        // Access worktree file → feature rule injected
        const hook = createRulesInjectorHook(mainRepo);
        const r1 = hook.processToolExecution('read', join(worktree, 'src', 'feature.ts'), sessionId);
        expect(r1).toContain('Feature Branch Rule');
        // Access same worktree file again → already injected
        const r2 = hook.processToolExecution('read', join(worktree, 'src', 'feature.ts'), sessionId);
        expect(r2).toBe('');
    });
});
//# sourceMappingURL=context-bloat-2577.test.js.map
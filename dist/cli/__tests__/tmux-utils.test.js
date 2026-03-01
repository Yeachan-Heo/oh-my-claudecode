/**
 * Tests for src/cli/tmux-utils.ts
 *
 * Covers:
 * - buildTmuxSessionName worktree mode (issue #1088)
 * - sanitizeTmuxToken
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFileSync: vi.fn(),
    };
});
import { buildTmuxSessionName, sanitizeTmuxToken } from '../tmux-utils.js';
// ---------------------------------------------------------------------------
// sanitizeTmuxToken
// ---------------------------------------------------------------------------
describe('sanitizeTmuxToken', () => {
    it('lowercases and replaces non-alphanumeric with hyphens', () => {
        expect(sanitizeTmuxToken('My_Project.Name')).toBe('my-project-name');
    });
    it('strips leading and trailing hyphens', () => {
        expect(sanitizeTmuxToken('--hello--')).toBe('hello');
    });
    it('returns "unknown" for empty result', () => {
        expect(sanitizeTmuxToken('...')).toBe('unknown');
    });
});
// ---------------------------------------------------------------------------
// buildTmuxSessionName — default (no worktree)
// ---------------------------------------------------------------------------
describe('buildTmuxSessionName — default mode', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        // Mock git branch detection
        execFileSync.mockReturnValue('main\n');
    });
    it('uses basename of cwd as dirToken', () => {
        const name = buildTmuxSessionName('/home/user/projects/myapp');
        expect(name).toMatch(/^omc-myapp-main-\d{14}$/);
    });
    it('only includes the last path segment', () => {
        const name = buildTmuxSessionName('/home/user/Workspace/omc-worktrees/feat/issue-1088');
        // Default mode: only basename "issue-1088"
        expect(name).toMatch(/^omc-issue-1088-main-\d{14}$/);
    });
});
// ---------------------------------------------------------------------------
// buildTmuxSessionName — worktree mode (issue #1088)
// ---------------------------------------------------------------------------
describe('buildTmuxSessionName — worktree mode', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        execFileSync.mockReturnValue('dev\n');
    });
    it('includes last 2 path segments when worktree option is enabled', () => {
        const name = buildTmuxSessionName('/home/user/Workspace/omc-worktrees/feat/issue-1088', { worktree: true });
        // Should include "feat-issue-1088" instead of just "issue-1088"
        expect(name).toMatch(/^omc-feat-issue-1088-dev-\d{14}$/);
    });
    it('includes parent context for better identification', () => {
        const name = buildTmuxSessionName('/home/user/Workspace/omc-worktrees/pr/myrepo-42', { worktree: true });
        expect(name).toMatch(/^omc-pr-myrepo-42-dev-\d{14}$/);
    });
    it('handles single-segment paths gracefully', () => {
        const name = buildTmuxSessionName('/myapp', { worktree: true });
        expect(name).toMatch(/^omc-myapp-dev-\d{14}$/);
    });
    it('handles trailing slashes', () => {
        const name = buildTmuxSessionName('/home/user/feat/issue-99/', { worktree: true });
        expect(name).toMatch(/^omc-feat-issue-99-dev-\d{14}$/);
    });
    it('falls back to basename behavior when worktree is false', () => {
        const name = buildTmuxSessionName('/home/user/feat/issue-1088', { worktree: false });
        expect(name).toMatch(/^omc-issue-1088-dev-\d{14}$/);
    });
    it('truncates session name to 120 chars max', () => {
        const longPath = '/home/user/' + 'a'.repeat(60) + '/' + 'b'.repeat(60);
        const name = buildTmuxSessionName(longPath, { worktree: true });
        expect(name.length).toBeLessThanOrEqual(120);
    });
});
//# sourceMappingURL=tmux-utils.test.js.map
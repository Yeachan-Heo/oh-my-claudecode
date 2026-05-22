import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getGitRepoName, getGitBranch, getWorktreeInfo, renderGitRepo, renderGitBranch, resetGitCache } from '../../hud/elements/git.js';
// Mock child_process.execFileSync
vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));
import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);
describe('git elements', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetGitCache();
    });
    describe('getGitRepoName', () => {
        it('extracts repo name from HTTPS URL', () => {
            mockExecFileSync.mockReturnValue('https://github.com/user/my-repo.git\n');
            expect(getGitRepoName()).toBe('my-repo');
        });
        it('extracts repo name from HTTPS URL without .git', () => {
            mockExecFileSync.mockReturnValue('https://github.com/user/my-repo\n');
            expect(getGitRepoName()).toBe('my-repo');
        });
        it('extracts repo name from SSH URL', () => {
            mockExecFileSync.mockReturnValue('git@github.com:user/my-repo.git\n');
            expect(getGitRepoName()).toBe('my-repo');
        });
        it('extracts repo name from SSH URL without .git', () => {
            mockExecFileSync.mockReturnValue('git@github.com:user/my-repo\n');
            expect(getGitRepoName()).toBe('my-repo');
        });
        it('returns null when git command fails', () => {
            mockExecFileSync.mockImplementation(() => {
                throw new Error('Not a git repository');
            });
            expect(getGitRepoName()).toBeNull();
        });
        it('returns null for empty output', () => {
            mockExecFileSync.mockReturnValue('');
            expect(getGitRepoName()).toBeNull();
        });
        it('passes cwd option to execFileSync', () => {
            mockExecFileSync.mockReturnValue('https://github.com/user/repo.git\n');
            getGitRepoName('/some/path');
            expect(mockExecFileSync).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], expect.objectContaining({ cwd: '/some/path', windowsHide: true }));
        });
    });
    describe('getGitBranch', () => {
        it('returns current branch name', () => {
            mockExecFileSync.mockReturnValue('main\n');
            expect(getGitBranch()).toBe('main');
        });
        it('handles feature branch names', () => {
            mockExecFileSync.mockReturnValue('feature/my-feature\n');
            expect(getGitBranch()).toBe('feature/my-feature');
        });
        it('returns null when git command fails', () => {
            mockExecFileSync.mockImplementation(() => {
                throw new Error('Not a git repository');
            });
            expect(getGitBranch()).toBeNull();
        });
        it('returns null for empty output', () => {
            mockExecFileSync.mockReturnValue('');
            expect(getGitBranch()).toBeNull();
        });
        it('passes cwd option to execFileSync', () => {
            mockExecFileSync.mockReturnValue('main\n');
            getGitBranch('/some/path');
            expect(mockExecFileSync).toHaveBeenCalledWith('git', ['branch', '--show-current'], expect.objectContaining({ cwd: '/some/path', windowsHide: true }));
        });
    });
    describe('renderGitRepo', () => {
        it('renders formatted repo name', () => {
            mockExecFileSync.mockReturnValue('https://github.com/user/my-repo.git\n');
            const result = renderGitRepo();
            expect(result).toContain('repo:');
            expect(result).toContain('my-repo');
        });
        it('returns null when repo not available', () => {
            mockExecFileSync.mockImplementation(() => {
                throw new Error('Not a git repository');
            });
            expect(renderGitRepo()).toBeNull();
        });
        it('applies styling', () => {
            mockExecFileSync.mockReturnValue('https://github.com/user/repo.git\n');
            const result = renderGitRepo();
            expect(result).toContain('\x1b['); // contains ANSI escape codes
        });
    });
    describe('getWorktreeInfo', () => {
        it('returns isWorktree false for normal repo', () => {
            mockExecFileSync.mockImplementation((_file, args) => {
                if (args?.join(' ') === 'rev-parse --git-dir')
                    return '.git\n';
                if (args?.join(' ') === 'rev-parse --git-common-dir')
                    return '.git\n';
                return '';
            });
            const result = getWorktreeInfo('/some/repo');
            expect(result.isWorktree).toBe(false);
            expect(result.worktreeName).toBeNull();
        });
        it('detects linked worktree and extracts worktree name from git-dir', () => {
            mockExecFileSync.mockImplementation((_file, args) => {
                if (args?.join(' ') === 'rev-parse --git-dir')
                    return '/main-repo/.git/worktrees/my-wt\n';
                if (args?.join(' ') === 'rev-parse --git-common-dir')
                    return '/main-repo/.git\n';
                return '';
            });
            const result = getWorktreeInfo('/some/worktree');
            expect(result.isWorktree).toBe(true);
            expect(result.worktreeName).toBe('my-wt');
        });
        it('extracts worktree name with nested path segments', () => {
            mockExecFileSync.mockImplementation((_file, args) => {
                if (args?.join(' ') === 'rev-parse --git-dir')
                    return '/repo/.git/worktrees/feature-NAVERCAFE-12345\n';
                if (args?.join(' ') === 'rev-parse --git-common-dir')
                    return '/repo/.git\n';
                return '';
            });
            const result = getWorktreeInfo('/some/worktree');
            expect(result.isWorktree).toBe(true);
            expect(result.worktreeName).toBe('feature-NAVERCAFE-12345');
        });
        it('returns not a worktree when git commands fail', () => {
            mockExecFileSync.mockImplementation(() => {
                throw new Error('Not a git repository');
            });
            const result = getWorktreeInfo();
            expect(result.isWorktree).toBe(false);
            expect(result.worktreeName).toBeNull();
        });
        it('caches result for same cwd', () => {
            mockExecFileSync.mockImplementation((_file, args) => {
                if (args?.join(' ') === 'rev-parse --git-dir')
                    return '.git\n';
                if (args?.join(' ') === 'rev-parse --git-common-dir')
                    return '.git\n';
                return '';
            });
            getWorktreeInfo('/cached/path');
            getWorktreeInfo('/cached/path');
            const gitDirCalls = mockExecFileSync.mock.calls.filter(c => Array.isArray(c[1]) && c[1].join(' ') === 'rev-parse --git-dir');
            expect(gitDirCalls).toHaveLength(1);
        });
    });
    describe('renderGitBranch', () => {
        it('renders formatted branch name', () => {
            mockExecFileSync.mockReturnValue('main\n');
            const result = renderGitBranch();
            expect(result).toContain('branch:');
            expect(result).toContain('main');
        });
        it('returns null when branch not available', () => {
            mockExecFileSync.mockImplementation(() => {
                throw new Error('Not a git repository');
            });
            expect(renderGitBranch()).toBeNull();
        });
        it('applies styling', () => {
            mockExecFileSync.mockReturnValue('main\n');
            const result = renderGitBranch();
            expect(result).toContain('\x1b['); // contains ANSI escape codes
        });
        it('shows worktree suffix with worktree name when in a linked worktree', () => {
            mockExecFileSync.mockImplementation((_file, args) => {
                if (args?.join(' ') === 'branch --show-current')
                    return 'feature-x\n';
                if (args?.join(' ') === 'rev-parse --git-dir')
                    return '/main/.git/worktrees/my-wt\n';
                if (args?.join(' ') === 'rev-parse --git-common-dir')
                    return '/main/.git\n';
                return '';
            });
            const result = renderGitBranch('/some/worktree');
            expect(result).toContain('branch:');
            expect(result).toContain('feature-x');
            expect(result).toContain('wt:');
            expect(result).toContain('my-wt');
        });
        it('does not show worktree suffix in normal repo', () => {
            mockExecFileSync.mockImplementation((_file, args) => {
                if (args?.join(' ') === 'branch --show-current')
                    return 'main\n';
                if (args?.join(' ') === 'rev-parse --git-dir')
                    return '.git\n';
                if (args?.join(' ') === 'rev-parse --git-common-dir')
                    return '.git\n';
                return '';
            });
            const result = renderGitBranch('/some/repo');
            expect(result).toContain('branch:');
            expect(result).toContain('main');
            expect(result).not.toContain('wt:');
        });
    });
});
//# sourceMappingURL=git.test.js.map
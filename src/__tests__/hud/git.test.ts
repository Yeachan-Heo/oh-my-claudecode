import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getGitRepoName, getGitBranch, getWorktreeInfo, renderGitRepo, renderGitBranch, resetGitCache } from '../../hud/elements/git.js';

// Mock child_process.execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
const mockExecSync = vi.mocked(execSync);

describe('git elements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitCache();
  });

  describe('getGitRepoName', () => {
    it('extracts repo name from HTTPS URL', () => {
      mockExecSync.mockReturnValue('https://github.com/user/my-repo.git\n');
      expect(getGitRepoName()).toBe('my-repo');
    });

    it('extracts repo name from HTTPS URL without .git', () => {
      mockExecSync.mockReturnValue('https://github.com/user/my-repo\n');
      expect(getGitRepoName()).toBe('my-repo');
    });

    it('extracts repo name from SSH URL', () => {
      mockExecSync.mockReturnValue('git@github.com:user/my-repo.git\n');
      expect(getGitRepoName()).toBe('my-repo');
    });

    it('extracts repo name from SSH URL without .git', () => {
      mockExecSync.mockReturnValue('git@github.com:user/my-repo\n');
      expect(getGitRepoName()).toBe('my-repo');
    });

    it('returns null when git command fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Not a git repository');
      });
      expect(getGitRepoName()).toBeNull();
    });

    it('returns null for empty output', () => {
      mockExecSync.mockReturnValue('');
      expect(getGitRepoName()).toBeNull();
    });

    it('passes cwd option to execSync', () => {
      mockExecSync.mockReturnValue('https://github.com/user/repo.git\n');
      getGitRepoName('/some/path');
      expect(mockExecSync).toHaveBeenCalledWith(
        'git remote get-url origin',
        expect.objectContaining({ cwd: '/some/path' })
      );
    });
  });

  describe('getGitBranch', () => {
    it('returns current branch name', () => {
      mockExecSync.mockReturnValue('main\n');
      expect(getGitBranch()).toBe('main');
    });

    it('handles feature branch names', () => {
      mockExecSync.mockReturnValue('feature/my-feature\n');
      expect(getGitBranch()).toBe('feature/my-feature');
    });

    it('returns null when git command fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Not a git repository');
      });
      expect(getGitBranch()).toBeNull();
    });

    it('returns null for empty output', () => {
      mockExecSync.mockReturnValue('');
      expect(getGitBranch()).toBeNull();
    });

    it('passes cwd option to execSync', () => {
      mockExecSync.mockReturnValue('main\n');
      getGitBranch('/some/path');
      expect(mockExecSync).toHaveBeenCalledWith(
        'git branch --show-current',
        expect.objectContaining({ cwd: '/some/path' })
      );
    });
  });

  describe('renderGitRepo', () => {
    it('renders formatted repo name', () => {
      mockExecSync.mockReturnValue('https://github.com/user/my-repo.git\n');
      const result = renderGitRepo();
      expect(result).toContain('repo:');
      expect(result).toContain('my-repo');
    });

    it('returns null when repo not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Not a git repository');
      });
      expect(renderGitRepo()).toBeNull();
    });

    it('applies styling', () => {
      mockExecSync.mockReturnValue('https://github.com/user/repo.git\n');
      const result = renderGitRepo();
      expect(result).toContain('\x1b['); // contains ANSI escape codes
    });
  });

  describe('getWorktreeInfo', () => {
    it('returns isWorktree false for normal repo', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'git rev-parse --git-common-dir') return '.git\n';
        return '';
      });
      const result = getWorktreeInfo('/some/repo');
      expect(result.isWorktree).toBe(false);
      expect(result.worktreeName).toBeNull();
    });

    it('detects linked worktree and extracts worktree name from git-dir', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'git rev-parse --git-dir') return '/main-repo/.git/worktrees/my-wt\n';
        if (cmd === 'git rev-parse --git-common-dir') return '/main-repo/.git\n';
        return '';
      });

      const result = getWorktreeInfo('/some/worktree');
      expect(result.isWorktree).toBe(true);
      expect(result.worktreeName).toBe('my-wt');
    });

    it('extracts worktree name with nested path segments', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'git rev-parse --git-dir') return '/repo/.git/worktrees/feature-NAVERCAFE-12345\n';
        if (cmd === 'git rev-parse --git-common-dir') return '/repo/.git\n';
        return '';
      });

      const result = getWorktreeInfo('/some/worktree');
      expect(result.isWorktree).toBe(true);
      expect(result.worktreeName).toBe('feature-NAVERCAFE-12345');
    });

    it('returns not a worktree when git commands fail', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Not a git repository');
      });
      const result = getWorktreeInfo();
      expect(result.isWorktree).toBe(false);
      expect(result.worktreeName).toBeNull();
    });

    it('caches result for same cwd', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'git rev-parse --git-common-dir') return '.git\n';
        return '';
      });

      getWorktreeInfo('/cached/path');
      getWorktreeInfo('/cached/path');

      const gitDirCalls = mockExecSync.mock.calls.filter(c => c[0] === 'git rev-parse --git-dir');
      expect(gitDirCalls).toHaveLength(1);
    });
  });

  describe('renderGitBranch', () => {
    it('renders formatted branch name', () => {
      mockExecSync.mockReturnValue('main\n');
      const result = renderGitBranch();
      expect(result).toContain('branch:');
      expect(result).toContain('main');
    });

    it('returns null when branch not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Not a git repository');
      });
      expect(renderGitBranch()).toBeNull();
    });

    it('applies styling', () => {
      mockExecSync.mockReturnValue('main\n');
      const result = renderGitBranch();
      expect(result).toContain('\x1b['); // contains ANSI escape codes
    });

    it('shows worktree suffix with worktree name when in a linked worktree', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'git branch --show-current') return 'feature-x\n';
        if (cmd === 'git rev-parse --git-dir') return '/main/.git/worktrees/my-wt\n';
        if (cmd === 'git rev-parse --git-common-dir') return '/main/.git\n';
        return '';
      });

      const result = renderGitBranch('/some/worktree');
      expect(result).toContain('branch:');
      expect(result).toContain('feature-x');
      expect(result).toContain('wt:');
      expect(result).toContain('my-wt');
    });

    it('does not show worktree suffix in normal repo', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'git branch --show-current') return 'main\n';
        if (cmd === 'git rev-parse --git-dir') return '.git\n';
        if (cmd === 'git rev-parse --git-common-dir') return '.git\n';
        return '';
      });

      const result = renderGitBranch('/some/repo');
      expect(result).toContain('branch:');
      expect(result).toContain('main');
      expect(result).not.toContain('wt:');
    });
  });
});

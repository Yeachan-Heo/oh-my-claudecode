import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getGitRepoName, getGitBranch, renderGitRepo, renderGitBranch } from '../../hud/elements/git.js';

// Mock child_process.execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
const mockExecSync = vi.mocked(execSync);

describe('git elements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });
});

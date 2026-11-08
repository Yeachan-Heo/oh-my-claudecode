import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { GitLabProvider } from '../../providers/gitlab.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('GitLabProvider', () => {
  let provider: GitLabProvider;

  beforeEach(() => {
    provider = new GitLabProvider();
    vi.clearAllMocks();
  });

  describe('static properties', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('gitlab');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('GitLab');
    });

    it('uses MR terminology', () => {
      expect(provider.prTerminology).toBe('MR');
    });

    it('has correct prRefspec', () => {
      expect(provider.prRefspec).toBe('merge-requests/{number}/head:{branch}');
    });

    it('requires glab CLI', () => {
      expect(provider.getRequiredCLI()).toBe('glab');
    });
  });

  describe('detectFromRemote', () => {
    it('returns true for gitlab.com URLs', () => {
      expect(provider.detectFromRemote('https://gitlab.com/group/project')).toBe(true);
    });

    it('returns true for gitlab.com SSH URLs', () => {
      expect(provider.detectFromRemote('git@gitlab.com:group/project.git')).toBe(true);
    });

    it('returns true for self-hosted with gitlab in hostname', () => {
      expect(provider.detectFromRemote('https://my-gitlab.company.com/group/repo')).toBe(true);
    });

    it('returns false for non-GitLab URLs', () => {
      expect(provider.detectFromRemote('https://github.com/user/repo')).toBe(false);
    });

    it('returns false for bitbucket URLs', () => {
      expect(provider.detectFromRemote('https://bitbucket.org/user/repo')).toBe(false);
    });
  });

  describe('viewPR', () => {
    it('calls glab mr view with correct args and parses response', () => {
      const mockResponse = JSON.stringify({
        title: 'Add feature',
        source_branch: 'feature/new',
        target_branch: 'main',
        description: 'Adds the new feature',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/7',
        author: { username: 'gluser' },
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewPR(7);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['mr', 'view', '7', '--output', 'json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toEqual({
        title: 'Add feature',
        headBranch: 'feature/new',
        baseBranch: 'main',
        body: 'Adds the new feature',
        url: 'https://gitlab.com/group/project/-/merge_requests/7',
        author: 'gluser',
      });
    });

    it('includes --repo flag when owner and repo are provided', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'MR',
        source_branch: 'feat',
        target_branch: 'main',
        description: '',
        web_url: '',
        author: { username: 'u' },
      }));

      provider.viewPR(3, 'group', 'project');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['mr', 'view', '3', '--repo', 'group/project', '--output', 'json'],
        expect.any(Object),
      );
    });

    it('returns null when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('glab: not found');
      });

      expect(provider.viewPR(1)).toBeNull();
    });

    it('returns null for invalid number', () => {
      expect(provider.viewPR(-1)).toBeNull();
      expect(provider.viewPR(0)).toBeNull();
      expect(provider.viewPR(1.5)).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('viewIssue', () => {
    it('calls glab issue view with correct args and parses response', () => {
      const mockResponse = JSON.stringify({
        title: 'Bug in pipeline',
        description: 'Pipeline fails on deploy',
        web_url: 'https://gitlab.com/group/project/-/issues/15',
        labels: ['bug', 'pipeline'],
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewIssue(15);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['issue', 'view', '15', '--output', 'json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toEqual({
        title: 'Bug in pipeline',
        body: 'Pipeline fails on deploy',
        url: 'https://gitlab.com/group/project/-/issues/15',
        labels: ['bug', 'pipeline'],
      });
    });

    it('includes --repo flag when owner and repo are provided', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'Issue',
        description: '',
        web_url: '',
        labels: [],
      }));

      provider.viewIssue(2, 'group', 'project');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['issue', 'view', '2', '--repo', 'group/project', '--output', 'json'],
        expect.any(Object),
      );
    });

    it('returns null when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('glab: not found');
      });

      expect(provider.viewIssue(1)).toBeNull();
    });

    it('returns null for invalid number', () => {
      expect(provider.viewIssue(-1)).toBeNull();
      expect(provider.viewIssue(0)).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('checkAuth', () => {
    it('returns true when glab auth status succeeds', () => {
      mockExecFileSync.mockReturnValue('');

      expect(provider.checkAuth()).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['auth', 'status'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('returns false when glab auth status fails', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not authenticated');
      });

      expect(provider.checkAuth()).toBe(false);
    });
  });
});

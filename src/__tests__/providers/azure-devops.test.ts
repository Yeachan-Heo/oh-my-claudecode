import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { AzureDevOpsProvider } from '../../providers/azure-devops.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('AzureDevOpsProvider', () => {
  let provider: AzureDevOpsProvider;

  beforeEach(() => {
    provider = new AzureDevOpsProvider();
    vi.clearAllMocks();
  });

  describe('static properties', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('azure-devops');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('Azure DevOps');
    });

    it('uses PR terminology', () => {
      expect(provider.prTerminology).toBe('PR');
    });

    it('has null prRefspec', () => {
      expect(provider.prRefspec).toBeNull();
    });

    it('requires az CLI', () => {
      expect(provider.getRequiredCLI()).toBe('az');
    });
  });

  describe('hostname identity', () => {
    it.each([
      'https://dev.azure.com.evil.invalid/org/proj/_git/repo',
      'https://notdev.azure.com/org/proj/_git/repo',
      'git@notssh.dev.azure.com:v3/org/proj/repo',
      'https://visualstudio.com.evil.invalid/project/_git/repo',
    ])('rejects lookalike host %s', (url) => {
      expect(provider.detectFromRemote(url)).toBe(false);
    });

    it('accepts the official hostname case-insensitively', () => {
      expect(provider.detectFromRemote('https://DEV.AZURE.COM/org/project/_git/repo')).toBe(true);
    });
  });

  describe('detectFromRemote', () => {
    it('returns true for dev.azure.com URLs', () => {
      expect(provider.detectFromRemote('https://dev.azure.com/org/project/_git/repo')).toBe(true);
    });

    it('returns true for ssh.dev.azure.com URLs', () => {
      expect(provider.detectFromRemote('git@ssh.dev.azure.com:v3/org/project/repo')).toBe(true);
    });

    it('returns true for visualstudio.com URLs', () => {
      expect(provider.detectFromRemote('https://org.visualstudio.com/project/_git/repo')).toBe(true);
    });

    it('returns false for GitHub URLs', () => {
      expect(provider.detectFromRemote('https://github.com/user/repo')).toBe(false);
    });

    it('returns false for GitLab URLs', () => {
      expect(provider.detectFromRemote('https://gitlab.com/user/repo')).toBe(false);
    });
  });

  describe('viewPR', () => {
    it('calls az repos pr show and parses response with ref stripping', () => {
      const mockResponse = JSON.stringify({
        title: 'Add feature',
        sourceRefName: 'refs/heads/feature/new',
        targetRefName: 'refs/heads/main',
        url: 'https://dev.azure.com/org/project/_apis/git/pullRequests/42',
        description: 'Adds a new feature',
        createdBy: { displayName: 'Azure User' },
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewPR(42);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'az',
        ['repos', 'pr', 'show', '--id', '42', '--output', 'json'],
        expect.objectContaining({ encoding: 'utf-8', timeout: 15000 }),
      );
      expect(result).toEqual({
        title: 'Add feature',
        headBranch: 'feature/new',
        baseBranch: 'main',
        url: 'https://dev.azure.com/org/project/_apis/git/pullRequests/42',
        body: 'Adds a new feature',
        author: 'Azure User',
      });
    });

    it('strips refs/heads/ prefix from branch names', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'PR',
        sourceRefName: 'refs/heads/bugfix/issue-123',
        targetRefName: 'refs/heads/develop',
        url: '',
        description: '',
        createdBy: { displayName: 'user' },
      }));

      const result = provider.viewPR(1);

      expect(result?.headBranch).toBe('bugfix/issue-123');
      expect(result?.baseBranch).toBe('develop');
    });

    it('handles missing ref names', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'PR',
        url: '',
        description: '',
      }));

      const result = provider.viewPR(1);

      expect(result?.headBranch).toBeUndefined();
      expect(result?.baseBranch).toBeUndefined();
    });

    it('returns null when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('az: not found');
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
    it('calls az boards work-item show and parses System fields', () => {
      const mockResponse = JSON.stringify({
        fields: {
          'System.Title': 'Fix login bug',
          'System.Description': '<p>Login fails on mobile</p>',
        },
        url: 'https://dev.azure.com/org/project/_apis/wit/workItems/99',
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewIssue(99);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'az',
        ['boards', 'work-item', 'show', '--id', '99', '--output', 'json'],
        expect.objectContaining({ encoding: 'utf-8', timeout: 15000 }),
      );
      expect(result).toEqual({
        title: 'Fix login bug',
        body: '<p>Login fails on mobile</p>',
        url: 'https://dev.azure.com/org/project/_apis/wit/workItems/99',
      });
    });

    it('handles missing fields gracefully', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        url: 'https://dev.azure.com/org/project/_apis/wit/workItems/1',
      }));

      const result = provider.viewIssue(1);

      expect(result?.title).toBe('');
      expect(result?.body).toBeUndefined();
    });

    it('returns null when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('az: not found');
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
    it('returns true when az account show succeeds', () => {
      mockExecFileSync.mockReturnValue('');

      expect(provider.checkAuth()).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'az',
        ['account', 'show'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }),
      );
    });

    it('returns false when az account show fails', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not logged in');
      });

      expect(provider.checkAuth()).toBe(false);
    });
  });
});

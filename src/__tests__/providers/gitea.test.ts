import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { GiteaProvider } from '../../providers/gitea.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('GiteaProvider', () => {
  let provider: GiteaProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    provider = new GiteaProvider();
    vi.clearAllMocks();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('static properties', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('gitea');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('Gitea');
    });

    it('uses PR terminology', () => {
      expect(provider.prTerminology).toBe('PR');
    });

    it('has null prRefspec', () => {
      expect(provider.prRefspec).toBeNull();
    });

    it('does not require a specific CLI (has REST fallback)', () => {
      expect(provider.getRequiredCLI()).toBeNull();
    });

    it('supports Forgejo identity via constructor', () => {
      const forgejo = new GiteaProvider({ name: 'forgejo', displayName: 'Forgejo' });
      expect(forgejo.name).toBe('forgejo');
      expect(forgejo.displayName).toBe('Forgejo');
    });
  });

  describe('detectFromRemote', () => {
    it('always returns false for any URL', () => {
      expect(provider.detectFromRemote('https://gitea.example.com/user/repo')).toBe(false);
      expect(provider.detectFromRemote('https://github.com/user/repo')).toBe(false);
      expect(provider.detectFromRemote('https://try.gitea.io/user/repo')).toBe(false);
    });
  });

  describe('viewPR', () => {
    it('uses tea CLI when available and parses response', () => {
      const mockResponse = JSON.stringify({
        title: 'Add feature',
        head_branch: 'feature/new',
        base_branch: 'main',
        html_url: 'https://gitea.example.com/user/repo/pulls/5',
        body: 'Adds a new feature',
        user: { login: 'giteauser' },
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewPR(5);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tea',
        ['pr', 'view', '5'],
        expect.objectContaining({ encoding: 'utf-8', timeout: 10000 }),
      );
      expect(result).toEqual({
        title: 'Add feature',
        headBranch: 'feature/new',
        baseBranch: 'main',
        url: 'https://gitea.example.com/user/repo/pulls/5',
        body: 'Adds a new feature',
        author: 'giteauser',
      });
    });

    it('falls back to REST API when tea CLI fails', () => {
      process.env.GITEA_URL = 'https://gitea.example.com';
      process.env.GITEA_TOKEN = 'test-token';

      // First call (tea) throws
      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error('tea: not found');
      });
      // Second call (curl) returns data
      mockExecFileSync.mockReturnValueOnce(JSON.stringify({
        title: 'REST PR',
        head: { ref: 'feature/rest' },
        base: { ref: 'main' },
        html_url: 'https://gitea.example.com/user/repo/pulls/3',
        body: 'From REST',
        user: { login: 'restuser' },
      }));

      const result = provider.viewPR(3, 'user', 'repo');

      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(mockExecFileSync).toHaveBeenNthCalledWith(1,
        'tea',
        ['pr', 'view', '3'],
        expect.any(Object),
      );
      expect(mockExecFileSync).toHaveBeenNthCalledWith(2,
        'curl',
        ['-sS', '-H', 'Authorization: token test-token', 'https://gitea.example.com/api/v1/repos/user/repo/pulls/3'],
        expect.any(Object),
      );
      expect(result).toEqual({
        title: 'REST PR',
        headBranch: 'feature/rest',
        baseBranch: 'main',
        url: 'https://gitea.example.com/user/repo/pulls/3',
        body: 'From REST',
        author: 'restuser',
      });
    });

    it('REST fallback works without token', () => {
      process.env.GITEA_URL = 'https://gitea.example.com';
      delete process.env.GITEA_TOKEN;

      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error('tea: not found');
      });
      mockExecFileSync.mockReturnValueOnce(JSON.stringify({
        title: 'Public PR',
        head: { ref: 'feat' },
        base: { ref: 'main' },
        html_url: '',
        body: '',
        user: { login: 'u' },
      }));

      provider.viewPR(1, 'owner', 'repo');

      expect(mockExecFileSync).toHaveBeenNthCalledWith(2,
        'curl',
        ['-sS', 'https://gitea.example.com/api/v1/repos/owner/repo/pulls/1'],
        expect.any(Object),
      );
    });

    it('returns null when both tea and REST fail', () => {
      process.env.GITEA_URL = 'https://gitea.example.com';
      process.env.GITEA_TOKEN = 'test-token';

      mockExecFileSync.mockImplementation(() => {
        throw new Error('failed');
      });

      expect(provider.viewPR(1, 'owner', 'repo')).toBeNull();
    });

    it('returns null when REST fallback has no GITEA_URL', () => {
      delete process.env.GITEA_URL;

      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error('tea: not found');
      });

      expect(provider.viewPR(1, 'owner', 'repo')).toBeNull();
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('returns null for invalid number', () => {
      expect(provider.viewPR(-1)).toBeNull();
      expect(provider.viewPR(0)).toBeNull();
      expect(provider.viewPR(1.5)).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('viewIssue', () => {
    it('uses tea CLI when available and parses response', () => {
      const mockResponse = JSON.stringify({
        title: 'Bug report',
        body: 'Something is broken',
        html_url: 'https://gitea.example.com/user/repo/issues/10',
        labels: [{ name: 'bug' }, { name: 'critical' }],
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewIssue(10);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tea',
        ['issues', 'view', '10'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toEqual({
        title: 'Bug report',
        body: 'Something is broken',
        url: 'https://gitea.example.com/user/repo/issues/10',
        labels: ['bug', 'critical'],
      });
    });

    it('falls back to REST API when tea CLI fails', () => {
      process.env.GITEA_URL = 'https://gitea.example.com';

      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error('tea: not found');
      });
      mockExecFileSync.mockReturnValueOnce(JSON.stringify({
        title: 'REST Issue',
        body: 'From REST',
        html_url: 'https://gitea.example.com/user/repo/issues/7',
        labels: [{ name: 'enhancement' }],
      }));

      const result = provider.viewIssue(7, 'user', 'repo');

      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(mockExecFileSync).toHaveBeenNthCalledWith(2,
        'curl',
        ['-sS', 'https://gitea.example.com/api/v1/repos/user/repo/issues/7'],
        expect.any(Object),
      );
      expect(result).toEqual({
        title: 'REST Issue',
        body: 'From REST',
        url: 'https://gitea.example.com/user/repo/issues/7',
        labels: ['enhancement'],
      });
    });

    it('returns null when both tea and REST fail', () => {
      process.env.GITEA_URL = 'https://gitea.example.com';

      mockExecFileSync.mockImplementation(() => {
        throw new Error('failed');
      });

      expect(provider.viewIssue(1, 'owner', 'repo')).toBeNull();
    });

    it('returns null for invalid number', () => {
      expect(provider.viewIssue(-1)).toBeNull();
      expect(provider.viewIssue(0)).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('includes Authorization header in REST fallback when GITEA_TOKEN is set', () => {
      process.env.GITEA_URL = 'https://gitea.example.com';
      process.env.GITEA_TOKEN = 'test-token';

      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error('tea: not found');
      });
      mockExecFileSync.mockReturnValueOnce(JSON.stringify({
        title: 'Auth Issue',
        body: 'With auth',
        html_url: 'https://gitea.example.com/user/repo/issues/42',
        labels: [],
      }));

      const result = provider.viewIssue(42, 'user', 'repo');

      expect(mockExecFileSync).toHaveBeenNthCalledWith(2,
        'curl',
        ['-sS', '-H', 'Authorization: token test-token', 'https://gitea.example.com/api/v1/repos/user/repo/issues/42'],
        expect.any(Object),
      );
      expect(result).toEqual({
        title: 'Auth Issue',
        body: 'With auth',
        url: 'https://gitea.example.com/user/repo/issues/42',
        labels: [],
      });
    });

    it('omits Authorization header in REST fallback when GITEA_TOKEN is not set', () => {
      process.env.GITEA_URL = 'https://gitea.example.com';
      delete process.env.GITEA_TOKEN;

      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error('tea: not found');
      });
      mockExecFileSync.mockReturnValueOnce(JSON.stringify({
        title: 'No Auth Issue',
        body: 'Without auth',
        html_url: 'https://gitea.example.com/user/repo/issues/1',
        labels: [],
      }));

      provider.viewIssue(1, 'user', 'repo');

      expect(mockExecFileSync).toHaveBeenNthCalledWith(2,
        'curl',
        ['-sS', 'https://gitea.example.com/api/v1/repos/user/repo/issues/1'],
        expect.any(Object),
      );
    });
  });

  describe('checkAuth', () => {
    it('returns true when GITEA_TOKEN is set', () => {
      process.env.GITEA_TOKEN = 'test-token';
      expect(provider.checkAuth()).toBe(true);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns true when tea login list succeeds', () => {
      delete process.env.GITEA_TOKEN;
      mockExecFileSync.mockReturnValue('');

      expect(provider.checkAuth()).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tea',
        ['login', 'list'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('returns false when no token and tea login fails', () => {
      delete process.env.GITEA_TOKEN;
      mockExecFileSync.mockImplementation(() => {
        throw new Error('tea: not found');
      });

      expect(provider.checkAuth()).toBe(false);
    });
  });
});

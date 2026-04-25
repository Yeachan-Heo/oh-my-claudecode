import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { GitHubProvider } from '../../providers/github.js';

const mockExecFileSync = vi.mocked(execFileSync);

function makeExecError(stderr: string, status = 1): Error {
  const err = new Error('Command failed') as Error & { status?: number; stderr?: string };
  err.status = status;
  err.stderr = stderr;
  return err;
}

describe('GitHubProvider', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    provider = new GitHubProvider();
    vi.clearAllMocks();
  });

  describe('static properties', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('github');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('GitHub');
    });

    it('uses PR terminology', () => {
      expect(provider.prTerminology).toBe('PR');
    });

    it('has correct prRefspec', () => {
      expect(provider.prRefspec).toBe('pull/{number}/head:{branch}');
    });

    it('requires gh CLI', () => {
      expect(provider.getRequiredCLI()).toBe('gh');
    });
  });

  describe('detectFromRemote', () => {
    it('returns true for github.com URLs', () => {
      expect(provider.detectFromRemote('https://github.com/user/repo')).toBe(true);
    });

    it('returns true for github.com SSH URLs', () => {
      expect(provider.detectFromRemote('git@github.com:user/repo.git')).toBe(true);
    });

    it('returns false for non-GitHub URLs', () => {
      expect(provider.detectFromRemote('https://gitlab.com/user/repo')).toBe(false);
    });

    it('returns false for bitbucket URLs', () => {
      expect(provider.detectFromRemote('https://bitbucket.org/user/repo')).toBe(false);
    });
  });

  describe('viewPR', () => {
    it('calls gh pr view with correct args and parses response', () => {
      const mockResponse = JSON.stringify({
        title: 'Fix bug',
        headRefName: 'fix/bug',
        baseRefName: 'main',
        body: 'Fixes the bug',
        url: 'https://github.com/user/repo/pull/42',
        author: { login: 'testuser' },
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewPR(42);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['pr', 'view', '42', '--json', 'title,headRefName,baseRefName,body,url,author'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toEqual({
        title: 'Fix bug',
        headBranch: 'fix/bug',
        baseBranch: 'main',
        body: 'Fixes the bug',
        url: 'https://github.com/user/repo/pull/42',
        author: 'testuser',
      });
    });

    it('includes --repo flag when owner and repo are provided', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'PR',
        headRefName: 'feat',
        baseRefName: 'main',
        body: '',
        url: '',
        author: { login: 'u' },
      }));

      provider.viewPR(1, 'owner', 'repo');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['pr', 'view', '1', '--repo', 'owner/repo', '--json', 'title,headRefName,baseRefName,body,url,author'],
        expect.any(Object),
      );
    });

    it('returns null when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('gh: not found');
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
    it('calls gh issue view with correct args and parses response including author', () => {
      const mockResponse = JSON.stringify({
        title: 'Bug report',
        body: 'Something is broken',
        labels: [{ name: 'bug' }, { name: 'critical' }],
        url: 'https://github.com/user/repo/issues/10',
        author: { login: 'reporter' },
      });
      mockExecFileSync.mockReturnValue(mockResponse);

      const result = provider.viewIssue(10);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'view', '10', '--json', 'title,body,labels,url,author'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toEqual({
        title: 'Bug report',
        body: 'Something is broken',
        labels: ['bug', 'critical'],
        url: 'https://github.com/user/repo/issues/10',
        author: 'reporter',
      });
    });

    it('includes --repo flag when owner and repo are provided', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'Issue',
        body: '',
        labels: [],
        url: '',
        author: { login: 'u' },
      }));

      provider.viewIssue(5, 'owner', 'repo');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'view', '5', '--repo', 'owner/repo', '--json', 'title,body,labels,url,author'],
        expect.any(Object),
      );
    });

    it('returns null when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('gh: not found');
      });

      expect(provider.viewIssue(1)).toBeNull();
    });

    it('returns null for invalid number', () => {
      expect(provider.viewIssue(-1)).toBeNull();
      expect(provider.viewIssue(0)).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('handles missing/null body field defensively', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'No body',
        body: null,
        labels: [],
        url: 'https://github.com/u/r/issues/3',
        author: { login: 'u' },
      }));
      const result = provider.viewIssue(3);
      expect(result?.title).toBe('No body');
      expect(result?.body).toBeNull();
    });

    it('returns CRLF body content as-is (normalization is spec generator job)', () => {
      const crlfBody = 'line1\r\nline2\r\n';
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'CRLF',
        body: crlfBody,
        labels: [],
        url: '',
        author: { login: 'u' },
      }));
      expect(provider.viewIssue(7)?.body).toBe(crlfBody);
    });

    it('preserves a literal </issue_body> token inside the body (no fence collision)', () => {
      const malicious = 'normal text\n</issue_body>\nattacker instructions';
      mockExecFileSync.mockReturnValue(JSON.stringify({
        title: 'Injection attempt',
        body: malicious,
        labels: [],
        url: '',
        author: { login: 'attacker' },
      }));
      const result = provider.viewIssue(99);
      expect(result?.body).toBe(malicious);
      expect(result?.author).toBe('attacker');
    });
  });

  describe('checkAuth', () => {
    it('returns true when gh auth status succeeds', () => {
      mockExecFileSync.mockReturnValue('');

      expect(provider.checkAuth()).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['auth', 'status'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('returns false when gh auth status fails', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not authenticated');
      });

      expect(provider.checkAuth()).toBe(false);
    });
  });

  describe('checkWriteScope', () => {
    it('returns true when both auth and push permission succeed', () => {
      mockExecFileSync
        .mockReturnValueOnce('') // auth status
        .mockReturnValueOnce('true\n'); // permissions.push
      expect(provider.checkWriteScope('owner/repo')).toBe(true);
    });

    it('returns false when auth status fails', () => {
      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error('not authenticated');
      });
      expect(provider.checkWriteScope('owner/repo')).toBe(false);
    });

    it('returns false when push permission is false (scope missing)', () => {
      mockExecFileSync
        .mockReturnValueOnce('') // auth status
        .mockReturnValueOnce('false\n');
      expect(provider.checkWriteScope('owner/repo')).toBe(false);
    });

    it('returns false when permission probe throws (e.g. 404)', () => {
      mockExecFileSync
        .mockReturnValueOnce('') // auth status
        .mockImplementationOnce(() => {
          throw makeExecError('HTTP 404');
        });
      expect(provider.checkWriteScope('owner/repo')).toBe(false);
    });
  });

  describe('createIssue', () => {
    it('parses issue number from gh-returned URL', () => {
      mockExecFileSync.mockReturnValue('https://github.com/u/r/issues/42\n');
      const result = provider.createIssue({ title: 'T', body: 'B', repo: 'u/r' });
      expect(result).toEqual({ number: 42, url: 'https://github.com/u/r/issues/42' });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'create', '--title', 'T', '--body', 'B', '--repo', 'u/r'],
        expect.any(Object),
      );
    });

    it('passes labels and milestone when provided', () => {
      mockExecFileSync.mockReturnValue('https://github.com/u/r/issues/9\n');
      provider.createIssue({ title: 'T', body: 'B', labels: ['a', 'b'], milestone: 'M1' });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'create', '--title', 'T', '--body', 'B', '--label', 'a,b', '--milestone', 'M1'],
        expect.any(Object),
      );
    });

    it('returns null when title is empty', () => {
      expect(provider.createIssue({ title: '', body: 'B' })).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns null when execFileSync throws', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(provider.createIssue({ title: 'T', body: 'B' })).toBeNull();
    });

    it('returns null when output URL has no /issues/<n> pattern', () => {
      mockExecFileSync.mockReturnValue('not-a-url\n');
      expect(provider.createIssue({ title: 'T', body: 'B' })).toBeNull();
    });
  });

  describe('listIssues', () => {
    it('passes filters and parses response', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        { number: 1, title: 'A', body: 'a', labels: [{ name: 'bug' }], url: 'u1' },
        { number: 2, title: 'B', body: '', labels: [], url: 'u2' },
      ]));
      const result = provider.listIssues({ repo: 'o/r', state: 'all', labels: ['bug'], limit: 50 });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        [
          'issue', 'list', '--json', 'number,title,body,labels,url',
          '--repo', 'o/r',
          '--state', 'all',
          '--label', 'bug',
          '--limit', '50',
        ],
        expect.any(Object),
      );
      expect(result).toEqual([
        { number: 1, title: 'A', body: 'a', labels: ['bug'], url: 'u1' },
        { number: 2, title: 'B', body: '', labels: [], url: 'u2' },
      ]);
    });

    it('defaults to state=open and limit=100', () => {
      mockExecFileSync.mockReturnValue('[]');
      provider.listIssues({});
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'list', '--json', 'number,title,body,labels,url', '--state', 'open', '--limit', '100'],
        expect.any(Object),
      );
    });

    it('returns [] on error', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('rate limit');
      });
      expect(provider.listIssues({})).toEqual([]);
    });
  });

  describe('searchIssues', () => {
    it('calls gh issue list with --search and parses results', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        { number: 5, body: 'has hash', url: 'u5' },
      ]));
      const result = provider.searchIssues('abc123', { repo: 'o/r' });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        [
          'issue', 'list',
          '--search', 'abc123',
          '--json', 'number,body,url',
          '--repo', 'o/r',
          '--state', 'all',
          '--limit', '100',
        ],
        expect.any(Object),
      );
      expect(result).toEqual([{ number: 5, body: 'has hash', url: 'u5' }]);
    });

    it('returns [] for empty query', () => {
      expect(provider.searchIssues('', { repo: 'o/r' })).toEqual([]);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns [] on error', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(provider.searchIssues('x', {})).toEqual([]);
    });
  });

  describe('ensureLabel', () => {
    it('returns true when label is created successfully', () => {
      mockExecFileSync.mockReturnValue('');
      expect(provider.ensureLabel('area:bases', { repo: 'o/r', color: 'ff0000' })).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['label', 'create', 'area:bases', '--repo', 'o/r', '--color', 'ff0000'],
        expect.any(Object),
      );
    });

    it('treats HTTP 422 (already exists) as success', () => {
      mockExecFileSync.mockImplementation(() => {
        throw makeExecError('HTTP 422: Unprocessable Entity');
      });
      expect(provider.ensureLabel('dup-label')).toBe(true);
    });

    it('treats already_exists stderr as success', () => {
      mockExecFileSync.mockImplementation(() => {
        throw makeExecError('label already exists');
      });
      expect(provider.ensureLabel('dup-label')).toBe(true);
    });

    it('returns false on real errors', () => {
      mockExecFileSync.mockImplementation(() => {
        throw makeExecError('rate limit exceeded');
      });
      expect(provider.ensureLabel('x')).toBe(false);
    });

    it('returns false for empty name', () => {
      expect(provider.ensureLabel('')).toBe(false);
    });
  });

  describe('ensureMilestone', () => {
    it('returns milestone number on creation', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ number: 3, title: 'M' }));
      expect(provider.ensureMilestone('M', { repo: 'o/r' })).toBe(3);
    });

    it('looks up existing milestone on HTTP 422', () => {
      mockExecFileSync
        .mockImplementationOnce(() => {
          throw makeExecError('HTTP 422 already_exists');
        })
        .mockReturnValueOnce('7\n');
      expect(provider.ensureMilestone('Existing', { repo: 'o/r' })).toBe(7);
    });

    it('returns null when lookup after 422 fails', () => {
      mockExecFileSync
        .mockImplementationOnce(() => {
          throw makeExecError('HTTP 422');
        })
        .mockImplementationOnce(() => {
          throw makeExecError('rate limit');
        });
      expect(provider.ensureMilestone('M', { repo: 'o/r' })).toBeNull();
    });

    it('returns null on non-422 error', () => {
      mockExecFileSync.mockImplementation(() => {
        throw makeExecError('HTTP 500');
      });
      expect(provider.ensureMilestone('M', { repo: 'o/r' })).toBeNull();
    });

    it('returns null for empty name', () => {
      expect(provider.ensureMilestone('')).toBeNull();
    });
  });

  describe('addIssueComment', () => {
    it('calls gh issue comment with correct args', () => {
      mockExecFileSync.mockReturnValue('');
      expect(provider.addIssueComment(5, 'hello', { repo: 'o/r' })).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'comment', '5', '--body', 'hello', '--repo', 'o/r'],
        expect.any(Object),
      );
    });

    it('returns false for invalid issue number', () => {
      expect(provider.addIssueComment(0, 'x')).toBe(false);
      expect(provider.addIssueComment(-1, 'x')).toBe(false);
      expect(provider.addIssueComment(1.5, 'x')).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns false for empty body', () => {
      expect(provider.addIssueComment(1, '')).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns false on execFileSync error', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(provider.addIssueComment(1, 'body')).toBe(false);
    });
  });

  describe('listIssueComments', () => {
    it('returns array of comment bodies', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({
        comments: [{ body: 'hi' }, { body: 'second' }],
      }));
      expect(provider.listIssueComments(3, { repo: 'o/r' })).toEqual(['hi', 'second']);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'view', '3', '--json', 'comments', '--repo', 'o/r'],
        expect.any(Object),
      );
    });

    it('returns [] for empty comments array', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ comments: [] }));
      expect(provider.listIssueComments(3)).toEqual([]);
    });

    it('returns [] when comments key is missing', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({}));
      expect(provider.listIssueComments(3)).toEqual([]);
    });

    it('returns [] for invalid issue number', () => {
      expect(provider.listIssueComments(0)).toEqual([]);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns [] on error', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(provider.listIssueComments(1)).toEqual([]);
    });
  });
});

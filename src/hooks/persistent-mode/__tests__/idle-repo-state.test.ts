import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { getIdleNotificationRepoState } from '../idle-repo-state.js';

describe('getIdleNotificationRepoState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a stable zero-backlog signature from git and GitHub state', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('git@github.com:Yeachan-Heo/lazycc.git\n')
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('[]')
      .mockReturnValueOnce('[]');

    const result = getIdleNotificationRepoState('/repo');

    expect(result).toEqual({
      signature: JSON.stringify({
        repo: 'Yeachan-Heo/lazycc',
        headSha: 'abc123',
        dirty: false,
        openPrNumbers: [],
        openIssueNumbers: [],
        failingRunIds: [],
      }),
      backlogZero: true,
    });
  });

  it('returns non-zero backlog when PRs, issues, or failing runs exist', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('https://github.com/Yeachan-Heo/lazycc.git\n')
      .mockReturnValueOnce('def456\n')
      .mockReturnValueOnce(' M src/file.ts\n')
      .mockReturnValueOnce('[{"number":2472}]')
      .mockReturnValueOnce('[{"number":2473}]')
      .mockReturnValueOnce('[{"databaseId":91,"conclusion":"failure"},{"databaseId":92,"conclusion":"success"}]');

    const result = getIdleNotificationRepoState('/repo');

    expect(result?.backlogZero).toBe(false);
    expect(result?.signature).toBe(
      JSON.stringify({
        repo: 'Yeachan-Heo/lazycc',
        headSha: 'def456',
        dirty: true,
        openPrNumbers: [2472],
        openIssueNumbers: [2473],
        failingRunIds: [91],
      }),
    );
  });

  it('returns null when the repo is not hosted on GitHub', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('git@gitlab.com:group/project.git\n');

    expect(getIdleNotificationRepoState('/repo')).toBeNull();
  });

  it('returns null when GitHub queries fail', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce('git@github.com:Yeachan-Heo/lazycc.git\n')
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw new Error('gh unavailable');
      });

    expect(getIdleNotificationRepoState('/repo')).toBeNull();
  });
});

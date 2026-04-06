/**
 * Tests for git status HUD element
 *
 * Covers:
 * - getGitStatusCounts parsing of `git status --porcelain -b`
 * - renderGitStatus output formatting
 * - Cache behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

import { getGitStatusCounts, renderGitStatus, resetGitCache } from '../elements/git.js';

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.resetAllMocks();
  resetGitCache();
});

// ---------------------------------------------------------------------------
// getGitStatusCounts
// ---------------------------------------------------------------------------
describe('getGitStatusCounts', () => {
  it('returns zeros for clean repo', () => {
    mockedExecSync.mockReturnValue('## main...origin/main\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts).toEqual({ staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 });
  });

  it('counts staged files', () => {
    mockedExecSync.mockReturnValue('## main\nM  file1.ts\nA  file2.ts\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts?.staged).toBe(2);
    expect(counts?.modified).toBe(0);
  });

  it('counts modified (unstaged) files', () => {
    mockedExecSync.mockReturnValue('## main\n M file1.ts\n D file2.ts\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts?.staged).toBe(0);
    expect(counts?.modified).toBe(2);
  });

  it('counts untracked files', () => {
    mockedExecSync.mockReturnValue('## main\n?? newfile.ts\n?? another.ts\n?? third.ts\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts?.untracked).toBe(3);
    expect(counts?.staged).toBe(0);
    expect(counts?.modified).toBe(0);
  });

  it('counts both staged and modified for same file', () => {
    // MM means staged + modified
    mockedExecSync.mockReturnValue('## main\nMM file.ts\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts?.staged).toBe(1);
    expect(counts?.modified).toBe(1);
  });

  it('parses ahead count', () => {
    mockedExecSync.mockReturnValue('## main...origin/main [ahead 3]\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts?.ahead).toBe(3);
    expect(counts?.behind).toBe(0);
  });

  it('parses behind count', () => {
    mockedExecSync.mockReturnValue('## main...origin/main [behind 2]\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts?.ahead).toBe(0);
    expect(counts?.behind).toBe(2);
  });

  it('parses ahead and behind', () => {
    mockedExecSync.mockReturnValue('## main...origin/main [ahead 5, behind 2]\n' as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts?.ahead).toBe(5);
    expect(counts?.behind).toBe(2);
  });

  it('handles mixed status', () => {
    mockedExecSync.mockReturnValue((
      '## feat...origin/feat [ahead 1, behind 3]\n' +
      'M  staged.ts\n' +
      ' M modified.ts\n' +
      '?? new.ts\n' +
      'A  added.ts\n' +
      'D  deleted.ts\n' +
      ' D removed.ts\n'
    ) as any);
    const counts = getGitStatusCounts('/tmp');
    expect(counts).toEqual({ staged: 3, modified: 2, untracked: 1, ahead: 1, behind: 3 });
  });

  it('returns null on git error', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(getGitStatusCounts('/tmp')).toBeNull();
  });

  it('returns cached result on second call', () => {
    mockedExecSync.mockReturnValue('## main\n?? file.ts\n' as any);
    getGitStatusCounts('/tmp');
    getGitStatusCounts('/tmp');
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// renderGitStatus
// ---------------------------------------------------------------------------
describe('renderGitStatus', () => {
  it('returns null for clean repo', () => {
    mockedExecSync.mockReturnValue('## main...origin/main\n' as any);
    expect(renderGitStatus('/tmp')).toBeNull();
  });

  it('returns null on git error', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('fail'); });
    expect(renderGitStatus('/tmp')).toBeNull();
  });

  it('shows staged count with + prefix', () => {
    mockedExecSync.mockReturnValue('## main\nA  file.ts\n' as any);
    const result = renderGitStatus('/tmp')!;
    expect(result).toContain('+');
    expect(result).toContain('1');
  });

  it('shows modified count with ! prefix', () => {
    mockedExecSync.mockReturnValue('## main\n M file.ts\n' as any);
    const result = renderGitStatus('/tmp')!;
    expect(result).toContain('!');
    expect(result).toContain('1');
  });

  it('shows untracked count with ? prefix', () => {
    mockedExecSync.mockReturnValue('## main\n?? file.ts\n' as any);
    const result = renderGitStatus('/tmp')!;
    expect(result).toContain('?');
    expect(result).toContain('1');
  });

  it('shows ahead with ⇡', () => {
    mockedExecSync.mockReturnValue('## main...origin/main [ahead 2]\n' as any);
    const result = renderGitStatus('/tmp')!;
    expect(result).toContain('⇡');
    expect(result).toContain('2');
  });

  it('shows behind with ⇣', () => {
    mockedExecSync.mockReturnValue('## main...origin/main [behind 4]\n' as any);
    const result = renderGitStatus('/tmp')!;
    expect(result).toContain('⇣');
    expect(result).toContain('4');
  });
});

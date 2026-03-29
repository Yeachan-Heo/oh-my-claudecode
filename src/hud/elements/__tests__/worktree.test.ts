import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { getWorktreeName, renderWorktree, resetWorktreeCache } from '../worktree.js';

beforeEach(() => {
  resetWorktreeCache();
  vi.resetAllMocks();
});

describe('getWorktreeName', () => {
  it('returns worktree name when git-dir contains .git/worktrees/<name>', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '/home/user/project/.git/worktrees/issue-1858\n'
    );
    expect(getWorktreeName('/some/worktree')).toBe('issue-1858');
  });

  it('returns null in the main working tree (.git directory)', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue('.git\n');
    expect(getWorktreeName('/some/repo')).toBeNull();
  });

  it('returns null when git-dir is an absolute path without worktrees segment', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue('/home/user/project/.git\n');
    expect(getWorktreeName('/some/repo')).toBeNull();
  });

  it('returns null when not in a git repo', () => {
    (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('not a git repository');
    });
    expect(getWorktreeName('/not/a/repo')).toBeNull();
  });

  it('caches the result and calls execSync only once for the same cwd', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '/home/user/project/.git/worktrees/feat-my-feature\n'
    );
    getWorktreeName('/cached/path');
    getWorktreeName('/cached/path');
    expect(execSync).toHaveBeenCalledOnce();
  });
});

describe('renderWorktree', () => {
  it('renders wt:<name> when inside a linked worktree', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '/home/user/project/.git/worktrees/issue-1858\n'
    );
    const result = renderWorktree('/some/worktree');
    expect(result).toContain('issue-1858');
    expect(result).toContain('wt:');
  });

  it('returns null when in the main repo', () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue('.git\n');
    expect(renderWorktree('/some/repo')).toBeNull();
  });
});

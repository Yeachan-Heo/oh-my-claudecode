import { describe, expect, it, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';

// Mock fs functions used by createWorktree
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

// Mock provider dependencies
vi.mock('../../../providers/index.js', () => ({
  parseRemoteUrl: vi.fn(),
  getProvider: vi.fn(),
}));

import { existsSync } from 'fs';
import { teleportCommand } from '../teleport.js';

describe('createWorktree — no shell injection via execFileSync', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // existsSync: parentDir exists, worktreePath does not yet exist
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('-injected')) return false;
      return true; // parentDir exists
    });

    // execFileSync: succeed silently for all git calls
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
  });

  it('passes branchName and baseBranch as discrete array arguments, never as a shell string', async () => {
    const { parseRemoteUrl, getProvider } = await import('../../../providers/index.js');

    (parseRemoteUrl as ReturnType<typeof vi.fn>).mockReturnValue({
      owner: 'owner',
      repo: 'repo',
      provider: 'github',
    });

    (getProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      displayName: 'GitHub',
      getRequiredCLI: () => 'gh',
      viewPR: () => null,
      viewIssue: () => ({ title: 'test issue' }),
      prRefspec: null,
    });

    // existsSync mock: worktree path doesn't exist so createWorktree proceeds
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      if (typeof p !== 'string') return false;
      // worktreeRoot dir exists, worktree target does not
      if (p.includes('issue')) return false;
      return true;
    });

    await teleportCommand('#1', { base: 'main; touch /tmp/pwned' });

    // Every execFileSync call must pass args as an array — never a concatenated string
    const calls = (execFileSync as ReturnType<typeof vi.fn>).mock.calls;
    for (const [cmd, args] of calls) {
      expect(cmd).toBe('git');
      expect(Array.isArray(args)).toBe(true);
      // No single argument should contain shell metacharacters from the base branch
      for (const arg of args as string[]) {
        expect(arg).not.toMatch(/;/);
        expect(arg).not.toMatch(/\|/);
        expect(arg).not.toMatch(/`/);
        expect(arg).not.toMatch(/\$/);
      }
    }
  });

  it('does not invoke execSync for the three createWorktree git commands', async () => {
    const { execSync } = await import('child_process');

    const { parseRemoteUrl, getProvider } = await import('../../../providers/index.js');

    (parseRemoteUrl as ReturnType<typeof vi.fn>).mockReturnValue({
      owner: 'owner',
      repo: 'repo',
      provider: 'github',
    });

    (getProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      displayName: 'GitHub',
      getRequiredCLI: () => 'gh',
      viewPR: () => null,
      viewIssue: () => ({ title: 'another issue' }),
      prRefspec: null,
    });

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      if (typeof p !== 'string') return false;
      if (p.includes('issue')) return false;
      return true;
    });

    await teleportCommand('#2', { base: 'dev' });

    // execSync must not have been called for git fetch/branch/worktree
    const execSyncCalls = (execSync as ReturnType<typeof vi.fn>).mock.calls;
    const gitShellCalls = execSyncCalls.filter((args: unknown[]) => {
      const cmd = args[0];
      return (
        typeof cmd === 'string' &&
        (cmd.includes('git fetch') || cmd.includes('git branch') || cmd.includes('git worktree add'))
      );
    });
    expect(gitShellCalls).toHaveLength(0);
  });
});

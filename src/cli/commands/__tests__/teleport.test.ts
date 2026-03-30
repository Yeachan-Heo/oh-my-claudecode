import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, execSync } from 'child_process';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    symlinkSync: vi.fn(),
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

vi.mock('../../../config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../../providers/index.js', () => ({
  parseRemoteUrl: vi.fn(),
  getProvider: vi.fn(),
}));

import { existsSync, readFileSync, symlinkSync } from 'fs';
import { loadConfig } from '../../../config/loader.js';
import { teleportCommand } from '../teleport.js';

describe('teleportCommand', () => {
  beforeEach(async () => {
    vi.resetAllMocks();

    (execSync as ReturnType<typeof vi.fn>).mockImplementation((command: string) => {
      if (command === 'git rev-parse --show-toplevel') return '/repo';
      if (command === 'git remote get-url origin') return 'git@github.com:owner/repo.git';
      return '';
    });

    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((target: unknown) => {
      if (typeof target !== 'string') return false;
      if (target === '/root/issue') return true;
      if (target.includes('/issue/repo-')) return false;
      if (target === '/repo/package-lock.json') return true;
      if (target === '/repo/node_modules') return true;
      return false;
    });

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((target: unknown) => {
      if (target === '/repo/package.json') return '{"name":"repo","version":"1.0.0"}';
      if (typeof target === 'string' && target.includes('/issue/repo-1/package.json')) {
        return '{"name":"repo","version":"1.0.0"}';
      }
      throw new Error(`unexpected readFileSync(${String(target)})`);
    });

    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      teleport: { symlinkNodeModules: true },
    });

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
  });

  it('passes branchName and baseBranch as discrete array arguments, never as a shell string', async () => {
    await teleportCommand('#1', { base: 'main; touch /tmp/pwned', worktreePath: '/root' });

    const calls = (execFileSync as ReturnType<typeof vi.fn>).mock.calls;
    for (const [cmd, args] of calls) {
      expect(Array.isArray(args)).toBe(true);
      if (cmd !== 'git') continue;
      expect(typeof cmd).toBe('string');
    }

    expect(calls).toContainEqual([
      'git',
      ['fetch', 'origin', 'main; touch /tmp/pwned'],
      expect.objectContaining({ cwd: '/repo' }),
    ]);
  });

  it('does not invoke execSync for git fetch/branch/worktree creation commands', async () => {
    await teleportCommand('#2', { base: 'dev', worktreePath: '/root' });

    const execSyncCalls = (execSync as ReturnType<typeof vi.fn>).mock.calls;
    const gitShellCalls = execSyncCalls.filter((args: unknown[]) => {
      const cmd = args[0];
      return typeof cmd === 'string' &&
        (cmd.includes('git fetch') || cmd.includes('git branch') || cmd.includes('git worktree add'));
    });
    expect(gitShellCalls).toHaveLength(0);
  });

  it('symlinks node_modules when package.json matches and config allows it', async () => {
    await teleportCommand('#1', { worktreePath: '/root' });

    expect(symlinkSync).toHaveBeenCalledWith(
      '/repo/node_modules',
      '/root/issue/repo-1/node_modules',
      expect.stringMatching(/dir|junction/),
    );

    const installCalls = (execFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([cmd]) => cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn',
    );
    expect(installCalls).toHaveLength(0);
  });

  it('falls back to install with a warning when package.json differs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((target: unknown) => {
      if (target === '/repo/package.json') return '{"name":"repo","version":"1.0.0"}';
      if (typeof target === 'string' && target.includes('/issue/repo-1/package.json')) {
        return '{"name":"repo","version":"2.0.0"}';
      }
      throw new Error(`unexpected readFileSync(${String(target)})`);
    });

    await teleportCommand('#1', { worktreePath: '/root' });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('package.json differs'));
    expect(symlinkSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith('npm', ['install'], expect.objectContaining({ cwd: '/root/issue/repo-1' }));
  });

  it('falls back to pnpm install when symlinking is disabled in config', async () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      teleport: { symlinkNodeModules: false },
    });
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((target: unknown) => {
      if (typeof target !== 'string') return false;
      if (target === '/root/issue') return true;
      if (target.includes('/issue/repo-')) return false;
      if (target === '/repo/pnpm-lock.yaml') return true;
      if (target === '/repo/node_modules') return true;
      return false;
    });

    await teleportCommand('#1', { worktreePath: '/root' });

    expect(symlinkSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith('pnpm', ['install'], expect.objectContaining({ cwd: '/root/issue/repo-1' }));
  });

  it('falls back to yarn install when parent package.json cannot be read', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((target: unknown) => {
      if (typeof target !== 'string') return false;
      if (target === '/root/issue') return true;
      if (target.includes('/issue/repo-')) return false;
      if (target === '/repo/yarn.lock') return true;
      if (target === '/repo/node_modules') return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((target: unknown) => {
      if (typeof target === 'string' && target.includes('/issue/repo-1/package.json')) {
        return '{"name":"repo","version":"1.0.0"}';
      }
      throw new Error(`unexpected readFileSync(${String(target)})`);
    });

    await teleportCommand('#1', { worktreePath: '/root' });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not read package.json'));
    expect(execFileSync).toHaveBeenCalledWith('yarn', ['install'], expect.objectContaining({ cwd: '/root/issue/repo-1' }));
  });
});

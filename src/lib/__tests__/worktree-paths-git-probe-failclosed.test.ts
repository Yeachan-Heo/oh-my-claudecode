import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  realpathSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  clearWorktreeCache,
  resolveWorkingDirectoryOrLinkedWorktree,
  validateWorkingDirectoryOrLinkedWorktree,
  setGitShowToplevelProbeForTests,
} from '../../lib/worktree-paths.js';

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

function spawnEnoent(): NodeJS.ErrnoException {
  const err = new Error('spawnSync git ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  err.path = 'git';
  err.syscall = 'spawnSync git';
  return err;
}

function spawnError(code: string): NodeJS.ErrnoException {
  const err = new Error(`spawnSync git ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  err.path = 'git';
  err.syscall = 'spawnSync git';
  return err;
}

function gitExit(status: number, stderr = ''): Error & { status: number; stderr: string } {
  const err = new Error('Command failed: git rev-parse --show-toplevel') as Error & {
    status: number;
    stderr: string;
  };
  err.status = status;
  err.stderr = stderr;
  return err;
}

function gitSignal(signal: string): Error & { signal: string; status: null } {
  const err = new Error('git killed') as Error & { signal: string; status: null };
  err.signal = signal;
  err.status = null;
  return err;
}

function installFakeGit(dir: string, unixBody: string, winBody: string): string {
  const bin = join(dir, 'fake-git-bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'git.cmd'), `@echo off\r\n${winBody}\r\n`);
    copyFileSync(process.execPath, join(bin, 'git.exe'));
  } else {
    const gitPath = join(bin, 'git');
    writeFileSync(gitPath, `#!/bin/sh\n${unixBody}\n`);
    chmodSync(gitPath, 0o755);
  }
  return bin;
}

describe('git probe fail-closed classification (#3858 remaining P1)', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalPath: string | undefined;
  let sessionRepo: string;
  let srcDir: string;
  let foreignRepo: string;
  let linkedWorktree: string;
  let plainDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalPath = process.env.PATH;
    tempDir = mkdtempSync(join(tmpdir(), 'probe-failclosed-3858-'));
    clearWorktreeCache();
    setGitShowToplevelProbeForTests(undefined);

    sessionRepo = join(tempDir, 'session-project');
    mkdirSync(sessionRepo, { recursive: true });
    git(sessionRepo, 'init');
    git(sessionRepo, 'config user.email "test@example.com"');
    git(sessionRepo, 'config user.name "Test User"');
    writeFileSync(join(sessionRepo, 'README.md'), 'session\n');
    git(sessionRepo, 'add README.md');
    git(sessionRepo, 'commit -m initial');

    srcDir = join(sessionRepo, 'src');
    mkdirSync(srcDir, { recursive: true });

    foreignRepo = join(tempDir, 'foreign-vault');
    mkdirSync(foreignRepo, { recursive: true });
    git(foreignRepo, 'init');
    git(foreignRepo, 'config user.email "test@example.com"');
    git(foreignRepo, 'config user.name "Test User"');
    writeFileSync(join(foreignRepo, 'README.md'), 'vault\n');
    git(foreignRepo, 'add README.md');
    git(foreignRepo, 'commit -m initial');

    linkedWorktree = join(tempDir, 'session-linked');
    git(sessionRepo, `worktree add -b linked ${linkedWorktree}`);

    plainDir = join(tempDir, 'plain-notes');
    mkdirSync(plainDir, { recursive: true });

    process.chdir(sessionRepo);
    clearWorktreeCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    setGitShowToplevelProbeForTests(undefined);
    clearWorktreeCache();
    rmSync(tempDir, {
      recursive: true,
      force: true,
      ...(process.platform === 'win32' && { maxRetries: 10, retryDelay: 100 }),
    });
  });

  it('trusted repo subdirectory with PATH-prepended fake git exiting 1 does not return ok/trustedRoot', () => {
    const bin = installFakeGit(tempDir, 'exit 1', 'exit /b 1');
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();

    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
    expect(() => validateWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
  });

  it('same-root path with fake git exiting 1 also fails closed', () => {
    const bin = installFakeGit(tempDir, 'exit 1', 'exit /b 1');
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();

    expect(() => resolveWorkingDirectoryOrLinkedWorktree(sessionRepo)).toThrow(/git probe failed and was not used/);
  });
  it('omitted and empty workingDirectory fail closed when fake git exits 1', () => {
    const bin = installFakeGit(tempDir, 'exit 1', 'exit /b 1');
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();

    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree('')).toThrow(/git probe failed and was not used/);
    expect(() => validateWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
  });

  it('omitted workingDirectory fails closed when git is missing', () => {
    setGitShowToplevelProbeForTests(() => { throw spawnEnoent(); });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
  });

  it('absolute existing non-worktree stdout is malformed and fail-closed', () => {
    const bogus = join(tempDir, 'bogus-root');
    mkdirSync(bogus, { recursive: true });
    setGitShowToplevelProbeForTests(() => `${bogus}\n`);
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
  });
  it('foreign worktree stdout for the probed cwd fail-closes instead of redirecting', () => {
    setGitShowToplevelProbeForTests(() => `${foreignRepo}\n`);
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(sessionRepo)).toThrow(/git probe failed and was not used/);
  });

  it('trusted-root stdout for cwd plus foreign stdout for a subdirectory fail-closes', () => {
    setGitShowToplevelProbeForTests((cwd) => {
      const real = realpathSync(cwd);
      if (real === realpathSync(sessionRepo)) {
        return `${sessionRepo}\n`;
      }
      return `${foreignRepo}\n`;
    });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
  });
  it('ENOENT without a spawn syscall is not git-missing and fail-closes', () => {
    setGitShowToplevelProbeForTests(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      err.path = 'git';
      throw err;
    });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
  });

  it('ENOENT with killed or conflicting status is not git-missing', () => {
    setGitShowToplevelProbeForTests(() => {
      const err = spawnEnoent() as NodeJS.ErrnoException & { killed: boolean };
      err.killed = true;
      throw err;
    });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);

    setGitShowToplevelProbeForTests(() => {
      const err = spawnEnoent() as NodeJS.ErrnoException & { status: number };
      err.status = 1;
      throw err;
    });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
  });

  it('rev-parse 128 plus malformed .git at the trusted root fail-closes omitted workingDirectory', () => {
    const broken = join(tempDir, 'broken-trusted');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent-omc-3858-gitdir\n');
    process.chdir(broken);
    setGitShowToplevelProbeForTests(() => {
      throw gitExit(128, 'fatal: not a git repository (or any of the parent directories): .git\n');
    });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(broken)).toThrow(/git probe failed and was not used/);
  });

  it('does not reuse a successful probe after PATH is replaced with fake git', () => {
    expect(resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toEqual({
      status: 'ok',
      root: realpathSync(sessionRepo),
    });
    const bin = installFakeGit(tempDir, 'exit 1', 'exit /b 1');
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
  });




  it('injectable exit 1 / unexpected nonzero / malformed stdout fail closed', () => {
    const cases: Array<() => never | string> = [
      () => { throw gitExit(1, 'boom'); },
      () => { throw gitExit(2, 'fatal: unexpected'); },
      () => { throw gitExit(128, 'fatal: bad object'); },
      () => 'relative-not-absolute',
      () => '',
      () => '   \n',
    ];

    for (const probe of cases) {
      setGitShowToplevelProbeForTests(probe);
      clearWorktreeCache();
      expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
    }
  });

  it('injectable EACCES, ETIMEDOUT, killed timeout, and signal fail closed', () => {
    const cases: Array<() => never> = [
      () => { throw spawnError('EACCES'); },
      () => { throw spawnError('ETIMEDOUT'); },
      () => {
        const err = spawnError('ETIMEDOUT') as NodeJS.ErrnoException & { killed: boolean };
        err.killed = true;
        throw err;
      },
      () => { throw gitSignal('SIGTERM'); },
      () => { throw gitSignal('SIGKILL'); },
    ];

    for (const probe of cases) {
      setGitShowToplevelProbeForTests(probe);
      clearWorktreeCache();
      expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
    }
  });

  it('confirmed executable-not-found ENOENT fails closed for same-root and subdirectory', () => {
    setGitShowToplevelProbeForTests(() => { throw spawnEnoent(); });
    clearWorktreeCache();

    expect(() => resolveWorkingDirectoryOrLinkedWorktree(sessionRepo)).toThrow(/git probe failed and was not used/);
    expect(() => validateWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
  });

  it('PATH without git fails closed for same-root and subdirectory', () => {
    process.env.PATH = '';
    clearWorktreeCache();

    expect(() => validateWorkingDirectoryOrLinkedWorktree(sessionRepo)).toThrow(/git probe failed and was not used/);
    expect(() => validateWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
  });

  it('git missing still rejects a non-git path outside the trusted root', () => {
    setGitShowToplevelProbeForTests(() => { throw spawnEnoent(); });
    clearWorktreeCache();

    expect(() => validateWorkingDirectoryOrLinkedWorktree(plainDir)).toThrow(/git probe failed and was not used/);
  });

  it('rev-parse 128 not-a-repo still allows gitless subdirectory inside the trusted root', () => {
    const notARepo = gitExit(128, "fatal: not a git repository (or any of the parent directories): .git\n");
    setGitShowToplevelProbeForTests((cwd) => {
      if (realpathSync(cwd) === realpathSync(sessionRepo)) {
        return `${sessionRepo}\n`;
      }
      throw notARepo;
    });
    clearWorktreeCache();

    expect(validateWorkingDirectoryOrLinkedWorktree(srcDir)).toBe(realpathSync(sessionRepo));
  });

  it('rev-parse 128 not-a-repo still rejects a non-git path outside the trusted root', () => {
    setGitShowToplevelProbeForTests(() => {
      throw gitExit(128, 'fatal: not a git repository (or any of the parent directories): .git\n');
    });
    clearWorktreeCache();

    expect(() => validateWorkingDirectoryOrLinkedWorktree(plainDir)).toThrow(
      /git probe failed and was not used/,
    );
  });

  it('nested malformed .git still rejects under git-missing and 128 not-a-repo', () => {
    const nested = join(sessionRepo, 'vendor', 'nested-foreign');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, '.git'), 'gitdir: /nonexistent-omc-3858-gitdir\n');

    setGitShowToplevelProbeForTests(() => { throw spawnEnoent(); });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(nested)).toThrow(/git probe failed and was not used/);

    setGitShowToplevelProbeForTests(() => {
      throw gitExit(128, 'fatal: not a git repository (or any of the parent directories): .git\n');
    });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(nested)).toThrow(/git probe failed and was not used/);
  });

  it('generic probe failure still rejects nested malformed .git (does not weaken detection)', () => {
    const nested = join(sessionRepo, 'vendor', 'nested-foreign');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, '.git'), 'gitdir: /nonexistent-omc-3858-gitdir\n');
    setGitShowToplevelProbeForTests(() => { throw gitExit(1, 'boom'); });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(nested)).toThrow(/git probe failed and was not used/);
  });

  it('foreign repository still rejects when git works', () => {
    const resolution = resolveWorkingDirectoryOrLinkedWorktree(foreignRepo);
    expect(resolution.status).toBe('foreign_repository');
  });

  it('linked worktree still accepts when git works', () => {
    expect(resolveWorkingDirectoryOrLinkedWorktree(linkedWorktree)).toEqual({
      status: 'ok',
      root: realpathSync(linkedWorktree),
    });
  });

  it('linked worktree and foreign repo fail closed on generic probe failure', () => {
    setGitShowToplevelProbeForTests(() => { throw gitExit(1, 'boom'); });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(linkedWorktree)).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(foreignRepo)).toThrow(/git probe failed and was not used/);
  });

  it('submodule cwd still treats the superproject as foreign when git works', () => {
    const parentDir = join(tempDir, 'superproject');
    mkdirSync(parentDir, { recursive: true });
    git(parentDir, 'init');
    git(parentDir, 'config user.email "test@example.com"');
    git(parentDir, 'config user.name "Test User"');
    git(parentDir, 'commit --allow-empty -m parent-init');
    execSync(`git -c protocol.file.allow=always submodule add "${sessionRepo}" mysub`, {
      cwd: parentDir,
      stdio: 'pipe',
    });
    const submodulePath = join(parentDir, 'mysub');
    process.chdir(submodulePath);
    clearWorktreeCache();

    expect(resolveWorkingDirectoryOrLinkedWorktree(parentDir).status).toBe('foreign_repository');

    setGitShowToplevelProbeForTests(() => { throw gitExit(1, 'boom'); });
    clearWorktreeCache();
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(parentDir)).toThrow(/git probe failed and was not used/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  realpathSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  clearWorktreeCache,
  setGitShowToplevelProbeForTests,
} from '../../lib/worktree-paths.js';
import {
  wikiIngestTool,
  wikiAddTool,
  wikiQueryTool,
  wikiReadTool,
  wikiListTool,
  wikiLintTool,
  wikiDeleteTool,
} from '../wiki-tools.js';

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

type WikiResult = { isError?: boolean; content: Array<{ text: string }> };

async function invokeAllWikiTools(workingDirectory: string): Promise<Array<{ name: string; result: WikiResult }>> {
  return [
    { name: 'wiki_ingest', result: await wikiIngestTool.handler({ title: 'Foreign Page', content: 'should never be written', tags: ['x'], category: 'reference', workingDirectory }) },
    { name: 'wiki_add', result: await wikiAddTool.handler({ title: 'Foreign Page', content: 'should never be written', workingDirectory }) },
    { name: 'wiki_query', result: await wikiQueryTool.handler({ query: 'session-secret', workingDirectory }) },
    { name: 'wiki_read', result: await wikiReadTool.handler({ page: 'session-secret', workingDirectory }) },
    { name: 'wiki_list', result: await wikiListTool.handler({ workingDirectory }) },
    { name: 'wiki_lint', result: await wikiLintTool.handler({ workingDirectory }) },
    { name: 'wiki_delete', result: await wikiDeleteTool.handler({ page: 'session-secret', workingDirectory }) },
  ];
}

function spawnEnoent(): NodeJS.ErrnoException {
  const err = new Error('spawnSync git ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
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

function installFakeGit(dir: string, unixBody: string, winBody: string): string {
  const bin = join(dir, 'fake-git-bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'git.cmd'), `@echo off\r\n${winBody}\r\n`);
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!windowsRoot) throw new Error('SystemRoot or WINDIR is required on Windows');
    copyFileSync(join(windowsRoot, 'System32', 'where.exe'), join(bin, 'git.exe'));
  } else {
    const gitPath = join(bin, 'git');
    writeFileSync(gitPath, `#!/bin/sh\n${unixBody}\n`);
    chmodSync(gitPath, 0o755);
  }
  return bin;
}

function seedSessionWiki(sessionRepo: string): string {
  const wikiDir = join(sessionRepo, '.omc', 'wiki');
  mkdirSync(wikiDir, { recursive: true });
  const pagePath = join(wikiDir, 'session-secret.md');
  writeFileSync(
    pagePath,
    '---\ntitle: session-secret\ncategory: reference\nconfidence: high\ntags: [secret]\nupdated: 2026-08-24\n---\n\nsession-secret-body\n',
  );
  return pagePath;
}

describe('wiki tools fail closed on generic git probe failure (#3858 remaining P1)', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalPath: string | undefined;
  let sessionRepo: string;
  let srcDir: string;
  let foreignRepo: string;
  let linkedWorktree: string;
  let secretPage: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalPath = process.env.PATH;
    tempDir = mkdtempSync(join(tmpdir(), 'wiki-probe-failclosed-3858-'));
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
    secretPage = seedSessionWiki(sessionRepo);

    foreignRepo = join(tempDir, 'foreign-vault');
    mkdirSync(foreignRepo, { recursive: true });
    git(foreignRepo, 'init');
    git(foreignRepo, 'config user.email "test@example.com"');
    git(foreignRepo, 'config user.name "Test User"');
    writeFileSync(join(foreignRepo, 'README.md'), 'vault\n');
    git(foreignRepo, 'add README.md');
    git(foreignRepo, 'commit -m initial');
    mkdirSync(join(foreignRepo, '.omc', 'wiki'), { recursive: true });
    writeFileSync(
      join(foreignRepo, '.omc', 'wiki', 'aapanel-setup.md'),
      '---\ntitle: aaPanel Setup\ncategory: reference\nconfidence: high\ntags: [aapanel]\nupdated: 2026-08-24\n---\n\nforeign-only\n',
    );

    linkedWorktree = join(tempDir, 'session-linked');
    git(sessionRepo, `worktree add -b linked ${linkedWorktree}`);

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

  function assertNoWikiIo(secretBefore: string): void {
    expect(existsSync(secretPage)).toBe(true);
    expect(readFileSync(secretPage, 'utf8')).toBe(secretBefore);
    expect(existsSync(join(sessionRepo, '.omc', 'wiki', 'foreign-page.md'))).toBe(false);
    expect(existsSync(join(foreignRepo, '.omc', 'wiki', 'foreign-page.md'))).toBe(false);
    expect(existsSync(join(foreignRepo, '.omc', 'wiki', 'aapanel-setup.md'))).toBe(true);
    expect(existsSync(join(srcDir, '.omc'))).toBe(false);
  }

  async function assertAllToolsRejectWithoutIo(workingDirectory: string): Promise<void> {
    const secretBefore = readFileSync(secretPage, 'utf8');
    const results = await invokeAllWikiTools(workingDirectory);
    expect(results).toHaveLength(7);
    for (const { name, result } of results) {
      expect(result.isError, name).toBe(true);
      const text = result.content[0].text;
      expect(text, name).toMatch(/git probe failed and was not used/);
      expect(text, name).not.toContain('session-secret-body');
      expect(text, name).not.toContain('No wiki pages match');
      expect(text, name).not.toContain('Wiki page created');
      expect(text, name).not.toContain('Wiki ingest complete');
      expect(text, name).not.toContain('Deleted wiki page');
      expect(text, name).not.toContain('aaPanel');
      expect(text, name).not.toContain('foreign-only');
    }
    assertNoWikiIo(secretBefore);
  }

  it('seven wiki tools reject a trusted subdirectory when fake git exits 1 and perform no reads/writes/deletes', async () => {
    const bin = installFakeGit(tempDir, 'exit 1', 'exit /b 1');
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();
    await assertAllToolsRejectWithoutIo(srcDir);
    await assertAllToolsRejectWithoutIo(undefined as unknown as string);
    await assertAllToolsRejectWithoutIo('');
  });

  it('seven wiki tools reject omitted workingDirectory when fake git exits 1', async () => {
    const bin = installFakeGit(tempDir, 'exit 1', 'exit /b 1');
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();
    const secretBefore = readFileSync(secretPage, 'utf8');
    const results = await invokeAllWikiTools(undefined as unknown as string);
    expect(results).toHaveLength(7);
    for (const { name, result } of results) {
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toMatch(/git probe failed and was not used/);
    }
    assertNoWikiIo(secretBefore);
  });

  it('seven wiki tools reject absolute existing non-worktree stdout with no wiki IO', async () => {
    const bogus = join(tempDir, 'bogus-root');
    mkdirSync(bogus, { recursive: true });
    setGitShowToplevelProbeForTests(() => `${bogus}\n`);
    clearWorktreeCache();
    await assertAllToolsRejectWithoutIo(srcDir);
    await assertAllToolsRejectWithoutIo(undefined as unknown as string);
  });
  it('seven wiki tools reject foreign worktree stdout with no wiki IO', async () => {
    setGitShowToplevelProbeForTests(() => `${foreignRepo}\n`);
    clearWorktreeCache();
    await assertAllToolsRejectWithoutIo(srcDir);
    await assertAllToolsRejectWithoutIo(undefined as unknown as string);
    await assertAllToolsRejectWithoutIo('');
  });

  it('seven wiki tools reject trusted-root plus foreign subdirectory stdout with no wiki IO', async () => {
    setGitShowToplevelProbeForTests((cwd) => {
      try {
        if (realpathSync(cwd) === realpathSync(sessionRepo)) {
          return `${sessionRepo}\n`;
        }
      } catch {
        // fall through
      }
      return `${foreignRepo}\n`;
    });
    clearWorktreeCache();
    await assertAllToolsRejectWithoutIo(srcDir);
  });


  it('seven wiki tools reject injectable EACCES/ETIMEDOUT/signal/malformed probes with no wiki IO', async () => {
    const probes: Array<() => never | string> = [
      () => {
        const err = new Error('spawnSync git EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        err.path = 'git';
        err.syscall = 'spawnSync git';
        throw err;
      },
      () => {
        const err = new Error('spawnSync git ETIMEDOUT') as NodeJS.ErrnoException & { killed: boolean };
        err.code = 'ETIMEDOUT';
        err.killed = true;
        throw err;
      },
      () => {
        const err = new Error('git killed') as Error & { signal: string; status: null };
        err.signal = 'SIGTERM';
        err.status = null;
        throw err;
      },
      () => 'not-absolute',
      () => { throw gitExit(1, 'boom'); },
    ];

    for (const probe of probes) {
      setGitShowToplevelProbeForTests(probe);
      clearWorktreeCache();
      await assertAllToolsRejectWithoutIo(srcDir);
    }
  });

  it('git missing fails closed for same-root/subdir wiki IO', async () => {
    setGitShowToplevelProbeForTests(() => { throw spawnEnoent(); });
    clearWorktreeCache();

    await assertAllToolsRejectWithoutIo(srcDir);
    await assertAllToolsRejectWithoutIo(sessionRepo);
    expect(existsSync(secretPage)).toBe(true);
  });

  it('PATH without git fails closed for same-root/subdir wiki IO', async () => {
    process.env.PATH = '';
    clearWorktreeCache();
    await assertAllToolsRejectWithoutIo(srcDir);
  });
  it('seven wiki tools reject omitted workingDirectory when trusted root has malformed .git and git returns 128', async () => {
    const broken = join(tempDir, 'broken-trusted');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent-omc-3858-gitdir\n');
    process.chdir(broken);
    setGitShowToplevelProbeForTests(() => {
      throw gitExit(128, 'fatal: not a git repository (or any of the parent directories): .git\n');
    });
    clearWorktreeCache();
    const secretBefore = readFileSync(secretPage, 'utf8');
    const results = await invokeAllWikiTools(undefined as unknown as string);
    expect(results).toHaveLength(7);
    for (const { name, result } of results) {
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toMatch(/git probe failed and was not used/);
    }
    process.chdir(sessionRepo);
    assertNoWikiIo(secretBefore);
  });


  it('non-git directory outside the trusted root still rejects without wiki IO', async () => {
    const plainDir = join(tempDir, 'plain-notes');
    mkdirSync(plainDir, { recursive: true });
    setGitShowToplevelProbeForTests(() => { throw spawnEnoent(); });
    clearWorktreeCache();
    const secretBefore = readFileSync(secretPage, 'utf8');
    const result = await wikiQueryTool.handler({ query: 'session-secret', workingDirectory: plainDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/git probe failed and was not used/);
    expect(readFileSync(secretPage, 'utf8')).toBe(secretBefore);
  });

  it('linked worktree wiki still works when git works, and fails closed on generic probe failure', async () => {
    const query = await wikiQueryTool.handler({ query: 'session-secret', workingDirectory: linkedWorktree });
    expect(query.isError).toBeUndefined();
    expect(query.content[0].text).toContain('No wiki pages match');

    setGitShowToplevelProbeForTests(() => { throw gitExit(1, 'boom'); });
    clearWorktreeCache();
    await assertAllToolsRejectWithoutIo(linkedWorktree);
  });

  it('foreign repository still rejects when git works, and fails closed on generic probe failure', async () => {
    const foreign = await wikiQueryTool.handler({ query: 'aaPanel', workingDirectory: foreignRepo });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0].text).toContain('belongs to a different repository');

    setGitShowToplevelProbeForTests(() => { throw gitExit(1, 'boom'); });
    clearWorktreeCache();
    await assertAllToolsRejectWithoutIo(foreignRepo);
  });
});

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
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DIST_RESOLVER = join(REPO_ROOT, 'dist/lib/worktree-paths.js');
const DIST_WIKI = join(REPO_ROOT, 'dist/tools/wiki-tools.js');

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

function installFakeGit(dir: string, unixBody: string, winBody: string): string {
  const bin = join(dir, 'fake-git-bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'git.cmd'), `@echo off\r\n${winBody}\r\n`);
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!windowsRoot) throw new Error('SystemRoot or WINDIR is required on Windows');
    // Node can retain a transient executable-image handle after exit, making
    // immediate PATH re-probes of a copied node.exe fail with EPERM. where.exe
    // is a small native executable that deterministically exits nonzero for
    // the git argv used here without the self-hosted Node lock race.
    copyFileSync(join(windowsRoot, 'System32', 'where.exe'), join(bin, 'git.exe'));
  } else {
    const gitPath = join(bin, 'git');
    writeFileSync(gitPath, `#!/bin/sh\n${unixBody}\n`);
    chmodSync(gitPath, 0o755);
  }
  return bin;
}

describe('tracked dist wiki runtime fail-closed (#3858 remaining P1)', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalPath: string | undefined;
  let sessionRepo: string;
  let srcDir: string;
  let secretPage: string;
  let clearWorktreeCache: () => void;
  let resolveWorkingDirectoryOrLinkedWorktree: (workingDirectory?: string) => { status: string; root?: string };
  let wikiTools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalPath = process.env.PATH;
    const resolverMod = await import(pathToFileURL(DIST_RESOLVER).href) as {
      clearWorktreeCache: () => void;
      resolveWorkingDirectoryOrLinkedWorktree: (workingDirectory?: string) => { status: string; root?: string };
    };
    const wikiMod = await import(pathToFileURL(DIST_WIKI).href) as {
      wikiIngestTool: { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
      wikiAddTool: { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
      wikiQueryTool: { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
      wikiReadTool: { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
      wikiListTool: { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
      wikiLintTool: { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
      wikiDeleteTool: { handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
    };
    clearWorktreeCache = resolverMod.clearWorktreeCache;
    resolveWorkingDirectoryOrLinkedWorktree = resolverMod.resolveWorkingDirectoryOrLinkedWorktree;
    wikiTools = [
      { name: 'wiki_ingest', handler: wikiMod.wikiIngestTool.handler },
      { name: 'wiki_add', handler: wikiMod.wikiAddTool.handler },
      { name: 'wiki_query', handler: wikiMod.wikiQueryTool.handler },
      { name: 'wiki_read', handler: wikiMod.wikiReadTool.handler },
      { name: 'wiki_list', handler: wikiMod.wikiListTool.handler },
      { name: 'wiki_lint', handler: wikiMod.wikiLintTool.handler },
      { name: 'wiki_delete', handler: wikiMod.wikiDeleteTool.handler },
    ];

    tempDir = mkdtempSync(join(tmpdir(), 'direct-dist-3858-'));
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
    mkdirSync(join(sessionRepo, '.omc', 'wiki'), { recursive: true });
    secretPage = join(sessionRepo, '.omc', 'wiki', 'session-secret.md');
    writeFileSync(
      secretPage,
      '---\ntitle: session-secret\ncategory: reference\nconfidence: high\ntags: [secret]\nupdated: 2026-08-24\n---\n\nsession-secret-body\n',
    );
    process.chdir(sessionRepo);
    clearWorktreeCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    clearWorktreeCache();
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('tracked dist resolver and seven wiki tools fail closed on fake git exit 1 with no wiki IO', async () => {
    const bin = installFakeGit(tempDir, 'exit 1', 'exit /b 1');
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();

    expect(() => resolveWorkingDirectoryOrLinkedWorktree(srcDir)).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree()).toThrow(/git probe failed and was not used/);

    const secretBefore = readFileSync(secretPage, 'utf8');
    const calls = [
      { name: 'wiki_ingest', args: { title: 'Foreign Page', content: 'should never be written', tags: ['x'], category: 'reference', workingDirectory: srcDir } },
      { name: 'wiki_add', args: { title: 'Foreign Page', content: 'should never be written', workingDirectory: srcDir } },
      { name: 'wiki_query', args: { query: 'session-secret', workingDirectory: srcDir } },
      { name: 'wiki_read', args: { page: 'session-secret', workingDirectory: srcDir } },
      { name: 'wiki_list', args: { workingDirectory: srcDir } },
      { name: 'wiki_lint', args: { workingDirectory: srcDir } },
      { name: 'wiki_delete', args: { page: 'session-secret', workingDirectory: srcDir } },
      { name: 'wiki_query_omitted', args: { query: 'session-secret' } },
    ];

    for (const call of calls) {
      const tool = wikiTools.find((candidate) => call.name.startsWith(candidate.name));
      expect(tool, call.name).toBeDefined();
      const result = await tool!.handler(call.args);
      expect(result.isError, call.name).toBe(true);
      expect(result.content[0].text, call.name).toMatch(/git probe failed and was not used/);
      expect(result.content[0].text, call.name).not.toContain('session-secret-body');
    }

    expect(readFileSync(secretPage, 'utf8')).toBe(secretBefore);
    expect(existsSync(join(sessionRepo, '.omc', 'wiki', 'foreign-page.md'))).toBe(false);
    expect(existsSync(join(srcDir, '.omc'))).toBe(false);
  });
});

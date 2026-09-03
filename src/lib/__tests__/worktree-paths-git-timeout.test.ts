import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  clearWorktreeCache,
  getProjectIdentifier,
  resolveTranscriptPath,
} from '../../lib/worktree-paths.js';

// Every execFileSync('git', ...) in worktree-paths.ts must pass a timeout.
// Without one the call blocks until git exits, so a wedged git turns a HUD
// render into a process that never returns (#3946). These tests wedge exactly
// one subcommand and assert the caller still returns.
// Resolved lazily: this module is collected on Windows too, where the
// describe below is skipped and `command -v` does not exist.
function realGitPath(): string {
  return execSync('command -v git', { encoding: 'utf-8' }).trim();
}
const WEDGE_SECONDS = 60;
// The bound each call site declares, plus room for the surrounding real git
// calls. Far below WEDGE_SECONDS, so an unbounded call cannot pass.
const RETURN_BUDGET_MS = 25_000;

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

/** A git shim that hangs on one subcommand and delegates everything else. */
function installWedgedGit(dir: string, wedgedArgs: string): string {
  const bin = join(dir, 'wedged-git-bin');
  mkdirSync(bin, { recursive: true });
  const gitPath = join(bin, 'git');
  writeFileSync(
    gitPath,
    [
      '#!/bin/sh',
      `case "$*" in`,
      // `exec` so the shim process *becomes* sleep: execFileSync's timeout
      // kills the process it spawned, and a forked child would outlive it.
      `  ${wedgedArgs}) exec sleep ${WEDGE_SECONDS} ;;`,
      `  *) exec ${realGitPath()} "$@" ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(gitPath, 0o755);
  return bin;
}

describe.skipIf(process.platform === 'win32')('worktree-paths git calls are bounded (#3946)', () => {
  let tempDir: string;
  let repo: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    tempDir = mkdtempSync(join(tmpdir(), 'wtp-git-timeout-3946-'));
    repo = join(tempDir, 'project');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init');
    git(repo, 'config user.email "test@example.com"');
    git(repo, 'config user.name "Test User"');
    writeFileSync(join(repo, 'README.md'), 'project\n');
    git(repo, 'add README.md');
    git(repo, 'commit -m initial');
    git(repo, 'remote add origin https://example.invalid/owner/project.git');
    clearWorktreeCache();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('the wedged shim really does hang the subcommand it targets', () => {
    const bin = installWedgedGit(tempDir, "'remote get-url origin'");
    const started = Date.now();
    expect(() =>
      execFileSync(join(bin, 'git'), ['remote', 'get-url', 'origin'], {
        cwd: repo,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 2_000,
      }),
    ).toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);

    // Same shim, a subcommand it does not target: delegated, so it returns.
    expect(
      execFileSync(join(bin, 'git'), ['rev-parse', '--show-toplevel'], {
        cwd: repo,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
      }).trim(),
    ).toBeTruthy();
  });

  it('getProjectIdentifier returns when `git remote get-url origin` hangs', () => {
    const bin = installWedgedGit(tempDir, "'remote get-url origin'");
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();

    const started = Date.now();
    const identifier = getProjectIdentifier(repo);
    const elapsed = Date.now() - started;

    expect(identifier).toBeTruthy();
    expect(elapsed).toBeLessThan(RETURN_BUDGET_MS);
  }, 90_000);

  it('resolveTranscriptPath returns when `git rev-parse --git-common-dir` hangs', () => {
    const bin = installWedgedGit(tempDir, "'rev-parse --git-common-dir'");
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();

    const missingTranscript = join(tempDir, 'projects', 'encoded-project', 'session.jsonl');
    const started = Date.now();
    const resolved = resolveTranscriptPath(missingTranscript, repo);
    const elapsed = Date.now() - started;

    // Nothing resolves, so the contract is to hand back the input path
    // (worktree-paths.ts:1855). Asserting the value, not just its type,
    // is what keeps an undefined-returning regression from passing here.
    expect(resolved).toBe(missingTranscript);
    expect(elapsed).toBeLessThan(RETURN_BUDGET_MS);
  }, 90_000);

  it('resolveTranscriptPath returns when `git rev-parse --show-toplevel` hangs', () => {
    const bin = installWedgedGit(tempDir, "'rev-parse --show-toplevel'");
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    clearWorktreeCache();

    const missingTranscript = join(tempDir, 'projects', 'encoded-project', 'session.jsonl');
    const started = Date.now();
    const resolved = resolveTranscriptPath(missingTranscript, repo);
    const elapsed = Date.now() - started;

    expect(resolved).toBe(missingTranscript);
    expect(elapsed).toBeLessThan(RETURN_BUDGET_MS);
  }, 90_000);
});

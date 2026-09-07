import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { clearWorktreeCache, probeGitTopLevel, setGitShowToplevelProbeForTests } from '../../lib/worktree-paths.js';

// A real (non-test-mode) git spawn that prints a *localized* "not a git
// repository" message unless the caller forces LC_ALL=C, mirroring what
// git's gettext layer does on a non-English system locale (e.g. Korean:
// "깃 저장소가 아닙니다"). isNotAGitRepositoryError() only recognizes the
// English string, so without forcing LC_ALL=C on the spawn, a plain "this
// directory is not a git repository" answer is misclassified as
// `probe_failed` instead of `not_a_repository` — which fails closed and
// breaks every caller (e.g. the HUD statusline) in a non-git directory.
function installLocaleAwareFakeGit(dir: string): string {
  const bin = join(dir, 'fake-git-bin');
  mkdirSync(bin, { recursive: true });
  const gitPath = join(bin, 'git');
  writeFileSync(
    gitPath,
    [
      '#!/bin/sh',
      'if [ "$LC_ALL" = "C" ]; then',
      '  echo "fatal: not a git repository (or any of the parent directories): .git" 1>&2',
      'else',
      '  echo "fatal: (현재 폴더 또는 상위 폴더 중 일부가) 깃 저장소가 아닙니다: .git" 1>&2',
      'fi',
      'exit 128',
      '',
    ].join('\n'),
  );
  chmodSync(gitPath, 0o755);
  return bin;
}

describe('probeGitTopLevel locale independence', () => {
  let tempDir: string;
  let plainDir: string;
  let originalPath: string | undefined;
  let originalLcAll: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalLcAll = process.env.LC_ALL;
    // Simulate a session whose ambient locale is Korean, not English.
    process.env.LC_ALL = 'ko_KR.UTF-8';
    tempDir = mkdtempSync(join(tmpdir(), 'probe-locale-'));
    plainDir = join(tempDir, 'plain-notes');
    mkdirSync(plainDir, { recursive: true });
    setGitShowToplevelProbeForTests(undefined);
    clearWorktreeCache();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
    setGitShowToplevelProbeForTests(undefined);
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('classifies a localized "not a git repository" answer as not_a_repository, not probe_failed', () => {
    if (process.platform === 'win32') return; // fake git is a POSIX shell script
    const bin = installLocaleAwareFakeGit(tempDir);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;

    const result = probeGitTopLevel(plainDir);

    expect(result.status).toBe('not_a_repository');
  });
});

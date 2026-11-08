import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearWorktreeCache,
  probeGitTopLevel,
  setGitShowToplevelProbeForTests,
  validateWorkingDirectory,
  resolveWorkingDirectoryOrLinkedWorktree,
  validateWorkingDirectoryOrLinkedWorktree,
} from '../../lib/worktree-paths.js';

// The `git worktree` container layout (#3990): a bare repository lives at
// `<container>/.bare`, `<container>/.git` is a file pointing at it, and every
// checkout is a sibling linked worktree. `git rev-parse --show-toplevel` in the
// container exits 128 with "this operation must be run in a work tree" — a
// benign absence of a work tree, not an unreadable repository. Before the fix
// that answer was classified as `probe_failed`, so the fail-closed guards threw
// and the HUD statusline printed "[OMC] HUD error" from a legitimate container.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

describe('bare-repository worktree container', () => {
  let tempDir: string;
  let container: string;
  let linkedWorktree: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'bare-container-')));
    container = join(tempDir, 'hub');
    mkdirSync(container, { recursive: true });

    git(container, ['init', '--bare', '--initial-branch=main', '.bare']);
    writeFileSync(join(container, '.git'), 'gitdir: ./.bare\n');

    // A bare repository has no commits yet, so create one through a temporary
    // worktree so that `git worktree add` has a real branch to check out.
    const seed = join(tempDir, 'seed');
    git(tempDir, ['clone', join(container, '.bare'), 'seed']);
    writeFileSync(join(seed, 'README.md'), '# hub\n');
    git(seed, ['add', 'README.md']);
    git(seed, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'seed']);
    git(seed, ['push', 'origin', 'HEAD:refs/heads/main']);
    rmSync(seed, { recursive: true, force: true });

    linkedWorktree = join(container, 'feature');
    git(container, ['worktree', 'add', 'feature', 'main']);

    setGitShowToplevelProbeForTests(undefined);
    clearWorktreeCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setGitShowToplevelProbeForTests(undefined);
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('classifies the bare container as not_a_repository instead of probe_failed', () => {
    expect(probeGitTopLevel(container).status).toBe('not_a_repository');
  });

  it('still resolves a real work tree inside the container', () => {
    const probe = probeGitTopLevel(linkedWorktree);
    expect(probe.status).toBe('ok');
    if (probe.status !== 'ok') return;
    expect(realpathSync(probe.root)).toBe(realpathSync(linkedWorktree));
  });

  it('validateWorkingDirectory returns the container instead of throwing', () => {
    process.chdir(container);
    clearWorktreeCache();

    expect(realpathSync(validateWorkingDirectory())).toBe(container);
    expect(realpathSync(validateWorkingDirectory(container))).toBe(container);
  });

  it('resolveWorkingDirectoryOrLinkedWorktree degrades instead of throwing from the container', () => {
    process.chdir(container);
    clearWorktreeCache();

    const resolution = resolveWorkingDirectoryOrLinkedWorktree();
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') return;
    expect(realpathSync(resolution.root)).toBe(container);

    expect(realpathSync(validateWorkingDirectoryOrLinkedWorktree(container))).toBe(container);
  });

  it('reaches the linked worktree from the container as the session cwd', () => {
    process.chdir(container);
    clearWorktreeCache();

    const resolution = resolveWorkingDirectoryOrLinkedWorktree(linkedWorktree);
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') return;
    expect(realpathSync(resolution.root)).toBe(realpathSync(linkedWorktree));
  });

  it('keeps rejecting a non-bare directory that only carries a bogus .git', () => {
    const bogus = join(tempDir, 'bogus');
    mkdirSync(bogus, { recursive: true });
    writeFileSync(join(bogus, '.git'), 'gitdir: /nonexistent/elsewhere\n');
    process.chdir(container);
    clearWorktreeCache();

    expect(() => resolveWorkingDirectoryOrLinkedWorktree(bogus)).toThrow(
      /git probe failed and was not used/,
    );
  });
});

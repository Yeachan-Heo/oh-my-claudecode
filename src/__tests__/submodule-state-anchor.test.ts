/**
 * Regression test for issue #3349: state root mis-anchors to a git submodule.
 *
 * When the shell cwd drifts into a git submodule, `git rev-parse --show-toplevel`
 * returns the submodule's own root (a submodule is a complete git repo), so OMC
 * created a stray `.omc/` inside the submodule working tree. The fix climbs to
 * the outermost superproject working tree via `--show-superproject-working-tree`
 * so state anchors to the monorepo root.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorktreeRoot, getGitTopLevel, getOmcRoot, resolveToWorktreeRoot, clearWorktreeCache } from '../lib/worktree-paths.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

describe('submodule state anchoring (issue #3349)', () => {
  let tempDir: string;
  let superRoot: string;
  let submodulePath: string;
  let nestedSubmodulePath: string;
  let gitAvailable = true;

  beforeAll(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'omc-submodule-')));
    superRoot = join(tempDir, 'monorepo');
    const child = join(tempDir, 'child-origin');
    const leaf = join(tempDir, 'leaf-origin');
    const mid = join(tempDir, 'mid-origin');
    try {
      initRepo(child);
      initRepo(superRoot);
      // Register the child repo as a submodule at apps/webapp.
      git(superRoot, 'submodule', 'add', child, 'apps/webapp');
      git(superRoot, 'commit', '-qm', 'add submodule');
      submodulePath = join(superRoot, 'apps', 'webapp');

      // Build a nested submodule chain: leaf is a submodule of mid, and mid is
      // a submodule of the superproject — so apps/mid/pkg climbs two levels.
      initRepo(leaf);
      initRepo(mid);
      git(mid, 'submodule', 'add', leaf, 'pkg');
      git(mid, 'commit', '-qm', 'add nested submodule');
      git(superRoot, 'submodule', 'add', mid, 'apps/mid');
      git(superRoot, 'commit', '-qm', 'add mid submodule');
      git(superRoot, 'submodule', 'update', '--init', '--recursive');
      nestedSubmodulePath = join(superRoot, 'apps', 'mid', 'pkg');
    } catch {
      gitAvailable = false;
    }
    clearWorktreeCache();
  });

  afterAll(() => {
    clearWorktreeCache();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('getWorktreeRoot from inside a submodule resolves to the superproject root', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    expect(getWorktreeRoot(submodulePath)).toBe(superRoot);
  });

  it('getOmcRoot from inside a submodule anchors .omc/ to the superproject root', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    const prev = process.env.OMC_STATE_DIR;
    delete process.env.OMC_STATE_DIR;
    try {
      expect(getOmcRoot(submodulePath)).toBe(join(superRoot, '.omc'));
    } finally {
      if (prev !== undefined) process.env.OMC_STATE_DIR = prev;
      clearWorktreeCache();
    }
  });

  it('getWorktreeRoot from a nested submodule climbs to the outermost superproject', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    expect(getWorktreeRoot(nestedSubmodulePath)).toBe(superRoot);
  });

  it('getWorktreeRoot in a plain (non-submodule) repo still returns its own toplevel', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    expect(getWorktreeRoot(superRoot)).toBe(superRoot);
  });

  // Security boundary: path-restriction / containment checks must stay confined
  // to the submodule, NOT climb to the superproject (Codex review on PR #3350).
  it('getGitTopLevel from inside a submodule stays at the submodule (no climb)', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    expect(getGitTopLevel(submodulePath)).toBe(submodulePath);
    // Contrast: the state-anchor resolver DOES climb to the superproject.
    clearWorktreeCache();
    expect(getWorktreeRoot(submodulePath)).toBe(superRoot);
  });

  // Hook normalization contract (Codex P2 review on PR #3350): every hook
  // entrypoint runs input.directory through resolveToWorktreeRoot() before
  // resolving state. Under OMC_STATE_DIR the resolved root becomes the
  // centralized *identity*, which must preserve the submodule — NOT climb to
  // the superproject — otherwise a submodule session merges into the parent's
  // centralized state. Default (on-disk) mode must still climb for #3349.
  it('resolveToWorktreeRoot preserves submodule identity under OMC_STATE_DIR (no climb)', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    const prev = process.env.OMC_STATE_DIR;
    process.env.OMC_STATE_DIR = join(tempDir, 'central');
    try {
      // OMC_STATE_DIR set: identity-bearing root stays at the submodule.
      expect(resolveToWorktreeRoot(submodulePath)).toBe(submodulePath);
    } finally {
      if (prev === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = prev;
      clearWorktreeCache();
    }
  });

  it('resolveToWorktreeRoot still climbs to the superproject in default (on-disk) mode', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    const prev = process.env.OMC_STATE_DIR;
    delete process.env.OMC_STATE_DIR;
    try {
      expect(resolveToWorktreeRoot(submodulePath)).toBe(superRoot);
    } finally {
      if (prev !== undefined) process.env.OMC_STATE_DIR = prev;
      clearWorktreeCache();
    }
  });

  it('centralized .omc for a submodule session does not merge into the parent superproject', () => {
    if (!gitAvailable) return;
    clearWorktreeCache();
    const prev = process.env.OMC_STATE_DIR;
    const central = join(tempDir, 'central');
    process.env.OMC_STATE_DIR = central;
    try {
      // Mirror the hook path: resolveToWorktreeRoot() then getOmcRoot().
      const submoduleOmc = getOmcRoot(resolveToWorktreeRoot(submodulePath));
      clearWorktreeCache();
      const superOmc = getOmcRoot(resolveToWorktreeRoot(superRoot));
      expect(submoduleOmc).not.toBe(superOmc);
      expect(submoduleOmc.startsWith(central)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = prev;
      clearWorktreeCache();
    }
  });
});

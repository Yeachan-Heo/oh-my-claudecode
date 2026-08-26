/**
 * Non-git state-root anchoring contract (#3873).
 *
 * Covers the three defects reported in the issue:
 *  1. cwd-fragmentation: every non-git working directory became its own
 *     `.omc/` state root.
 *  2. sensitive-location writes: `.omc/` was created inside `~/.ssh`,
 *     `~/.claude`, and similar locations.
 *  3. ignored `workingDirectory`: state tools silently resolved a provided
 *     non-git directory back to the session's trusted root, so state_clear
 *     reported "no state found" while state lived elsewhere.
 *
 * All tests are deterministic: no real HOME is touched (`os.homedir` is
 * mocked to a per-suite temp dir), no network, no time dependence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const osPaths: { home: string; tmp: string } = { home: '', tmp: '' };

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => osPaths.home),
    tmpdir: vi.fn(() => osPaths.tmp),
  };
});

const realTmp = (() => {
  try { return process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp'; }
  catch { return '/tmp'; }
})();
const suiteRoot = mkdtempSync(join(resolve(realTmp), 'omc-3873-suite-'));
osPaths.home = join(suiteRoot, 'home');
mkdirSync(osPaths.home, { recursive: true });
osPaths.tmp = join(suiteRoot, 'tmp');
mkdirSync(osPaths.tmp, { recursive: true });
const fakeHome = osPaths.home;

import {
  getOmcRoot,
  validateWorkingDirectory,
  resolveStateWorkingDirectory,
  resolveNonGitStateAnchor,
  isSensitiveStateLocation,
  clearWorktreeCache,
  ensureAllOmcDirs,
} from '../worktree-paths.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let scratch: string;
const prevCwd = process.cwd();
const prevStateDir = process.env.OMC_STATE_DIR;
const prevDisableMultirepo = process.env.OMC_DISABLE_MULTIREPO;

beforeEach(() => {
  scratch = mkdtempSync(join(suiteRoot, 'scratch-'));
  if (prevStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = prevStateDir;
  if (prevDisableMultirepo === undefined) delete process.env.OMC_DISABLE_MULTIREPO;
  else process.env.OMC_DISABLE_MULTIREPO = prevDisableMultirepo;
  clearWorktreeCache();
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(scratch, { recursive: true, force: true });
  if (prevStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = prevStateDir;
  if (prevDisableMultirepo === undefined) delete process.env.OMC_DISABLE_MULTIREPO;
  else process.env.OMC_DISABLE_MULTIREPO = prevDisableMultirepo;
  clearWorktreeCache();
});

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
}

describe('#3873 non-git state-root anchoring', () => {
  describe('fragmentation collapse (getOmcRoot no-arg)', () => {
    it('three non-git cwds resolve to one state root before and after an anchor exists', () => {
      const base = join(scratch, 'nogit');
      mkdirSync(join(base, 'a', 'b'), { recursive: true });

      const roots = new Set<string>();
      for (const dir of [base, join(base, 'a'), join(base, 'a', 'b')]) {
        process.chdir(dir);
        clearWorktreeCache();
        roots.add(getOmcRoot());
      }
      expect(roots.size).toBe(1);
      expect([...roots][0]).toBe(join(fakeHome, '.omc'));

      mkdirSync(join(base, '.omc'), { recursive: true });
      const rootsAfter = new Set<string>();
      for (const dir of [base, join(base, 'a'), join(base, 'a', 'b')]) {
        process.chdir(dir);
        clearWorktreeCache();
        rootsAfter.add(getOmcRoot());
      }
      expect(rootsAfter.size).toBe(1);
      expect([...rootsAfter][0]).toBe(join(base, '.omc'));
    });

    it('nested hook directories adopt an existing project root', () => {
      const project = join(scratch, 'dotfiles');
      const hookDirs = [
        join(project, '.claude'),
        join(project, '.claude', 'hooks'),
        join(project, '.claude', 'hooks', 'lib'),
        join(project, '.claude', 'hooks', 'experiments'),
      ];
      for (const directory of hookDirs) mkdirSync(directory, { recursive: true });
      mkdirSync(join(project, '.omc'), { recursive: true });

      process.chdir(project);
      const projectRoot = getOmcRoot();
      expect(projectRoot).toBe(join(project, '.omc'));
      for (const directory of hookDirs) {
        process.chdir(directory);
        clearWorktreeCache();
        expect(getOmcRoot()).toBe(projectRoot);
      }
    });
  });

  describe('sensitive-location refusal', () => {
    it('cwd inside ~/.ssh never anchors state in ~/.ssh', () => {
      const ssh = join(fakeHome, '.ssh');
      const nested = join(ssh, 'nested');
      mkdirSync(join(nested, '.omc'), { recursive: true });
      process.chdir(nested);
      clearWorktreeCache();
      const root = getOmcRoot();
      expect(root).not.toBe(join(nested, '.omc'));
      expect(root.startsWith(join(ssh))).toBe(false);
    });

    it('cwd directly in HOME anchors to ~/.omc, not HOME itself', () => {
      process.chdir(fakeHome);
      expect(getOmcRoot()).toBe(join(fakeHome, '.omc'));
    });

    it('cwd in a user content directory never anchors there', () => {
      const downloads = join(fakeHome, 'Downloads');
      mkdirSync(join(downloads, '.omc'), { recursive: true });
      process.chdir(downloads);
      clearWorktreeCache();
      expect(getOmcRoot()).not.toBe(join(downloads, '.omc'));
    });

    it('isSensitiveStateLocation marks well-known sensitive dirs', () => {
      for (const name of ['.ssh', '.gnupg', '.aws', '.config', '.claude', '.codex', '.cache', '.npm']) {
        expect(isSensitiveStateLocation(join(fakeHome, name)), name).toBe(true);
      }
      expect(isSensitiveStateLocation(fakeHome)).toBe(true);
      for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music']) {
        expect(isSensitiveStateLocation(join(fakeHome, name)), name).toBe(true);
      }
      if (process.platform !== 'win32') {
        for (const path of ['/tmp', '/var', '/usr', '/etc', '/opt']) {
          expect(isSensitiveStateLocation(path), path).toBe(true);
        }
        expect(isSensitiveStateLocation('/')).toBe(true);
      }
    });

    it('does not flag ordinary project directories', () => {
      const project = join(scratch, 'my-project');
      mkdirSync(project, { recursive: true });
      expect(isSensitiveStateLocation(project)).toBe(false);
      expect(isSensitiveStateLocation(join(project, 'src'))).toBe(false);
    });

    it('walk-up skips sensitive ancestors and adopts the nearest safe .omc', () => {
      const project = join(scratch, 'proj');
      mkdirSync(join(project, '.config', 'work'), { recursive: true });
      mkdirSync(join(project, '.omc'), { recursive: true });
      expect(resolveNonGitStateAnchor(join(project, '.config', 'work'))).toBe(project);
    });
  });

  describe('non-git fallback is the per-user root', () => {
    it('falls back to ~/.omc when no ancestor has .omc', () => {
      const deep = join(scratch, 'nowhere', 'a', 'b');
      mkdirSync(deep, { recursive: true });
      expect(resolveNonGitStateAnchor(deep)).toBe(fakeHome);
    });

    it('adopts the nearest ancestor .omc directory, not an .omc file', () => {
      const base = join(scratch, 'anchor-tree');
      const mid = join(base, 'x');
      mkdirSync(join(base, 'x', 'y'), { recursive: true });
      mkdirSync(join(base, '.omc'), { recursive: true });
      writeFileSync(join(mid, '.omc'), 'not a directory');
      expect(resolveNonGitStateAnchor(join(base, 'x', 'y'))).toBe(base);
    });
  });

  describe('invariants unchanged', () => {
    it('git repos still anchor at the git toplevel from any subdir', () => {
      if (!gitAvailable) return;
      const repo = join(scratch, 'repo');
      mkdirSync(join(repo, 'x', 'y'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      for (const dir of [repo, join(repo, 'x'), join(repo, 'x', 'y')]) {
        process.chdir(dir);
        clearWorktreeCache();
        expect(getOmcRoot()).toBe(join(repo, '.omc'));
      }
    });

    it('OMC_STATE_DIR still centralizes non-git state', () => {
      const central = join(scratch, 'central-state');
      mkdirSync(central, { recursive: true });
      process.env.OMC_STATE_DIR = central;
      const dir = join(scratch, 'anywhere', 'deep');
      mkdirSync(dir, { recursive: true });
      process.chdir(dir);
      clearWorktreeCache();
      const root = getOmcRoot();
      expect(root.startsWith(central)).toBe(true);
      expect(root).not.toBe(join(dir, '.omc'));
    });

    it('OMC_STATE_DIR uses one fixed non-git child for multiple directories', () => {
      const central = join(scratch, 'central-fixed');
      const first = join(scratch, 'first');
      const second = join(scratch, 'second');
      mkdirSync(central, { recursive: true });
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      process.env.OMC_STATE_DIR = central;
      process.chdir(first);
      clearWorktreeCache();
      expect(getOmcRoot()).toBe(join(central, 'non-git'));
      process.chdir(second);
      clearWorktreeCache();
      expect(getOmcRoot()).toBe(join(central, 'non-git'));
    });

    it('a git repository named Downloads still uses its own repository root', () => {
      if (!gitAvailable) return;
      const repo = join(fakeHome, 'Downloads');
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      process.chdir(repo);
      clearWorktreeCache();
      expect(getOmcRoot()).toBe(join(repo, '.omc'));
    });

    it('.omc-workspace marker still wins over walk-up adoption', () => {
      const parent = join(scratch, 'ws-parent');
      const inner = join(parent, 'repo-a', 'sub');
      mkdirSync(inner, { recursive: true });
      mkdirSync(join(parent, 'repo-b', '.omc'), { recursive: true });
      writeFileSync(join(parent, '.omc-workspace'), '{}');
      const anchor = resolveNonGitStateAnchor(inner);
      expect(anchor).not.toBe(join(parent, 'repo-b', '.omc'));
      mkdirSync(join(parent, '.omc'), { recursive: true });
      clearWorktreeCache();
      expect(resolveNonGitStateAnchor(inner)).toBe(parent);
    });
  });

  describe('workingDirectory is honored (#3873)', () => {
    it('returns a provided non-git subdirectory instead of the trusted root', () => {
      const base = join(scratch, 'nogit-wd');
      const sub = join(base, 'work');
      mkdirSync(sub, { recursive: true });
      process.chdir(base);
      clearWorktreeCache();
      expect(validateWorkingDirectory(sub)).toBe(resolve(sub));
    });

    it('git sessions still normalize subdirs to the git toplevel', () => {
      if (!gitAvailable) return;
      const repo = join(scratch, 'gitrepo');
      const sub = join(repo, 'pkg');
      mkdirSync(sub, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      process.chdir(sub);
      clearWorktreeCache();
      expect(validateWorkingDirectory(sub)).toBe(resolve(repo));
    });

    it('outside the trusted root still throws', () => {
      const base = join(scratch, 'nogit-wd2');
      const outside = join(scratch, 'elsewhere');
      mkdirSync(base, { recursive: true });
      mkdirSync(outside, { recursive: true });
      process.chdir(base);
      clearWorktreeCache();
      expect(() => validateWorkingDirectory(outside)).toThrow();
    });

    it('foreign repositories are rejected instead of falling back to the startup root', () => {
      if (!gitAvailable) return;
      const first = join(scratch, 'first-repo');
      const second = join(scratch, 'second-repo');
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: first });
      execFileSync('git', ['init', '-q'], { cwd: second });
      process.chdir(first);
      clearWorktreeCache();
      expect(() => resolveStateWorkingDirectory(second)).toThrow(/different repository/);
    });
  });

  describe('end-to-end state placement', () => {
    it('creates no per-cwd state roots across nested non-git cwds', () => {
      const base = join(scratch, 'e2e');
      mkdirSync(join(base, 'one', 'two'), { recursive: true });
      process.chdir(base);
      ensureAllOmcDirs();
      const root = getOmcRoot();

      for (const dir of [join(base, 'one'), join(base, 'one', 'two')]) {
        process.chdir(dir);
        clearWorktreeCache();
        ensureAllOmcDirs();
        expect(getOmcRoot()).toBe(root);
      }
      expect(root).toBe(join(fakeHome, '.omc'));
      expect(isDir(join(base, '.omc'))).toBe(false);
      expect(isDir(join(base, 'one', '.omc'))).toBe(false);
      expect(isDir(join(base, 'one', 'two', '.omc'))).toBe(false);
    });
  });
});

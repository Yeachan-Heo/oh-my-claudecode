import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Regression tests for the state-root resolver's git-root probe. The probe
// used to spawn git and swallow ENOENT as "not a repository", silently
// degrading every hook's state root to ~/.omc when git was absent from PATH
// (observed on a real Windows host during a doctrine trial run).

// Long-path form of the temp root: mkdtempSync can inherit an 8.3 short
// name from tmpdir(), which makes exact path comparisons flaky on Windows.
const longTmp = realpathSync(tmpdir());

const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function freshGitRepo(): string {
  const dir = mkdtempSync(join(longTmp, 'omc-state-root-'));
  fixtures.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

// Force the inline-fallback path (no dist delegation) and strip git from
// PATH for the duration of the async resolution, restoring afterwards.
async function resolveWithoutGit(resolveFn: (dir: string) => Promise<string>, dir: string): Promise<string> {
  const savedPath = process.env.PATH;
  const savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const savedStateDir = process.env.OMC_STATE_DIR;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.OMC_STATE_DIR;
  process.env.PATH = '';
  try {
    return await resolveFn(dir);
  } finally {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    if (savedPluginRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
    if (savedStateDir !== undefined) process.env.OMC_STATE_DIR = savedStateDir;
  }
}

describe('state-root resolver git probe', () => {
  it('resolves a normal repo via the filesystem walk even when git is not on PATH', async () => {
    const { resolveOmcStateRoot } = await import('../../scripts/lib/state-root.mjs');
    const dir = freshGitRepo();
    const resolved = await resolveWithoutGit(resolveOmcStateRoot as (d: string) => Promise<string>, dir);
    expect(resolved).toBe(join(dir, '.omc'));
  });

  it('resolves a worktree-style .git file without spawning git', async () => {
    const { resolveOmcStateRoot } = await import('../../scripts/lib/state-root.mjs');
    const dir = mkdtempSync(join(longTmp, 'omc-state-root-wt-'));
    fixtures.push(dir);
    // linked-worktree layout: `.git` is a FILE pointing at the git dir
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/else/.git/worktrees/w1\n');
    const resolved = await resolveWithoutGit(resolveOmcStateRoot as (d: string) => Promise<string>, dir);
    expect(resolved).toBe(join(dir, '.omc'));
  });

  it('still falls back to the home anchor for genuinely non-git directories', async () => {
    const { resolveOmcStateRoot } = await import('../../scripts/lib/state-root.mjs');
    const { homedir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'omc-state-root-nogit-'));
    fixtures.push(dir);
    const resolved = await (resolveOmcStateRoot as (d: string) => Promise<string>)(dir);
    expect(resolved).toBe(join(homedir(), '.omc'));
  });

  it('keeps both mirrors behaviorally identical on a git repo', async () => {
    const script = await import('../../scripts/lib/state-root.mjs');
    const mirror = await import('../../templates/hooks/lib/state-root.mjs');
    const { realpathSync } = await import('node:fs');
    const dir = freshGitRepo();
    const a = await (script.resolveOmcStateRoot as (d: string) => Promise<string>)(dir);
    const b = await (mirror.resolveOmcStateRoot as (d: string) => Promise<string>)(dir);
    expect(b).toBe(a);
    // Anchor must be the fixture dir itself. Compare filesystem identity
    // (dev+ino) rather than path text: the git refinement returns the long
    // path form while mkdtempSync may hand back an 8.3 short name.
    const { statSync } = await import('node:fs');
    const anchor = statSync(dirname(a));
    const fixture = statSync(dir);
    expect(anchor.dev).toBe(fixture.dev);
    expect(anchor.ino).toBe(fixture.ino);
    expect(basename(a)).toBe('.omc');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decide,
  expandPrefix,
  isExternal,
  parseRepoList,
  parseWorktreeList,
  reportRepo,
  summarizeReports,
} from '../../tools/maintenance/worktree_report.mjs';

// Tests for tools/maintenance/worktree_report.mjs on throwaway git repositories (temp directory only, no network).
const SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'maintenance', 'worktree_report.mjs');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-report-')));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function makeRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'base.txt', 'base');
  return repo;
}

function addWorktree(repo: string, name: string, branch: string | null = name): string {
  const path = join(dir, `${repo.split('/').pop()}-wt-${name}`);
  if (branch) git(repo, 'worktree', 'add', '-q', '-b', branch, path);
  else git(repo, 'worktree', 'add', '-q', '--detach', path);
  return path;
}

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: opts.cwd ?? dir, env: { ...gitEnv, ...(opts.env ?? {}) } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

type Entry = { path: string; branch: string; decision: string; reason: string; class: string; [k: string]: unknown };
const byPath = (report: { worktrees: Entry[] }, path: string): Entry => {
  const w = report.worktrees.find((x) => x.path === path);
  if (!w) throw new Error(`worktree not in report: ${path}`);
  return w;
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parseWorktreeList', () => {
  it('parses branch, detached, bare, locked and prunable blocks with and without a reason', () => {
    const text = [
      'worktree /r/main', 'HEAD aaaa', 'branch refs/heads/main', '',
      'worktree /r/with space', 'HEAD bbbb', 'branch refs/heads/feature/x', 'locked', '',
      'worktree /r/locked-reason', 'HEAD cccc', 'detached', 'locked being moved', '',
      'worktree /r/gone', 'HEAD dddd', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
      'worktree /r/gone2', 'HEAD eeee', 'detached', 'prunable', '',
      'worktree /r/bare.git', 'bare', '',
    ].join('\n');
    const list = parseWorktreeList(text);
    expect(list.map((w) => w.path)).toEqual(['/r/main', '/r/with space', '/r/locked-reason', '/r/gone', '/r/gone2', '/r/bare.git']);
    expect(list[0]).toMatchObject({ head: 'aaaa', branch: 'main', locked: false, detached: false });
    expect(list[1]).toMatchObject({ branch: 'feature/x', locked: true, lockReason: '' });
    expect(list[2]).toMatchObject({ detached: true, branch: '', locked: true, lockReason: 'being moved' });
    expect(list[3]).toMatchObject({ prunable: true, pruneReason: 'gitdir file points to non-existent location' });
    expect(list[4]).toMatchObject({ prunable: true, pruneReason: '' });
    expect(list[5]).toMatchObject({ bare: true, head: '' });
  });

  it('tolerates CRLF, ignores unknown lines and drops a block without a path', () => {
    const text = 'worktree /r/a\r\nHEAD 1111\r\nbranch refs/heads/a\r\nfuture-key value\r\n\r\nHEAD 2222\r\nbranch refs/heads/nopath\r\n\r\nworktree /r/b\r\nHEAD 3333\r\ndetached\r\n';
    const list = parseWorktreeList(text);
    expect(list.map((w) => w.path)).toEqual(['/r/a', '/r/b']);
    expect(list[0].head).toBe('1111');
    expect(list[1].detached).toBe(true);
  });
});

describe('decide', () => {
  const base = { locked: false, current: false, external: false, exists: true, dirty: false, merged: true, old: false };

  it('returns the documented reason for each rule', () => {
    expect(decide({ ...base, locked: true })).toEqual({ decision: 'keep', reason: 'locked' });
    expect(decide({ ...base, current: true })).toEqual({ decision: 'keep', reason: 'current' });
    expect(decide({ ...base, external: true })).toEqual({ decision: 'keep', reason: 'external' });
    expect(decide({ ...base, exists: false })).toEqual({ decision: 'prune', reason: 'missing' });
    expect(decide({ ...base, dirty: true })).toEqual({ decision: 'keep', reason: 'dirty' });
    expect(decide({ ...base, merged: false })).toEqual({ decision: 'keep', reason: 'unmerged' });
    expect(decide({ ...base, merged: null })).toEqual({ decision: 'keep', reason: 'unmerged' });
    expect(decide(base)).toEqual({ decision: 'sweep', reason: 'merged' });
    expect(decide({ ...base, merged: false, old: true })).toEqual({ decision: 'sweep', reason: 'old_unmerged' });
    expect(decide({ ...base, merged: null, old: true })).toEqual({ decision: 'sweep', reason: 'old_unmerged' });
  });

  it('lets protections win over eligibility, in a fixed order', () => {
    expect(decide({ ...base, locked: true, current: true, external: true, exists: false, dirty: true })).toEqual({ decision: 'keep', reason: 'locked' });
    expect(decide({ ...base, locked: true, exists: false })).toEqual({ decision: 'keep', reason: 'locked' });
    expect(decide({ ...base, current: true, external: true })).toEqual({ decision: 'keep', reason: 'current' });
    expect(decide({ ...base, external: true, exists: false })).toEqual({ decision: 'keep', reason: 'external' });
    expect(decide({ ...base, dirty: true, merged: false })).toEqual({ decision: 'keep', reason: 'dirty' });
    expect(decide({ ...base, dirty: true, merged: false, old: true })).toEqual({ decision: 'keep', reason: 'dirty' });
  });
});

describe('prefix and list helpers', () => {
  it('matches a whole path segment, the prefix itself and a home shortcut', () => {
    const prefixes = [expandPrefix('/data/keep')];
    expect(isExternal('/data/keep', prefixes)).toBe(true);
    expect(isExternal('/data/keep/sub/dir', prefixes)).toBe(true);
    expect(isExternal('/data/keeper', prefixes)).toBe(false);
    expect(isExternal('/data', prefixes)).toBe(false);
    expect(expandPrefix('~')).toBe(homedir());
    expect(expandPrefix('~/work')).toBe(join(homedir(), 'work'));
    expect(isExternal(join(homedir(), 'work', 'x'), [expandPrefix('~/work')])).toBe(true);
  });

  it('reads only absolute paths from a repository list, ignoring comments and blank lines', () => {
    expect(parseRepoList('# comment\n\n/srv/a\n  /srv/b  \r\nrelative/path\n#/srv/c\n')).toEqual(['/srv/a', '/srv/b']);
  });
});

describe('reportRepo on fixture repositories', () => {
  let repo: string;
  let merged: string;
  let mergedBehind: string;
  let ahead: string;
  let diverged: string;
  let locked: string;
  let lockedReason: string;
  let missing: string;
  let lockedMissing: string;
  let dirty: string;
  let statusBroken: string;
  let detachedMerged: string;
  let old: string;
  let tagged: string;
  let extDir: string;
  let external: string;

  beforeAll(() => {
    repo = makeRepo('fixture');
    merged = addWorktree(repo, 'merged');
    detachedMerged = addWorktree(repo, 'detached', null);
    dirty = addWorktree(repo, 'dirty');
    writeFileSync(join(dirty, 'untracked.txt'), 'x\n');
    statusBroken = addWorktree(repo, 'statusbroken');
    writeFileSync(join(statusBroken, '.git'), 'gitdir: /nonexistent/place\n');
    locked = addWorktree(repo, 'locked');
    git(repo, 'worktree', 'lock', locked);
    lockedReason = addWorktree(repo, 'lockedreason');
    git(repo, 'worktree', 'lock', '--reason', 'on a usb drive', lockedReason);
    missing = addWorktree(repo, 'missing');
    rmSync(missing, { recursive: true, force: true });
    lockedMissing = addWorktree(repo, 'lockedmissing');
    git(repo, 'worktree', 'lock', lockedMissing);
    rmSync(lockedMissing, { recursive: true, force: true });
    old = addWorktree(repo, 'old');
    commit(old, 'old.txt', 'old work');
    const past = new Date(Date.now() - 10 * 86400000);
    utimesSync(old, past, past);
    mergedBehind = addWorktree(repo, 'behind');
    diverged = addWorktree(repo, 'diverged');
    commit(diverged, 'diverged.txt', 'diverged work');
    tagged = addWorktree(repo, 'tagged');
    const taggedHead = commit(tagged, 'tagged.txt', 'tagged work');
    git(repo, 'tag', 'main', taggedHead); // a tag with the name of the main branch
    commit(repo, 'main2.txt', 'main moves on'); // main is now ahead of "behind" and diverged from "diverged"
    ahead = addWorktree(repo, 'ahead'); // created after main moved on, so main is its ancestor
    commit(ahead, 'ahead.txt', 'ahead work');
    extDir = join(dir, 'external-area');
    mkdirSync(extDir, { recursive: true });
    external = join(extDir, 'ext-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'ext', external);
  });

  const report = (over: Record<string, unknown> = {}) => reportRepo(repo, { cwd: dir, ...over });

  it('classifies every worktree with its reason', () => {
    const r = report();
    expect(r.skipped).toBeUndefined();
    expect(byPath(r, repo)).toMatchObject({ decision: 'keep', reason: 'current', current: true });
    expect(byPath(r, merged)).toMatchObject({ decision: 'sweep', reason: 'merged', merged: true, class: 'merged', branch: 'merged' });
    expect(byPath(r, mergedBehind)).toMatchObject({ decision: 'sweep', reason: 'merged', class: 'merged' });
    expect(byPath(r, detachedMerged)).toMatchObject({ decision: 'sweep', reason: 'merged', detached: true, branch: '' });
    expect(byPath(r, ahead)).toMatchObject({ decision: 'keep', reason: 'unmerged', merged: false, class: 'ahead' });
    expect(byPath(r, diverged)).toMatchObject({ decision: 'keep', reason: 'unmerged', merged: false, class: 'diverged' });
    expect(byPath(r, locked)).toMatchObject({ decision: 'keep', reason: 'locked', locked: true, lock_reason: '' });
    expect(byPath(r, lockedReason)).toMatchObject({ decision: 'keep', reason: 'locked', lock_reason: 'on a usb drive' });
    expect(byPath(r, missing)).toMatchObject({ decision: 'prune', reason: 'missing', exists: false, prunable: true });
    expect(byPath(r, lockedMissing)).toMatchObject({ decision: 'keep', reason: 'locked', exists: false });
    expect(byPath(r, dirty)).toMatchObject({ decision: 'keep', reason: 'dirty', dirty: true, dirty_reason: 'changes' });
  });

  it('counts a failing status command as dirty with the reason status_failed', () => {
    const w = byPath(report(), statusBroken);
    expect(w).toMatchObject({ decision: 'keep', reason: 'dirty', dirty: true, dirty_reason: 'status_failed' });
  });

  it('counts an untracked file as dirty even when the repository hides untracked files in git status', () => {
    const hiding = makeRepo('hides-untracked');
    git(hiding, 'config', 'status.showUntrackedFiles', 'no');
    const mergedWithFile = addWorktree(hiding, 'mergedfile');
    writeFileSync(join(mergedWithFile, 'user-data.txt'), 'x\n');
    expect(git(mergedWithFile, 'status', '--porcelain'), 'the setting hides the file from plain git status').toBe('');
    const w = byPath(reportRepo(hiding, { cwd: dir }), mergedWithFile);
    expect(w).toMatchObject({ decision: 'keep', reason: 'dirty', dirty: true, dirty_reason: 'changes', merged: true });
  });

  it('uses the fully qualified main branch ref so a same-named tag does not confuse the ancestry check', () => {
    const w = byPath(report(), tagged);
    expect(w).toMatchObject({ merged: false, decision: 'keep', reason: 'unmerged', class: 'diverged' });
  });

  it('marks the worktree the tool was started from as current', () => {
    const r = report({ cwd: merged });
    expect(byPath(r, merged)).toMatchObject({ decision: 'keep', reason: 'current', current: true });
    expect(byPath(r, mergedBehind)).toMatchObject({ decision: 'sweep', current: false });
  });

  it('applies the age filter at zero, below and above the limit', () => {
    expect(byPath(report({ minAgeDays: 0 }), old)).toMatchObject({ old: false, decision: 'keep', reason: 'unmerged' });
    expect(byPath(report({ minAgeDays: 30 }), old)).toMatchObject({ old: false, decision: 'keep', reason: 'unmerged' });
    expect(byPath(report({ minAgeDays: 5 }), old)).toMatchObject({ old: true, decision: 'sweep', reason: 'old_unmerged' });
    expect(byPath(report({ minAgeDays: 5 }), merged).old).toBe(false);
  });

  it('keeps a worktree under an excluded prefix, with a home shortcut as well', () => {
    expect(byPath(report(), external)).toMatchObject({ external: false, decision: 'sweep', reason: 'merged' });
    expect(byPath(report({ exclude: [extDir] }), external)).toMatchObject({ external: true, decision: 'keep', reason: 'external' });
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      expect(byPath(report({ exclude: ['~/external-area'] }), external)).toMatchObject({ external: true, decision: 'keep', reason: 'external' });
    } finally {
      process.env.HOME = home;
    }
  });

  it('reports a repository without the main branch as skipped with a hint', () => {
    const r = reportRepo(repo, { mainBranch: 'trunk', cwd: dir });
    expect(r.skipped).toBe('no_main_branch');
    expect(r.hint).toContain('--main-branch');
    expect(r.worktrees).toEqual([]);
  });

  it('reports a path that is not a repository as skipped', () => {
    expect(reportRepo(join(dir, 'does-not-exist'), { cwd: dir }).skipped).toBe('not_a_repository');
  });

  it('summarizes the decisions', () => {
    const r = report();
    const summary = summarizeReports([r, reportRepo(repo, { mainBranch: 'trunk', cwd: dir })]);
    expect(summary.repositories).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.keep + summary.prune + summary.sweep).toBe(r.worktrees.length);
    expect(summary.prune).toBe(1);
  });

  it('does not change the repository: the same worktree list before and after the report', () => {
    const before = git(repo, 'worktree', 'list', '--porcelain');
    const branchesBefore = git(repo, 'branch', '--list');
    report();
    run(['--repo', repo]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(before);
    expect(git(repo, 'branch', '--list')).toBe(branchesBefore);
  });

  describe('command line', () => {
    it('prints a text table and a summary line, exit 0', () => {
      const r = run(['--repo', repo, '--exclude', extDir]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`== ${repo} (main branch: main)`);
      expect(r.stdout).toContain('decision | reason | branch | class | flags | path');
      expect(r.stdout).toMatch(/sweep \| merged \| merged \| merged \| - \|/);
      expect(r.stdout).toMatch(/keep \| locked \|/);
      expect(r.stdout).toMatch(/prune \| missing \|/);
      expect(r.stdout).toMatch(/summary: keep=\d+ prune=1 sweep=\d+, repositories=1, skipped=0/);
    });

    it('prints JSON with the summary', () => {
      const r = run(['--repo', repo, '--json', '--min-age-days', '5']);
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.repositories).toHaveLength(1);
      expect(parsed.summary.prune).toBe(1);
      expect(parsed.repositories[0].worktrees.find((w: Entry) => w.path === old)).toMatchObject({ decision: 'sweep', reason: 'old_unmerged' });
    });

    it('uses the repository of the current directory when none is given', () => {
      const r = run(['--json'], { cwd: merged });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).repositories[0].worktrees.find((w: Entry) => w.path === merged)).toMatchObject({ reason: 'current' });
    });

    it('reads repositories from a list file and exits 0 when one is skipped', () => {
      const other = makeRepo('other');
      const list = join(dir, 'repos.txt');
      writeFileSync(list, `# repositories\n\n${repo}\n${join(dir, 'not-a-repo')}\n${other}\nrelative-ignored\n`);
      const r = run(['--repos-file', list, '--json']);
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.summary).toMatchObject({ repositories: 3, skipped: 1 });
      expect(parsed.repositories.map((x: { skipped?: string }) => x.skipped)).toEqual([undefined, 'not_a_repository', undefined]);
    });

    it('reports a repository without the named main branch as skipped and still exits 0', () => {
      const r = run(['--repo', repo, '--main-branch', 'trunk']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('skipped (no_main_branch)');
      expect(r.stdout).toContain('--main-branch');
      expect(run(['--repo', repo, '--main-branch', 'trunk', '--json']).status).toBe(0);
    });

    it('exits 2 for a missing list file, an unknown option, a missing value and a bad age', () => {
      expect(run(['--repos-file', join(dir, 'no-such-list.txt')]).status).toBe(2);
      expect(run(['--bogus']).status).toBe(2);
      expect(run(['--repo']).status).toBe(2);
      expect(run(['--repo', repo, '--min-age-days', 'abc']).status).toBe(2);
      expect(run(['--repo', repo, '--min-age-days', '-1']).status).toBe(2);
      expect(run(['--repo', repo, '--git-timeout', '0']).status).toBe(2);
      expect(run(['--repo', repo, '--git-timeout', 'abc']).status).toBe(2);
    });

    describe('git time limit', () => {
      // a fake git first on PATH: it sleeps for the named subcommand and runs the real git for everything else
      function fakeGitBin(slowSubcommand: string): string {
        const bin = join(dir, `fake-git-${slowSubcommand}`);
        mkdirSync(bin, { recursive: true });
        const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
        writeFileSync(
          join(bin, 'git'),
          `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "${slowSubcommand}" ]; then exec sleep 30; fi\ndone\nexec "${realGit}" "$@"\n`,
        );
        chmodSync(join(bin, 'git'), 0o755);
        return bin;
      }
      const withPath = (bin: string) => ({ env: { PATH: `${bin}:${process.env.PATH}` } });

      it('skips a worktree whose status call times out and keeps the others', () => {
        const slowRepo = makeRepo('slow-status');
        const slowWorktree = addWorktree(slowRepo, 'slow');
        const r = run(['--repo', slowRepo, '--git-timeout', '1', '--json'], withPath(fakeGitBin('status')));
        expect(r.status).toBe(0);
        const parsed = JSON.parse(r.stdout);
        const entry = parsed.repositories[0].worktrees.find((w: Entry) => w.path === slowWorktree);
        expect(entry).toMatchObject({ decision: 'keep', reason: 'git_timeout', skipped: 'git_timeout' });
        expect(parsed.summary).toMatchObject({ skipped_worktrees: 2, sweep: 0, prune: 0 });
      });

      it('shows a timed out worktree in the text report', () => {
        const slowRepo = makeRepo('slow-text');
        addWorktree(slowRepo, 'slow');
        const r = run(['--repo', slowRepo, '--git-timeout', '1'], withPath(fakeGitBin('status')));
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('keep | git_timeout |');
        expect(r.stdout).toContain('skipped(git_timeout)');
        expect(r.stdout).toMatch(/skipped_worktrees=2/);
      });

      it('skips the repository when a repository-level call times out', () => {
        const slowRepo = makeRepo('slow-list');
        const r = run(['--repo', slowRepo, '--git-timeout', '1', '--json'], withPath(fakeGitBin('worktree')));
        expect(r.status).toBe(0);
        const parsed = JSON.parse(r.stdout);
        expect(parsed.repositories[0]).toMatchObject({ skipped: 'git_timeout', worktrees: [] });
        expect(parsed.summary).toMatchObject({ skipped: 1 });
      });

      it('does not mark anything skipped when git answers in time', () => {
        const fastRepo = makeRepo('fast');
        const r = run(['--repo', fastRepo, '--json']);
        expect(JSON.parse(r.stdout).summary.skipped_worktrees).toBe(0);
      });
    });

    it('prints usage for --help', () => {
      const r = run(['--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('usage: node worktree_report.mjs');
    });
  });
});

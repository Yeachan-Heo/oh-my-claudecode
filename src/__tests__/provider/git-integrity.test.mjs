/* global process, URL */
// Git integrity digest: repeatable, covers config (relevant keys), hooks and info/*, shared by worktrees.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { baselineFile, compareDigest, gitDigest, sweepBaselines, writeBaseline } = require(fileURLToPath(new URL('../../../scripts/provider/lib/git-integrity.cjs', import.meta.url)));

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

describe.skipIf(process.platform === 'win32')('git integrity digest', () => {
  let tmp;
  let repo;
  beforeAll(() => {
    tmp = makeTmp('provider-git-');
    repo = join(tmp.dir, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  });
  afterAll(() => tmp.cleanup());

  it('(24) gitDigest: repeatable, covers config (relevant keys), hooks and info/*, same from a subdirectory and from a worktree, null outside a repository; compareDigest rules and the 20-item limit', () => {
    const s1 = gitDigest(repo);
    const s2 = gitDigest(repo);
    expect(s1 && s1.digest === s2.digest).toBe(true);
    expect(s1.entries.some((w) => w[0] === 'config (relevant keys)')).toBe(true);
    expect(s1.entries.some((w) => w[0].startsWith('hooks/'))).toBe(true);
    expect(s1.entries.some((w) => w[0] === 'info/exclude')).toBe(true);
    expect(gitDigest(join(tmp.dir, 'no-such-dir'))).toBeNull();

    const sub = join(repo, 'sub');
    mkdirSync(sub);
    expect(gitDigest(sub).digest).toBe(s1.digest);

    git(repo, ['worktree', 'add', join(tmp.dir, 'wt'), '-b', 'wt-check']);
    expect(gitDigest(join(tmp.dir, 'wt')).digest).toBe(s1.digest);

    expect(compareDigest(s1, s1)).toBeNull();
    expect(compareDigest(null, null)).toBeNull();
    expect(Boolean(compareDigest(s1, null)) && Boolean(compareDigest(null, s1))).toBe(true);

    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(compareDigest(s1, gitDigest(repo))).toMatch(/added hooks\/pre-commit/);

    // A change of an unrelated config key does not count; a change of a relevant key does.
    const beforeUnrelated = gitDigest(repo);
    writeFileSync(join(repo, '.git', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'utf8')}[core]\n\trepositoryformatversion-unrelated = 1\n`, 'utf8');
    expect(compareDigest(beforeUnrelated, gitDigest(repo))).toBeNull();
    writeFileSync(join(repo, '.git', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'utf8')}[alias]\n\tx = !true\n`, 'utf8');
    expect(compareDigest(s1, gitDigest(repo))).toMatch(/changed config/);

    unlinkSync(join(repo, '.git', 'info', 'exclude'));
    expect(compareDigest(s1, gitDigest(repo))).toMatch(/removed info\/exclude/);

    const beforeMany = gitDigest(repo);
    for (let i = 0; i < 25; i += 1) writeFileSync(join(repo, '.git', 'hooks', `extra-${i}`), 'x');
    expect(compareDigest(beforeMany, gitDigest(repo))).toMatch(/\+5 more$/);
  }, 60_000);

  it('(25) housekeeping of the lead is not a change: git gc, git repack -a -d, git maintenance run, pack-refs, status and a commit leave the digest as it is (info/refs is not hashed), while a hook, a relevant config key and info/exclude still change it', () => {
    const own = join(tmp.dir, 'repo-housekeeping');
    mkdirSync(own);
    git(own, ['init', '-q']);
    git(own, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const before = gitDigest(own);
    const steps = [['status'], ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'two'], ['gc', '-q'], ['repack', '-a', '-d', '-q'], ['maintenance', 'run', '--task=gc'], ['pack-refs', '--all']];
    for (const args of steps) {
      const r = git(own, args);
      expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(0);
      expect(compareDigest(before, gitDigest(own)), args.join(' ')).toBeNull();
    }
    expect(existsSync(join(own, '.git', 'info', 'refs')), 'git wrote info/refs, so the case exercises the exclusion').toBe(true);
    expect(gitDigest(own).entries.some((w) => w[0] === 'info/refs')).toBe(false);
    writeFileSync(join(own, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(compareDigest(before, gitDigest(own))).toMatch(/added hooks\/post-commit/);
    unlinkSync(join(own, '.git', 'hooks', 'post-commit'));
    git(own, ['config', 'user.email', 'other@example.invalid']);
    expect(compareDigest(before, gitDigest(own))).toMatch(/changed config/);
    git(own, ['config', 'user.email', 'test@example.invalid']);
    git(own, ['config', '--unset', 'user.email']);
    writeFileSync(join(own, '.git', 'info', 'exclude'), '# changed\n');
    expect(compareDigest(before, gitDigest(own))).toMatch(/changed info\/exclude/);
  }, 60_000);

  it('(26) sweepBaselines removes baseline files older than the limit and the team directories that become empty, keeps fresh ones and foreign files', () => {
    const state = join(tmp.dir, 'state-sweep');
    const digest = gitDigest(repo);
    const old = baselineFile(state, 'team-old', 'worker-1');
    const fresh = baselineFile(state, 'team-fresh', 'worker-1');
    const mixed = baselineFile(state, 'team-mixed', 'worker-1');
    for (const file of [old, fresh, mixed]) expect(writeBaseline(file, repo, digest)).toBe(true);
    writeFileSync(join(state, 'git-baseline', 'team-mixed', 'notes.txt'), 'x');
    const longAgo = new Date(Date.now() - 8 * 86400_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(mixed, longAgo, longAgo);
    sweepBaselines(state);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(state, 'git-baseline', 'team-old')), 'the empty team directory goes').toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(mixed)).toBe(false);
    expect(existsSync(join(state, 'git-baseline', 'team-mixed', 'notes.txt'))).toBe(true);
    sweepBaselines(join(tmp.dir, 'no-such-state')); // a missing directory does not throw
  });
});

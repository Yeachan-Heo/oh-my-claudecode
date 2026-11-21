/* global process, URL */
// Git integrity digest: repeatable, covers config (relevant keys), hooks and info/*, shared by worktrees.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { gitDigest, compareDigest } = require(fileURLToPath(new URL('../../../scripts/provider/lib/git-integrity.cjs', import.meta.url)));

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
});

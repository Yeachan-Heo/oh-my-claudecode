import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGitDiffStats } from '../index.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('getGitDiffStats', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'omc-orchestrator-diff-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'b.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports an unstaged deletion of the first listed file as deleted', () => {
    unlinkSync(join(repo, 'a.txt'));
    writeFileSync(join(repo, 'b.txt'), 'one\nmore\n');

    const stats = getGitDiffStats(repo);

    expect(stats).toEqual([
      { path: 'a.txt', added: 0, removed: 2, status: 'deleted' },
      { path: 'b.txt', added: 1, removed: 0, status: 'modified' },
    ]);
  });

  it('reports an intent-to-add file listed first as added', () => {
    writeFileSync(join(repo, '0-new.txt'), 'fresh\n');
    git(repo, 'add', '-N', '0-new.txt');

    const stats = getGitDiffStats(repo);

    expect(stats).toEqual([
      { path: '0-new.txt', added: 1, removed: 0, status: 'added' },
    ]);
  });
});

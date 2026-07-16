import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const CLASSIFIER = join(REPO_ROOT, 'scripts', 'ci', 'check-no-committed-build-artifacts.mjs');
const CLASSIFIER_SOURCE = readFileSync(CLASSIFIER, 'utf8');
const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function commit(root: string, message: string): string {
  git(root, ['add', '-f', '-A']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omc-no-committed-artifacts-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  writeFileSync(join(root, '.gitignore'), 'dist/\nbridge/\n');
  writeFileSync(join(root, 'source.txt'), 'common\n');
  commit(root, 'common');
  return root;
}

function run(root: string, base: string, head: string) {
  return spawnSync(process.execPath, [CLASSIFIER, '--base', base, '--head', head], {
    cwd: root,
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('no committed build artifacts candidate classifier', () => {
  it('uses only Node built-ins and Git, with no approval capability', () => {
    expect(CLASSIFIER_SOURCE).toContain("import { spawnSync } from 'node:child_process'");
    expect(CLASSIFIER_SOURCE).toContain("'diff', '--name-only', '-z', '--no-renames'");
    expect(CLASSIFIER_SOURCE).toContain('never authorizes generated files');
    expect(CLASSIFIER_SOURCE).not.toMatch(/GH_TOKEN|github|npm |plugin:shipping|coordinator/);
  });
  it('allows source-only and base-only generated deltas', () => {
    const root = fixture();
    const common = git(root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'source.txt'), 'candidate\n');
    const head = commit(root, 'candidate source');
    expect(run(root, common, head).status).toBe(0);

    git(root, ['checkout', '--quiet', common]);
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'base-only.js'), 'base\n');
    const base = commit(root, 'base artifact');
    git(root, ['checkout', '--quiet', head]);
    expect(run(root, base, head).status).toBe(0);
  });

  it('holds candidate generated deltas with a control-safe path diagnostic', () => {
    const root = fixture();
    const base = git(root, ['rev-parse', 'HEAD']).trim();
    mkdirSync(join(root, 'bridge'), { recursive: true });
    writeFileSync(join(root, 'bridge', 'candidate\nname.cjs'), 'candidate\n');
    const head = commit(root, 'candidate artifact');
    const result = run(root, base, head);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OWNER_CONFIRMATION_REQUIRED: candidate generated delta: "bridge/candidate\\nname.cjs"');
  });

  it('rejects malformed, unavailable, duplicate, unknown, and mismatched head inputs', () => {
    const root = fixture();
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    expect(run(root, 'not-a-sha', head).status).toBe(1);
    expect(run(root, '0'.repeat(40), head).status).toBe(1);
    const duplicate = spawnSync(process.execPath, [CLASSIFIER, '--base', head, '--base', head, '--head', head], { cwd: root, encoding: 'utf8' });
    expect(duplicate.status).toBe(1);
    const unknown = spawnSync(process.execPath, [CLASSIFIER, '--base', head, '--head', head, '--unexpected'], { cwd: root, encoding: 'utf8' });
    expect(unknown.status).toBe(1);
    const missing = spawnSync(process.execPath, [CLASSIFIER, '--base', head], { cwd: root, encoding: 'utf8' });
    expect(missing.status).toBe(1);
    writeFileSync(join(root, 'source.txt'), 'new head\n');
    commit(root, 'different checkout');
    expect(run(root, head, head).stderr).toContain('checked-out HEAD does not match --head');
  });

  it('rejects unrelated roots and deterministic criss-cross merge bases', () => {
    const root = fixture();
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const tree = git(root, ['rev-parse', `${head}^{tree}`]).trim();
    const orphan = git(root, ['commit-tree', tree, '-m', 'orphan']).trim();
    expect(run(root, orphan, head).stderr).toContain('no common merge base');

    const a1 = git(root, ['commit-tree', tree, '-p', head, '-m', 'a1']).trim();
    const b1 = git(root, ['commit-tree', tree, '-p', head, '-m', 'b1']).trim();
    const a2 = git(root, ['commit-tree', tree, '-p', a1, '-p', b1, '-m', 'a2']).trim();
    const b2 = git(root, ['commit-tree', tree, '-p', b1, '-p', a1, '-m', 'b2']).trim();
    expect(git(root, ['merge-base', '--all', a2, b2]).trim().split(/\s+/)).toHaveLength(2);
    git(root, ['checkout', '--quiet', '--detach', b2]);
    expect(run(root, a2, b2).stderr).toContain('ambiguous merge base: expected one, found 2');
  });
});

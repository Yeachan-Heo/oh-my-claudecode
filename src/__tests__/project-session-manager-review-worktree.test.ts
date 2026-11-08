import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const WORKTREE_LIB_PATH = join(process.cwd(), 'skills', 'project-session-manager', 'lib', 'worktree.sh');
const WORKTREE_LIB = readFileSync(
  WORKTREE_LIB_PATH,
  'utf-8',
);
const PR_REVIEW_TEMPLATE = readFileSync(
  join(process.cwd(), 'skills', 'project-session-manager', 'templates', 'pr-review.md'),
  'utf-8',
);

describe('project-session-manager review worktree hardening', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('bootstraps review worktrees with best-effort dependency reuse when package.json matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-psm-review-'));
    tempDirs.push(root);

    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');
    writeFileSync(join(worktree, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');

    execFileSync(
      'bash',
      ['-lc', 'source "$SCRIPT_PATH"; psm_bootstrap_review_dependencies "$REPO_DIR" "$WORKTREE_DIR"'],
      {
        env: {
          ...process.env,
          SCRIPT_PATH: WORKTREE_LIB_PATH,
          REPO_DIR: repo,
          WORKTREE_DIR: worktree,
        },
      },
    );

    const linkedNodeModules = join(worktree, 'node_modules');
    expect(lstatSync(linkedNodeModules).isSymbolicLink()).toBe(true);
    expect(resolve(worktree, readlinkSync(linkedNodeModules))).toBe(join(repo, 'node_modules'));
    expect(WORKTREE_LIB).toContain('psm_bootstrap_review_dependencies "$local_repo" "$worktree_path"');
  });

  it('skips dependency reuse when package.json differs', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-psm-review-mismatch-'));
    tempDirs.push(root);

    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');
    writeFileSync(join(worktree, 'package.json'), '{"name":"demo","version":"2.0.0"}\n');

    execFileSync(
      'bash',
      ['-lc', 'source "$SCRIPT_PATH"; psm_bootstrap_review_dependencies "$REPO_DIR" "$WORKTREE_DIR"'],
      {
        env: {
          ...process.env,
          SCRIPT_PATH: WORKTREE_LIB_PATH,
          REPO_DIR: repo,
          WORKTREE_DIR: worktree,
        },
      },
    );

    expect(() => lstatSync(join(worktree, 'node_modules'))).toThrow();
  });

  it('guides PR review flows toward focused verification before full-suite fallback', () => {
    expect(PR_REVIEW_TEMPLATE).toContain('npm run test:run -- <changed-test-paths>');
    expect(PR_REVIEW_TEMPLATE).toContain('preferred focused verification');
    expect(PR_REVIEW_TEMPLATE).toContain('symlinked node_modules from the source repo');
  });
});

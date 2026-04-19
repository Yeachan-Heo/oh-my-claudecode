/**
 * Cross-worktree isolation: same repo + same team name + two sibling worktrees.
 *
 * Verifies that team-scoped namespaces (worktree-scope token, internal worker
 * worktree paths, branch names, metadata paths, tmux session names, ~/.claude
 * teams config dir) differ between two linked worktrees of the same git repo,
 * which prevents the cross-worktree team-mode collisions described in
 * https://github.com/Yeachan-Heo/oh-my-claudecode/issues — see
 * `.omc/prd.json:US-006`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import { getWorktreeScopeToken, SCOPE_ENV_VAR } from '../team/team-scope.js';
import {
  createWorkerWorktree,
  removeWorkerWorktree,
  cleanupTeamWorktrees,
  listTeamWorktrees,
} from '../team/git-worktree.js';
import { sessionName } from '../team/tmux-session.js';

const TEAM_NAME = 'shared-team';
const WORKER_NAME = 'worker-a';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
}

describe('team multi-worktree isolation', () => {
  let primaryRoot: string;
  let linkedRoot: string;

  beforeEach(() => {
    delete process.env[SCOPE_ENV_VAR];

    primaryRoot = mkdtempSync(join(tmpdir(), 'omc-mw-primary-'));
    gitInit(primaryRoot);

    linkedRoot = primaryRoot + '-linked';
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'feat/sibling', linkedRoot],
      { cwd: primaryRoot, stdio: 'pipe' },
    );
  });

  afterEach(() => {
    delete process.env[SCOPE_ENV_VAR];
    try { cleanupTeamWorktrees(TEAM_NAME, primaryRoot); } catch { /* ignore */ }
    try { cleanupTeamWorktrees(TEAM_NAME, linkedRoot); } catch { /* ignore */ }
    try {
      execFileSync('git', ['worktree', 'remove', '--force', linkedRoot], {
        cwd: primaryRoot, stdio: 'pipe',
      });
    } catch { /* ignore */ }
    try { rmSync(linkedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(primaryRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('produces distinct scope tokens for primary and linked worktrees', () => {
    const tokenPrimary = getWorktreeScopeToken(primaryRoot);
    const tokenLinked = getWorktreeScopeToken(linkedRoot);
    expect(tokenPrimary).toMatch(/^[0-9a-f]{8}$/);
    expect(tokenLinked).toMatch(/^[0-9a-f]{8}$/);
    expect(tokenPrimary).not.toBe(tokenLinked);
  });

  it('produces distinct tmux session names per worktree', () => {
    const sessPrimary = sessionName(TEAM_NAME, WORKER_NAME, primaryRoot);
    const sessLinked = sessionName(TEAM_NAME, WORKER_NAME, linkedRoot);
    expect(sessPrimary).not.toBe(sessLinked);
    expect(sessPrimary.startsWith('omc-team-')).toBe(true);
    expect(sessLinked.startsWith('omc-team-')).toBe(true);
  });

  it('createWorkerWorktree produces distinct branches and paths per worktree', () => {
    const wtPrimary = createWorkerWorktree(TEAM_NAME, WORKER_NAME, primaryRoot);
    const wtLinked = createWorkerWorktree(TEAM_NAME, WORKER_NAME, linkedRoot);

    // Branch names must differ — git branches are repo-shared, so collision
    // would have caused the second `git worktree add -b` to fail anyway.
    expect(wtPrimary.branch).not.toBe(wtLinked.branch);
    expect(wtPrimary.branch.startsWith('omc-team/')).toBe(true);
    expect(wtLinked.branch.startsWith('omc-team/')).toBe(true);

    // Worker worktree paths must differ
    expect(wtPrimary.path).not.toBe(wtLinked.path);
    expect(existsSync(wtPrimary.path)).toBe(true);
    expect(existsSync(wtLinked.path)).toBe(true);

    // Metadata listings must each see only their own entry
    const listPrimary = listTeamWorktrees(TEAM_NAME, primaryRoot);
    const listLinked = listTeamWorktrees(TEAM_NAME, linkedRoot);
    expect(listPrimary).toHaveLength(1);
    expect(listLinked).toHaveLength(1);
    expect(listPrimary[0].path).toBe(wtPrimary.path);
    expect(listLinked[0].path).toBe(wtLinked.path);

    // Cleanup happens in afterEach via cleanupTeamWorktrees
    removeWorkerWorktree(TEAM_NAME, WORKER_NAME, primaryRoot);
    removeWorkerWorktree(TEAM_NAME, WORKER_NAME, linkedRoot);
  });

  it('OMC_TEAM_SCOPE_TOKEN env override pins scope across cwd boundaries', () => {
    // Lead exports its token; the worker (which lives in a per-worker worktree
    // with a different cwd) must inherit the same scope so they share inbox
    // and outbox paths instead of writing to ships passing in the night.
    const leadToken = getWorktreeScopeToken(primaryRoot);
    process.env[SCOPE_ENV_VAR] = leadToken;
    try {
      const workerSeenToken = getWorktreeScopeToken(linkedRoot);
      expect(workerSeenToken).toBe(leadToken);
    } finally {
      delete process.env[SCOPE_ENV_VAR];
    }
  });
});

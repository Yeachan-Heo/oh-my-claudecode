// src/team/git-worktree.ts

/**
 * Git worktree manager for team worker isolation.
 *
 * Each MCP worker gets its own git worktree at:
 *   {repoRoot}/.omc/worktrees/{team}/{worker}
 * Branch naming: omc-team/{teamName}/{workerName}
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
import { withFileLockSync } from '../lib/file-lock.js';
import { getWorktreeScopeToken } from './team-scope.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  workerName: string;
  teamName: string;
  createdAt: string;
}

/** Get worktree path for a worker (scope-isolated for sibling worktrees) */
function getWorktreePath(repoRoot: string, teamName: string, workerName: string): string {
  const scope = getWorktreeScopeToken(repoRoot);
  return join(repoRoot, '.omc', 'worktrees', scope, sanitizeName(teamName), sanitizeName(workerName));
}

/**
 * Get git branch name for a worker.
 *
 * Git branches are shared across all linked worktrees of the same repository,
 * so the scope token is mandatory here — otherwise two sibling worktrees
 * spawning the same `<team>/<worker>` would collide on `git worktree add -b`.
 */
function getBranchName(repoRoot: string, teamName: string, workerName: string): string {
  const scope = getWorktreeScopeToken(repoRoot);
  return `omc-team/${scope}/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}

function isRegisteredWorktreePath(repoRoot: string, wtPath: string): boolean {
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const resolvedWtPath = wtPath.trim();
    for (const line of output.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      if (line.slice('worktree '.length).trim() === resolvedWtPath) {
        return true;
      }
    }
  } catch {
    // Best-effort check only.
  }
  return false;
}

/** Get worktree metadata path (scope-isolated for sibling worktrees) */
function getMetadataPath(repoRoot: string, teamName: string): string {
  const scope = getWorktreeScopeToken(repoRoot);
  return join(repoRoot, '.omc', 'state', 'team-bridge', scope, sanitizeName(teamName), 'worktrees.json');
}

/** Read worktree metadata */
function readMetadata(repoRoot: string, teamName: string): WorktreeInfo[] {
  const metaPath = getMetadataPath(repoRoot, teamName);
  if (!existsSync(metaPath)) return [];
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    // Log corruption instead of silently returning empty (which would lose all entries)
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[omc] warning: worktrees.json parse error: ${msg}\n`);
    return [];
  }
}

/** Write worktree metadata */
function writeMetadata(repoRoot: string, teamName: string, entries: WorktreeInfo[]): void {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, repoRoot);
  const scope = getWorktreeScopeToken(repoRoot);
  const dir = join(repoRoot, '.omc', 'state', 'team-bridge', scope, sanitizeName(teamName));
  ensureDirWithMode(dir);
  atomicWriteJson(metaPath, entries);
}

/**
 * Create a git worktree for a team worker.
 * Path: {repoRoot}/.omc/worktrees/{team}/{worker}
 * Branch: omc-team/{teamName}/{workerName}
 */
export function createWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string,
  baseBranch?: string
): WorktreeInfo {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(repoRoot, teamName, workerName);

  validateResolvedPath(wtPath, repoRoot);

  // Prune stale worktrees first
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* ignore */ }

  // Remove stale worktree if it exists
  if (existsSync(wtPath)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot, stdio: 'pipe' });
    } catch {
      if (isRegisteredWorktreePath(repoRoot, wtPath)) {
        throw new Error(
          `Stale worktree still registered at ${wtPath}. ` +
          `Run \`git worktree prune\` or remove it manually before retrying.`,
        );
      }
      rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Delete stale branch if it exists
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* branch doesn't exist, fine */ }

  // Create worktree directory (scope-isolated parent)
  const scope = getWorktreeScopeToken(repoRoot);
  const wtDir = join(repoRoot, '.omc', 'worktrees', scope, sanitizeName(teamName));
  ensureDirWithMode(wtDir);

  // Create worktree with new branch
  const args = ['worktree', 'add', '-b', branch, wtPath];
  if (baseBranch) args.push(baseBranch);
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });

  const info: WorktreeInfo = {
    path: wtPath,
    branch,
    workerName,
    teamName,
    createdAt: new Date().toISOString(),
  };

  // Update metadata (locked to prevent concurrent read-modify-write races)
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName);
    const updated = existing.filter(e => e.workerName !== workerName);
    updated.push(info);
    writeMetadata(repoRoot, teamName, updated);
  });

  return info;
}

/**
 * Remove a worker's worktree and branch.
 */
export function removeWorkerWorktree(
  teamName: string,
  workerName: string,
  repoRoot: string
): void {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(repoRoot, teamName, workerName);

  // Remove worktree
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* may not exist */ }

  // Prune to clean up
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* ignore */ }

  // Delete branch
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* branch may not exist */ }

  // Update metadata (locked to prevent concurrent read-modify-write races)
  const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName);
    const updated = existing.filter(e => e.workerName !== workerName);
    writeMetadata(repoRoot, teamName, updated);
  });
}

/**
 * List all worktrees for a team.
 */
export function listTeamWorktrees(
  teamName: string,
  repoRoot: string
): WorktreeInfo[] {
  return readMetadata(repoRoot, teamName);
}

/**
 * Remove all worktrees for a team (cleanup on shutdown).
 */
export function cleanupTeamWorktrees(
  teamName: string,
  repoRoot: string
): void {
  const entries = readMetadata(repoRoot, teamName);
  for (const entry of entries) {
    try {
      removeWorkerWorktree(teamName, entry.workerName, repoRoot);
    } catch { /* best effort */ }
  }
}

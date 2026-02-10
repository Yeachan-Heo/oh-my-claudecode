// src/team/git-worktree.ts

/**
 * Git worktree manager for team worker isolation.
 *
 * Each MCP worker gets its own git worktree at:
 *   {repoRoot}/.omc/worktrees/{team}/{worker}
 * Branch naming: omc-team/{teamName}/{workerName}
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  workerName: string;
  teamName: string;
  createdAt: string;
}

/** Get worktree path for a worker */
function getWorktreePath(repoRoot: string, teamName: string, workerName: string): string {
  return join(repoRoot, '.omc', 'worktrees', sanitizeName(teamName), sanitizeName(workerName));
}

/** Get branch name for a worker */
function getBranchName(teamName: string, workerName: string): string {
  return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}

/** Get worktree metadata path */
function getMetadataPath(repoRoot: string, teamName: string): string {
  return join(repoRoot, '.omc', 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}

/** Read worktree metadata */
function readMetadata(repoRoot: string, teamName: string): WorktreeInfo[] {
  const metaPath = getMetadataPath(repoRoot, teamName);
  if (!existsSync(metaPath)) return [];
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return [];
  }
}

/** Write worktree metadata */
function writeMetadata(repoRoot: string, teamName: string, entries: WorktreeInfo[]): void {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, repoRoot);
  const dir = join(repoRoot, '.omc', 'state', 'team-bridge', sanitizeName(teamName));
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
  const branch = getBranchName(teamName, workerName);

  validateResolvedPath(wtPath, repoRoot);

  // Prune stale worktrees first
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* ignore */ }

  // Remove stale worktree if it exists
  if (existsSync(wtPath)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoRoot, stdio: 'pipe' });
    } catch { /* ignore */ }
  }

  // Delete stale branch if it exists
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
  } catch { /* branch doesn't exist, fine */ }

  // Create worktree directory
  const wtDir = join(repoRoot, '.omc', 'worktrees', sanitizeName(teamName));
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

  // Update metadata
  const existing = readMetadata(repoRoot, teamName);
  const updated = existing.filter(e => e.workerName !== workerName);
  updated.push(info);
  writeMetadata(repoRoot, teamName, updated);

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
  const branch = getBranchName(teamName, workerName);

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

  // Update metadata
  const existing = readMetadata(repoRoot, teamName);
  const updated = existing.filter(e => e.workerName !== workerName);
  writeMetadata(repoRoot, teamName, updated);
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

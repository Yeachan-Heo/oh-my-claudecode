import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

export interface WorktreeRemovalSafetyOptions {
  candidatePath: string;
  expectedRoots: string[];
  mainRepoRoots?: string[];
  requireExisting?: boolean;
}

export interface WorktreeRemovalSafetyResult {
  resolvedPath: string;
  matchedRoot: string;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function assertSafeBoundary(path: string, label: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label}_empty`);
  }
  if (trimmed.includes('\0')) {
    throw new Error(`${label}_contains_nul`);
  }

  const resolved = realpathOrResolve(trimmed);
  const root = parse(resolved).root;
  const home = realpathOrResolve(homedir());
  if (resolved === root) {
    throw new Error(`${label}_is_filesystem_root:${resolved}`);
  }
  if (resolved === home) {
    throw new Error(`${label}_is_home_directory:${resolved}`);
  }
  return resolved;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Validate that a destructive cleanup target is a concrete worktree-like child
 * under one of the OMC-owned worktree roots. This is intentionally small and
 * path-focused: callers still own git/dirty-state checks, while this helper
 * fails closed for path confusion, symlinks, main repositories, and root/home
 * accidents before any recursive removal can run.
 */
export function validateWorktreeRemovalTarget(
  options: WorktreeRemovalSafetyOptions,
): WorktreeRemovalSafetyResult {
  const { candidatePath, expectedRoots, mainRepoRoots = [], requireExisting = true } = options;
  if (expectedRoots.length === 0) {
    throw new Error('expected_worktree_roots_empty');
  }

  const rawCandidate = candidatePath.trim();
  if (rawCandidate.length === 0) {
    throw new Error('worktree_path_empty');
  }
  if (rawCandidate.includes('\0')) {
    throw new Error('worktree_path_contains_nul');
  }
  if (rawCandidate === '.' || rawCandidate === '..' || rawCandidate === '~') {
    throw new Error(`worktree_path_suspicious:${rawCandidate}`);
  }

  const lexicalPath = resolve(rawCandidate);
  if (!existsSync(lexicalPath)) {
    if (requireExisting) {
      throw new Error(`worktree_path_missing:${lexicalPath}`);
    }
  } else {
    const stat = lstatSync(lexicalPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`worktree_path_is_symlink:${lexicalPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`worktree_path_not_directory:${lexicalPath}`);
    }
  }

  const resolvedPath = assertSafeBoundary(candidatePath, 'worktree_path');

  const matchedRoot = expectedRoots
    .map(root => assertSafeBoundary(root, 'worktree_root'))
    .find(root => isInside(root, resolvedPath));

  if (!matchedRoot) {
    throw new Error(`worktree_path_outside_expected_roots:${resolvedPath}`);
  }

  for (const repoRoot of mainRepoRoots) {
    if (repoRoot.trim().length === 0) continue;
    const resolvedRepoRoot = realpathOrResolve(repoRoot);
    if (resolvedPath === resolvedRepoRoot) {
      throw new Error(`worktree_path_is_main_repo:${resolvedPath}`);
    }
  }

  if (existsSync(join(resolvedPath, '.git'))) {
    const gitStat = lstatSync(join(resolvedPath, '.git'));
    if (gitStat.isDirectory()) {
      throw new Error(`worktree_path_is_main_repo:${resolvedPath}`);
    }
  }

  return { resolvedPath, matchedRoot };
}

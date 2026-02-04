/**
 * Worktree Path Enforcement
 *
 * Provides strict path validation and resolution for .omc/ paths,
 * ensuring all operations stay within the worktree boundary.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve, normalize, relative, sep, join } from 'path';

/** Standard .omc subdirectories */
export const OmcPaths = {
  ROOT: '.omc',
  STATE: '.omc/state',
  PLANS: '.omc/plans',
  RESEARCH: '.omc/research',
  NOTEPAD: '.omc/notepad.md',
  PROJECT_MEMORY: '.omc/project-memory.json',
} as const;

/** Cache for worktree root to avoid repeated git calls */
let worktreeCache: { cwd: string; root: string } | null = null;

/**
 * Get the git worktree root for the current or specified directory.
 * Returns null if not in a git repository.
 */
export function getWorktreeRoot(cwd?: string): string | null {
  const effectiveCwd = cwd || process.cwd();

  // Return cached value if cwd matches
  if (worktreeCache && worktreeCache.cwd === effectiveCwd) {
    return worktreeCache.root;
  }

  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    worktreeCache = { cwd: effectiveCwd, root };
    return root;
  } catch {
    // Not in a git repository, use cwd as fallback
    return effectiveCwd;
  }
}

/**
 * Validate that a path is safe (no traversal attacks).
 *
 * @throws Error if path contains traversal sequences
 */
export function validatePath(inputPath: string): void {
  // Reject explicit path traversal
  if (inputPath.includes('..')) {
    throw new Error(`Invalid path: path traversal not allowed (${inputPath})`);
  }

  // Reject absolute paths that don't start with worktree
  if (inputPath.startsWith('/') || inputPath.startsWith('~')) {
    throw new Error(`Invalid path: absolute paths not allowed (${inputPath})`);
  }
}

/**
 * Resolve a relative path under .omc/ to an absolute path.
 * Validates the path is within the worktree boundary.
 *
 * @param relativePath - Path relative to .omc/ (e.g., "state/ralph.json")
 * @param worktreeRoot - Optional worktree root (auto-detected if not provided)
 * @returns Absolute path
 * @throws Error if path would escape worktree
 */
export function resolveOmcPath(relativePath: string, worktreeRoot?: string): string {
  validatePath(relativePath);

  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  const omcDir = join(root, OmcPaths.ROOT);
  const fullPath = normalize(resolve(omcDir, relativePath));

  // Verify resolved path is still under worktree
  const relativeToRoot = relative(root, fullPath);
  if (relativeToRoot.startsWith('..') || relativeToRoot.startsWith(sep + '..')) {
    throw new Error(`Path escapes worktree boundary: ${relativePath}`);
  }

  return fullPath;
}

/**
 * Resolve a state file path.
 *
 * State files follow the naming convention: {mode}-state.json
 * Examples: ralph-state.json, ultrawork-state.json, autopilot-state.json
 *
 * Special case: swarm uses swarm.db (SQLite), not swarm-state.json.
 * This function is for JSON state files only. For swarm, use getStateFilePath from mode-registry.
 *
 * @param stateName - State name (e.g., "ralph", "ultrawork", or "ralph-state")
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to state file
 */
export function resolveStatePath(stateName: string, worktreeRoot?: string): string {
  // Special case: swarm uses swarm.db, not swarm-state.json
  if (stateName === 'swarm' || stateName === 'swarm-state') {
    throw new Error('Swarm uses SQLite (swarm.db), not JSON state. Use getStateFilePath from mode-registry instead.');
  }

  // Normalize: ensure -state suffix is present, then add .json
  const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
  return resolveOmcPath(`state/${normalizedName}.json`, worktreeRoot);
}

/**
 * Ensure a directory exists under .omc/.
 * Creates parent directories as needed.
 *
 * @param relativePath - Path relative to .omc/
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the created directory
 */
export function ensureOmcDir(relativePath: string, worktreeRoot?: string): string {
  const fullPath = resolveOmcPath(relativePath, worktreeRoot);

  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }

  return fullPath;
}

/**
 * Get the absolute path to the notepad file.
 * NOTE: Named differently from hooks/notepad/getNotepadPath which takes `directory` (required).
 * This version auto-detects worktree root.
 */
export function getWorktreeNotepadPath(worktreeRoot?: string): string {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, OmcPaths.NOTEPAD);
}

/**
 * Get the absolute path to the project memory file.
 */
export function getWorktreeProjectMemoryPath(worktreeRoot?: string): string {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, OmcPaths.PROJECT_MEMORY);
}

/**
 * Get the .omc root directory path.
 */
export function getOmcRoot(worktreeRoot?: string): string {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, OmcPaths.ROOT);
}

/**
 * Resolve a plan file path.
 * @param planName - Plan name (without .md extension)
 */
export function resolvePlanPath(planName: string, worktreeRoot?: string): string {
  validatePath(planName);
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, OmcPaths.PLANS, `${planName}.md`);
}

/**
 * Resolve a research directory path.
 * @param name - Research folder name
 */
export function resolveResearchPath(name: string, worktreeRoot?: string): string {
  validatePath(name);
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, OmcPaths.RESEARCH, name);
}

/**
 * Resolve the logs directory path.
 */
export function resolveLogsPath(worktreeRoot?: string): string {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, '.omc', 'logs');
}

/**
 * Resolve a wisdom/plan-scoped notepad directory path.
 * @param planName - Plan name for the scoped notepad
 */
export function resolveWisdomPath(planName: string, worktreeRoot?: string): string {
  validatePath(planName);
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, '.omc', 'notepads', planName);
}

/**
 * Check if an absolute path is under the .omc directory.
 * @param absolutePath - Absolute path to check
 */
export function isPathUnderOmc(absolutePath: string, worktreeRoot?: string): boolean {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  const omcRoot = join(root, OmcPaths.ROOT);
  const normalizedPath = normalize(absolutePath);
  const normalizedOmc = normalize(omcRoot);
  return normalizedPath.startsWith(normalizedOmc + sep) || normalizedPath === normalizedOmc;
}

/**
 * Ensure all standard .omc subdirectories exist.
 */
export function ensureAllOmcDirs(worktreeRoot?: string): void {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  const dirs = [
    OmcPaths.ROOT,
    OmcPaths.STATE,
    OmcPaths.PLANS,
    OmcPaths.RESEARCH,
    join('.omc', 'logs'),
    join('.omc', 'notepads'),
    join('.omc', 'drafts'),
  ];
  for (const dir of dirs) {
    const fullPath = join(root, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }
}

/**
 * Clear the worktree cache (useful for testing).
 */
export function clearWorktreeCache(): void {
  worktreeCache = null;
}

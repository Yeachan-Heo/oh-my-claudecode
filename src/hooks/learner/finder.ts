/**
 * Skill Finder
 *
 * Discovers skill files using hybrid search (user + project).
 * Project skills override user skills with same ID.
 */

import { existsSync, readdirSync, realpathSync, mkdirSync } from 'fs';
import { join, normalize, sep } from 'path';
import { USER_SKILLS_DIR, PROJECT_SKILLS_SUBDIR, PROJECT_AGENT_SKILLS_SUBDIR, SKILL_EXTENSION, DEBUG_ENABLED, GLOBAL_SKILLS_DIR, MAX_RECURSION_DEPTH } from './constants.js';
import type { SkillFileCandidate } from './types.js';

/**
 * Recursively find all skill files in a directory.
 */
function findSkillFilesRecursive(dir: string, results: string[], depth: number = 0): void {
  if (!existsSync(dir)) return;
  if (depth > MAX_RECURSION_DEPTH) return;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        findSkillFilesRecursive(fullPath, results, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(SKILL_EXTENSION)) {
        results.push(fullPath);
      }
    }
  } catch (error) {
    if (DEBUG_ENABLED) {
      console.error('[learner] Error scanning directory:', error);
    }
  }
}

/**
 * Resolve symlinks safely with fallback.
 */
function safeRealpathSync(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Check if a resolved path is within a boundary directory.
 * Used to prevent symlink escapes.
 */
function isWithinBoundary(realPath: string, boundary: string): boolean {
  const normalizedReal = normalize(realPath);
  const normalizedBoundary = normalize(safeRealpathSync(boundary));
  return normalizedReal === normalizedBoundary ||
         normalizedReal.startsWith(normalizedBoundary + sep);
}

/**
 * Find all skill files for a given project.
 * Returns project skills first (higher priority), then user skills.
 */
export function findSkillFiles(
  projectRoot: string | null,
  options?: { scope?: 'project' | 'user' | 'all' }
): SkillFileCandidate[] {
  const candidates: SkillFileCandidate[] = [];
  const seenRealPaths = new Set<string>();
  const scope = options?.scope ?? 'all';

  // 1. Search project-level skills (if scope allows)
  if (projectRoot && (scope === 'project' || scope === 'all')) {
    const projectSkillDirs = [
      join(projectRoot, PROJECT_SKILLS_SUBDIR),
      join(projectRoot, PROJECT_AGENT_SKILLS_SUBDIR),
    ];

    for (const projectSkillsDir of projectSkillDirs) {
      const projectFiles: string[] = [];
      findSkillFilesRecursive(projectSkillsDir, projectFiles);

      for (const filePath of projectFiles) {
        const realPath = safeRealpathSync(filePath);
        if (seenRealPaths.has(realPath)) continue;
        // Symlink boundary check
        if (!isWithinBoundary(realPath, projectSkillsDir)) {
          if (DEBUG_ENABLED) {
            console.warn('[learner] Symlink escape blocked:', filePath);
          }
          continue;
        }
        seenRealPaths.add(realPath);

        candidates.push({
          path: filePath,
          realPath,
          scope: 'project',
          sourceDir: projectSkillsDir,
        });
      }
    }
  }

  // 2. Search user-level skills from both directories (if scope allows)
  if (scope === 'user' || scope === 'all') {
    const userDirs = [GLOBAL_SKILLS_DIR, USER_SKILLS_DIR];

    for (const userDir of userDirs) {
      const userFiles: string[] = [];
      findSkillFilesRecursive(userDir, userFiles);

      for (const filePath of userFiles) {
        const realPath = safeRealpathSync(filePath);
        if (seenRealPaths.has(realPath)) continue;
        // Symlink boundary check
        if (!isWithinBoundary(realPath, userDir)) {
          if (DEBUG_ENABLED) {
            console.warn('[learner] Symlink escape blocked:', filePath);
          }
          continue;
        }
        seenRealPaths.add(realPath);

        candidates.push({
          path: filePath,
          realPath,
          scope: 'user',
          sourceDir: userDir,
        });
      }
    }
  }

  return candidates;
}

/**
 * Get skills directory path for a scope.
 */
export function getSkillsDir(scope: 'user' | 'project', projectRoot?: string, sourceDir?: string): string {
  if (sourceDir) return sourceDir;
  if (scope === 'user') {
    return USER_SKILLS_DIR;
  }
  if (!projectRoot) {
    throw new Error('Project root is required for project-scoped skills');
  }
  return join(projectRoot, PROJECT_SKILLS_SUBDIR);
}

/**
 * Ensure skills directory exists.
 */
export function ensureSkillsDir(scope: 'user' | 'project', projectRoot?: string): boolean {
  const dir = getSkillsDir(scope, projectRoot);

  if (existsSync(dir)) {
    return true;
  }

  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch (error) {
    if (DEBUG_ENABLED) {
      console.error('[learner] Error creating skills directory:', error);
    }
    return false;
  }
}

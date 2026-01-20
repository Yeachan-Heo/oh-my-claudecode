/**
 * Skill Finder
 *
 * Discovers skill files using hybrid search (user + project).
 * Project skills override user skills with same ID.
 */

import { existsSync, readdirSync, realpathSync, mkdirSync } from 'fs';
import { join } from 'path';
import { USER_SKILLS_DIR, PROJECT_SKILLS_SUBDIR, SKILL_EXTENSION, DEBUG_ENABLED } from './constants.js';
import type { SkillFileCandidate } from './types.js';

/**
 * Recursively find all skill files in a directory.
 */
function findSkillFilesRecursive(dir: string, results: string[]): void {
  if (!existsSync(dir)) return;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        findSkillFilesRecursive(fullPath, results);
      } else if (entry.isFile() && entry.name.endsWith(SKILL_EXTENSION)) {
        results.push(fullPath);
      }
    }
  } catch (error) {
    // Permission denied or other errors - silently skip
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
 * Find all skill files for a given project.
 * Returns project skills first (higher priority), then user skills.
 */
export function findSkillFiles(projectRoot: string | null): SkillFileCandidate[] {
  const candidates: SkillFileCandidate[] = [];
  const seenRealPaths = new Set<string>();

  // 1. Search project-level skills (higher priority)
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_SKILLS_SUBDIR);
    const projectFiles: string[] = [];
    findSkillFilesRecursive(projectSkillsDir, projectFiles);

    for (const filePath of projectFiles) {
      const realPath = safeRealpathSync(filePath);
      if (seenRealPaths.has(realPath)) continue;
      seenRealPaths.add(realPath);

      candidates.push({
        path: filePath,
        realPath,
        scope: 'project',
      });
    }
  }

  // 2. Search user-level skills (lower priority)
  const userFiles: string[] = [];
  findSkillFilesRecursive(USER_SKILLS_DIR, userFiles);

  for (const filePath of userFiles) {
    const realPath = safeRealpathSync(filePath);
    if (seenRealPaths.has(realPath)) continue;
    seenRealPaths.add(realPath);

    candidates.push({
      path: filePath,
      realPath,
      scope: 'user',
    });
  }

  return candidates;
}

/**
 * Get skills directory path for a scope.
 */
export function getSkillsDir(scope: 'user' | 'project', projectRoot?: string): string {
  if (scope === 'user') {
    return USER_SKILLS_DIR;
  }
  if (!projectRoot) {
    throw new Error('Project root required for project scope');
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

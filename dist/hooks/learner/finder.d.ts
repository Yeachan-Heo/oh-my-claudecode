/**
 * Skill Finder
 *
 * Discovers skill files using hybrid search (user + project).
 * Project skills override user skills with same ID.
 */
import type { SkillFileCandidate } from './types.js';
/**
 * Find all skill files for a given project.
 * Returns project skills first (higher priority), then user skills.
 */
export declare function findSkillFiles(projectRoot: string | null, options?: {
    scope?: 'project' | 'user' | 'all';
}): SkillFileCandidate[];
/**
 * Get skills directory path for a scope.
 */
export declare function getSkillsDir(scope: 'user' | 'project', projectRoot?: string, sourceDir?: string): string;
/**
 * Ensure skills directory exists.
 */
export declare function ensureSkillsDir(scope: 'user' | 'project', projectRoot?: string): boolean;
//# sourceMappingURL=finder.d.ts.map
/**
 * Skill Loader
 *
 * Loads and caches skills from disk.
 */
import type { LearnedSkill } from './types.js';
/**
 * Load all skills for a project.
 * Project skills override user skills with same ID.
 */
export declare function loadAllSkills(projectRoot: string | null): LearnedSkill[];
/**
 * Load a specific skill by ID.
 */
export declare function loadSkillById(skillId: string, projectRoot: string | null): LearnedSkill | null;
/**
 * Find skills matching keywords in user message.
 */
export declare function findMatchingSkills(message: string, projectRoot: string | null, limit?: number): LearnedSkill[];
//# sourceMappingURL=loader.d.ts.map
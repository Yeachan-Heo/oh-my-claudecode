/**
 * Builtin Skills Definitions
 *
 * Loads skills from bundled SKILL.md files in the skills directory.
 * This provides a single source of truth for skill definitions.
 *
 * Skills are loaded from project_root/skills/SKILLNAME/SKILL.md
 *
 * Adapted from oh-my-opencode's builtin-skills feature.
 */
import type { BuiltinSkill } from './types.js';
/**
 * Get all builtin skills
 *
 * Skills are loaded from bundled SKILL.md files in the skills/ directory.
 * Results are cached after first load.
 */
export declare function createBuiltinSkills(): BuiltinSkill[];
/**
 * Get a skill by name
 */
export declare function getBuiltinSkill(name: string): BuiltinSkill | undefined;
export interface ListBuiltinSkillNamesOptions {
    includeAliases?: boolean;
}
/**
 * List all builtin skill names
 */
export declare function listBuiltinSkillNames(options?: ListBuiltinSkillNamesOptions): string[];
/**
 * Clear the skills cache (useful for testing)
 */
export declare function clearSkillsCache(): void;
/**
 * Get the skills directory path (useful for debugging)
 */
export declare function getSkillsDir(): string;
//# sourceMappingURL=skills.d.ts.map
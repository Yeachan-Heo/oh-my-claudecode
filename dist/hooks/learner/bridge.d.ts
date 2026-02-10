/**
 * Skill Bridge Module
 *
 * Exports a focused API for skill-injector.mjs to use via esbuild bundle.
 * This module bridges the TypeScript learner infrastructure with the standalone hook script.
 *
 * Bundled to: dist/hooks/skill-bridge.cjs
 * Usage: const bridge = require('../dist/hooks/skill-bridge.cjs');
 */
export declare const USER_SKILLS_DIR: string;
export declare const GLOBAL_SKILLS_DIR: string;
export declare const PROJECT_SKILLS_SUBDIR: ".omc/skills";
export declare const SKILL_EXTENSION = ".md";
/**
 * Clear skill metadata cache (for testing).
 */
export declare function clearSkillMetadataCache(): void;
/**
 * Clear Levenshtein cache (for testing).
 */
export declare function clearLevenshteinCache(): void;
export interface SkillFileCandidate {
    path: string;
    realPath: string;
    scope: "user" | "project";
    /** The root directory this skill was found in */
    sourceDir: string;
}
export interface ParseResult {
    metadata: {
        id?: string;
        name?: string;
        description?: string;
        triggers?: string[];
        tags?: string[];
        matching?: "exact" | "fuzzy";
        model?: string;
        agent?: string;
    };
    content: string;
    valid: boolean;
    errors: string[];
}
export interface MatchedSkill {
    path: string;
    name: string;
    content: string;
    score: number;
    scope: "user" | "project";
    triggers: string[];
    matching?: "exact" | "fuzzy";
}
/**
 * Get paths of skills already injected in this session.
 */
export declare function getInjectedSkillPaths(sessionId: string, projectRoot: string): string[];
/**
 * Mark skills as injected for this session.
 */
export declare function markSkillsInjected(sessionId: string, paths: string[], projectRoot: string): void;
/**
 * Find all skill files for a given project.
 * Returns project skills first (higher priority), then user skills.
 * Now supports RECURSIVE discovery (subdirectories included).
 */
export declare function findSkillFiles(projectRoot: string, options?: {
    scope?: "project" | "user" | "all";
}): SkillFileCandidate[];
/**
 * Parse YAML frontmatter and content from a skill file.
 */
export declare function parseSkillFile(content: string): ParseResult | null;
/**
 * Find matching skills for injection based on prompt triggers.
 *
 * Options:
 * - fuzzyThreshold: minimum score for fuzzy match (default: 60)
 * - maxResults: maximum skills to return (default: 5)
 */
export declare function matchSkillsForInjection(prompt: string, projectRoot: string, sessionId: string, options?: {
    fuzzyThreshold?: number;
    maxResults?: number;
}): MatchedSkill[];
//# sourceMappingURL=bridge.d.ts.map
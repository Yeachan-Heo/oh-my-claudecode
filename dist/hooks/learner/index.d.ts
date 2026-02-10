/**
 * Learned Skills Hook
 *
 * Automatically injects relevant learned skills into context
 * based on message content triggers.
 */
import type { LearnedSkill } from './types.js';
export * from './types.js';
export * from './constants.js';
export * from './finder.js';
export * from './parser.js';
export * from './loader.js';
export * from './validator.js';
export * from './writer.js';
export * from './detector.js';
export * from './detection-hook.js';
export * from './promotion.js';
export * from './config.js';
export * from './matcher.js';
export * from './auto-invoke.js';
export { type PatternDetection, type AutoLearnerState, initAutoLearner, calculateSkillWorthiness, extractTriggers, getSuggestedSkills, patternToSkillMetadata, recordPattern as recordSkillPattern, } from './auto-learner.js';
/**
 * Check if feature is enabled.
 */
export declare function isLearnerEnabled(): boolean;
/**
 * Process a user message and inject matching skills.
 */
export declare function processMessageForSkills(message: string, sessionId: string, projectRoot: string | null): {
    injected: number;
    skills: LearnedSkill[];
};
/**
 * Clear session cache.
 */
export declare function clearSkillSession(sessionId: string): void;
/**
 * Get all loaded skills (for debugging/display).
 */
export declare function getAllSkills(projectRoot: string | null): LearnedSkill[];
/**
 * Create the learned skills hook for Claude Code.
 */
export declare function createLearnedSkillsHook(projectRoot: string | null): {
    /**
     * Process user message for skill injection.
     */
    processMessage: (message: string, sessionId: string) => {
        injected: number;
        skills: LearnedSkill[];
    };
    /**
     * Clear session when done.
     */
    clearSession: (sessionId: string) => void;
    /**
     * Get all skills for display.
     */
    getAllSkills: () => LearnedSkill[];
    /**
     * Check if feature enabled.
     */
    isEnabled: typeof isLearnerEnabled;
};
//# sourceMappingURL=index.d.ts.map
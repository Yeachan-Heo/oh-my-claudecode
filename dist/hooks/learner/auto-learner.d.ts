/**
 * Auto-Learner Module
 *
 * Automatically detects skill-worthy patterns during work sessions.
 * Tracks problem-solution pairs and suggests skill extraction.
 */
import type { SkillMetadata } from "./types.js";
/**
 * Detected pattern that could become a skill.
 */
export interface PatternDetection {
    id: string;
    problem: string;
    solution: string;
    confidence: number;
    occurrences: number;
    firstSeen: number;
    lastSeen: number;
    suggestedTriggers: string[];
    suggestedTags: string[];
}
/**
 * Auto-learner session state.
 */
export interface AutoLearnerState {
    sessionId: string;
    patterns: Map<string, PatternDetection>;
    suggestedSkills: PatternDetection[];
}
/**
 * Initialize state for a session.
 */
export declare function initAutoLearner(sessionId: string): AutoLearnerState;
/**
 * Extract triggers from problem and solution text.
 */
export declare function extractTriggers(problem: string, solution: string): string[];
/**
 * Calculate skill-worthiness score (0-100).
 */
export declare function calculateSkillWorthiness(pattern: PatternDetection): number;
/**
 * Record a problem-solution pair.
 * Returns the pattern if it's new or updated, null if ignored.
 */
export declare function recordPattern(state: AutoLearnerState, problem: string, solution: string): PatternDetection | null;
/**
 * Get ready-to-suggest skills (confidence above threshold).
 */
export declare function getSuggestedSkills(state: AutoLearnerState, threshold?: number): PatternDetection[];
/**
 * Convert pattern to skill metadata (partial).
 */
export declare function patternToSkillMetadata(pattern: PatternDetection): Partial<SkillMetadata>;
//# sourceMappingURL=auto-learner.d.ts.map
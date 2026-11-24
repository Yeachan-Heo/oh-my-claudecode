/**
 * Ralph-Progress Promotion
 *
 * Promotes learnings from ralph-progress to full skills.
 */
import type { WriteSkillResult } from './writer.js';
export interface PromotionCandidate {
    /** The learning text */
    learning: string;
    /** Story ID it came from */
    storyId: string;
    /** Timestamp */
    timestamp: string;
    /** Suggested triggers (extracted from text) */
    suggestedTriggers: string[];
}
/**
 * Get promotion candidates from ralph-progress learnings.
 */
export declare function getPromotionCandidates(directory: string, limit?: number): PromotionCandidate[];
/**
 * Promote a learning to a full skill.
 */
export declare function promoteLearning(candidate: PromotionCandidate, skillName: string, additionalTriggers: string[], targetScope: 'user' | 'project', projectRoot: string | null): WriteSkillResult;
/**
 * List learnings that could be promoted.
 */
export declare function listPromotableLearnings(directory: string): string;
//# sourceMappingURL=promotion.d.ts.map
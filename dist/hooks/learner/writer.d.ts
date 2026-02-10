/**
 * Skill Writer
 *
 * Writes skill files to disk with proper formatting.
 */
import type { SkillExtractionRequest, QualityValidation } from './types.js';
/**
 * Result of skill writing operation.
 */
export interface WriteSkillResult {
    success: boolean;
    path?: string;
    error?: string;
    validation: QualityValidation;
}
/**
 * Write a new skill from extraction request.
 */
export declare function writeSkill(request: SkillExtractionRequest, projectRoot: string | null, skillName: string): WriteSkillResult;
/**
 * Check if a skill with similar triggers already exists.
 */
export declare function checkDuplicateTriggers(triggers: string[], projectRoot: string | null): {
    isDuplicate: boolean;
    existingSkillId?: string;
};
//# sourceMappingURL=writer.d.ts.map
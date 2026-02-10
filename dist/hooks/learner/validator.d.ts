/**
 * Skill Quality Validator
 *
 * Validates skill extraction requests against quality gates.
 */
import type { SkillExtractionRequest, QualityValidation, SkillMetadata } from './types.js';
/**
 * Validate a skill extraction request.
 */
export declare function validateExtractionRequest(request: SkillExtractionRequest): QualityValidation;
/**
 * Validate existing skill metadata.
 */
export declare function validateSkillMetadata(metadata: Partial<SkillMetadata>): QualityValidation;
//# sourceMappingURL=validator.d.ts.map
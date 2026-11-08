/**
 * Skill Quality Validator
 *
 * Validates skill extraction requests against quality gates.
 */

import { REQUIRED_METADATA_FIELDS, MIN_QUALITY_SCORE, MAX_SKILL_CONTENT_LENGTH } from './constants.js';
import type { SkillExtractionRequest, QualityValidation, SkillMetadata } from './types.js';

/**
 * Validate a skill extraction request.
 */
export function validateExtractionRequest(request: SkillExtractionRequest): QualityValidation {
  const missingFields: string[] = [];
  const warnings: string[] = [];
  let score = 100;

  // Check required fields
  if (!request.problem || request.problem.trim().length < 10) {
    missingFields.push('problem (minimum 10 characters)');
    score -= 30;
  }

  if (!request.solution || request.solution.trim().length < 20) {
    missingFields.push('solution (minimum 20 characters)');
    score -= 30;
  }

  if (!request.triggers || request.triggers.length === 0) {
    missingFields.push('triggers (at least one required)');
    score -= 20;
  }

  // Check content length
  const totalLength = (request.problem?.length || 0) + (request.solution?.length || 0);
  if (totalLength > MAX_SKILL_CONTENT_LENGTH) {
    warnings.push(`Content exceeds ${MAX_SKILL_CONTENT_LENGTH} chars (${totalLength}). Consider condensing.`);
    score -= 10;
  }

  // Check trigger quality
  if (request.triggers) {
    const shortTriggers = request.triggers.filter(t => t.length < 3);
    if (shortTriggers.length > 0) {
      warnings.push(`Short triggers may cause false matches: ${shortTriggers.join(', ')}`);
      score -= 5;
    }

    const genericTriggers = ['the', 'a', 'an', 'this', 'that', 'it', 'is', 'are'];
    const foundGeneric = request.triggers.filter(t => genericTriggers.includes(t.toLowerCase()));
    if (foundGeneric.length > 0) {
      warnings.push(`Generic triggers should be avoided: ${foundGeneric.join(', ')}`);
      score -= 10;
    }
  }

  // Ensure score doesn't go negative
  score = Math.max(0, score);

  return {
    valid: missingFields.length === 0 && score >= MIN_QUALITY_SCORE,
    missingFields,
    warnings,
    score,
  };
}

/**
 * Validate existing skill metadata.
 */
export function validateSkillMetadata(metadata: Partial<SkillMetadata>): QualityValidation {
  const missingFields: string[] = [];
  const warnings: string[] = [];
  let score = 100;

  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!metadata[field as keyof SkillMetadata]) {
      missingFields.push(field);
      score -= 15;
    }
  }

  // Check triggers array
  if (metadata.triggers && metadata.triggers.length === 0) {
    missingFields.push('triggers (empty array)');
    score -= 20;
  }

  // Check source value
  if (metadata.source && !['extracted', 'promoted', 'manual'].includes(metadata.source)) {
    warnings.push(`Invalid source value: ${metadata.source}`);
    score -= 10;
  }

  score = Math.max(0, score);

  return {
    valid: missingFields.length === 0 && score >= MIN_QUALITY_SCORE,
    missingFields,
    warnings,
    score,
  };
}

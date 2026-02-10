/**
 * Delegation Prompt Validator
 *
 * Validates delegation prompts to ensure they are comprehensive and well-structured.
 */
export interface ValidationResult {
    valid: boolean;
    warnings: string[];
}
/**
 * Validate a delegation prompt for completeness and structure
 *
 * @param prompt The delegation prompt to validate
 * @returns Validation result with warnings if any
 */
export declare function validateDelegationPrompt(prompt: string): ValidationResult;
/**
 * Validate that a delegation prompt has all 7 recommended sections
 *
 * @param prompt The delegation prompt to validate
 * @returns True if all sections are present
 */
export declare function hasAllSections(prompt: string): boolean;
/**
 * Get missing sections from a delegation prompt
 *
 * @param prompt The delegation prompt to check
 * @returns Array of missing section names
 */
export declare function getMissingSections(prompt: string): string[];
//# sourceMappingURL=delegation-validator.d.ts.map
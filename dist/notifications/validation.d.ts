/**
 * Custom Integration Validation
 *
 * Validates custom integration configurations for security and correctness.
 */
import type { CustomIntegration } from './types.js';
export interface ValidationResult {
    valid: boolean;
    errors: string[];
}
/**
 * Validate a custom integration configuration.
 */
export declare function validateCustomIntegration(integration: CustomIntegration): ValidationResult;
/**
 * Check for duplicate integration IDs in a list.
 */
export declare function checkDuplicateIds(integrations: CustomIntegration[]): string[];
/**
 * Sanitize a command argument to prevent injection.
 * This is a defensive measure - the primary defense is using execFile.
 */
export declare function sanitizeArgument(arg: string): string;
//# sourceMappingURL=validation.d.ts.map
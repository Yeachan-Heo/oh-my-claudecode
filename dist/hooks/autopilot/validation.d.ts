/**
 * Autopilot Validation & Summary
 *
 * Coordinates parallel validation architects for Phase 4.
 * Aggregates verdicts and determines if autopilot can complete.
 * Also generates human-readable summaries when autopilot completes.
 */
import type { AutopilotState, AutopilotSummary, ValidationResult, ValidationVerdictType, ValidationVerdict } from './types.js';
/** Number of architects required for validation consensus */
export declare const REQUIRED_ARCHITECTS = 3;
export interface ValidationCoordinatorResult {
    success: boolean;
    allApproved: boolean;
    verdicts: ValidationResult[];
    round: number;
    issues: string[];
}
/**
 * Record a validation verdict from an architect
 */
export declare function recordValidationVerdict(directory: string, type: ValidationVerdictType, verdict: ValidationVerdict, issues?: string[], sessionId?: string): boolean;
/**
 * Get validation status
 */
export declare function getValidationStatus(directory: string, sessionId?: string): ValidationCoordinatorResult | null;
/**
 * Start a new validation round
 */
export declare function startValidationRound(directory: string, sessionId?: string): boolean;
/**
 * Check if validation should retry
 */
export declare function shouldRetryValidation(directory: string, maxRounds?: number, sessionId?: string): boolean;
/**
 * Get issues that need fixing before retry
 */
export declare function getIssuesToFix(directory: string, sessionId?: string): string[];
/**
 * Generate the validation spawn prompt
 */
export declare function getValidationSpawnPrompt(specPath: string): string;
/**
 * Format validation results for display
 */
export declare function formatValidationResults(state: AutopilotState, _sessionId?: string): string;
/**
 * Generate a summary of the autopilot run
 */
export declare function generateSummary(directory: string, sessionId?: string): AutopilotSummary | null;
/**
 * Generate formatted summary output
 */
export declare function formatSummary(summary: AutopilotSummary): string;
/**
 * Generate a compact summary for HUD display
 */
export declare function formatCompactSummary(state: AutopilotState): string;
/**
 * Generate failure summary
 */
export declare function formatFailureSummary(state: AutopilotState, error?: string): string;
/**
 * List files for detailed summary
 */
export declare function formatFileList(files: string[], title: string, maxFiles?: number): string;
//# sourceMappingURL=validation.d.ts.map
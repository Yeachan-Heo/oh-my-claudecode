/**
 * Verification Module
 *
 * Reusable verification protocol logic extracted from ralph, ultrawork, and autopilot.
 * Provides a single source of truth for verification requirements and execution.
 */
import type { VerificationProtocol, VerificationCheck, VerificationChecklist, VerificationEvidence, VerificationEvidenceType, ValidationResult, VerificationOptions, ReportOptions } from './types.js';
/**
 * Standard verification checks used across workflows
 */
export declare const STANDARD_CHECKS: {
    BUILD: {
        id: string;
        name: string;
        description: string;
        evidenceType: VerificationEvidenceType;
        required: boolean;
        command: undefined;
        completed: boolean;
    };
    TEST: {
        id: string;
        name: string;
        description: string;
        evidenceType: VerificationEvidenceType;
        required: boolean;
        command: undefined;
        completed: boolean;
    };
    LINT: {
        id: string;
        name: string;
        description: string;
        evidenceType: VerificationEvidenceType;
        required: boolean;
        command: undefined;
        completed: boolean;
    };
    FUNCTIONALITY: {
        id: string;
        name: string;
        description: string;
        evidenceType: VerificationEvidenceType;
        required: boolean;
        completed: boolean;
    };
    ARCHITECT: {
        id: string;
        name: string;
        description: string;
        evidenceType: VerificationEvidenceType;
        required: boolean;
        completed: boolean;
    };
    TODO: {
        id: string;
        name: string;
        description: string;
        evidenceType: VerificationEvidenceType;
        required: boolean;
        completed: boolean;
    };
    ERROR_FREE: {
        id: string;
        name: string;
        description: string;
        evidenceType: VerificationEvidenceType;
        required: boolean;
        completed: boolean;
    };
};
/**
 * Create a verification protocol
 */
export declare function createProtocol(name: string, description: string, checks: VerificationCheck[], strictMode?: boolean): VerificationProtocol;
/**
 * Create a verification checklist from a protocol
 */
export declare function createChecklist(protocol: VerificationProtocol): VerificationChecklist;
/**
 * Execute all verification checks
 */
export declare function runVerification(checklist: VerificationChecklist, options?: VerificationOptions): Promise<VerificationChecklist>;
/**
 * Validate evidence for a specific check
 */
export declare function checkEvidence(check: VerificationCheck, evidence: VerificationEvidence): ValidationResult;
/**
 * Format verification report
 */
export declare function formatReport(checklist: VerificationChecklist, options?: ReportOptions): string;
/**
 * Validate entire checklist
 */
export declare function validateChecklist(checklist: VerificationChecklist): Promise<ValidationResult>;
export type { VerificationProtocol, VerificationCheck, VerificationChecklist, VerificationEvidence, VerificationEvidenceType, VerificationSummary, ValidationResult, VerificationOptions, ReportOptions } from './types.js';
//# sourceMappingURL=index.d.ts.map
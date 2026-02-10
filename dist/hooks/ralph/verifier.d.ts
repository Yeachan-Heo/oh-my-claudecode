/**
 * Ralph Verifier
 *
 * Adds architect verification to ralph completion claims.
 * When ralph claims completion, an architect verification phase is triggered.
 *
 * Flow:
 * 1. Ralph claims task is complete
 * 2. System enters verification mode
 * 3. Architect agent is invoked to verify the work
 * 4. If architect approves -> truly complete, use /oh-my-claudecode:cancel to exit
 * 5. If architect finds flaws -> continue ralph with architect feedback
 */
export interface VerificationState {
    /** Whether verification is pending */
    pending: boolean;
    /** The completion claim that triggered verification */
    completion_claim: string;
    /** Number of verification attempts */
    verification_attempts: number;
    /** Max verification attempts before force-accepting */
    max_verification_attempts: number;
    /** Architect feedback from last verification */
    architect_feedback?: string;
    /** Whether architect approved */
    architect_approved?: boolean;
    /** Timestamp of verification request */
    requested_at: string;
    /** Original ralph task */
    original_task: string;
}
/**
 * Read verification state
 * @param sessionId - When provided, reads from session-scoped path only (no legacy fallback)
 */
export declare function readVerificationState(directory: string, sessionId?: string): VerificationState | null;
/**
 * Write verification state
 */
export declare function writeVerificationState(directory: string, state: VerificationState, sessionId?: string): boolean;
/**
 * Clear verification state
 * @param sessionId - When provided, clears session-scoped state only
 */
export declare function clearVerificationState(directory: string, sessionId?: string): boolean;
/**
 * Start verification process
 */
export declare function startVerification(directory: string, completionClaim: string, originalTask: string, sessionId?: string): VerificationState;
/**
 * Record architect feedback
 */
export declare function recordArchitectFeedback(directory: string, approved: boolean, feedback: string, sessionId?: string): VerificationState | null;
/**
 * Generate architect verification prompt
 */
export declare function getArchitectVerificationPrompt(state: VerificationState): string;
/**
 * Generate continuation prompt after architect rejection
 */
export declare function getArchitectRejectionContinuationPrompt(state: VerificationState): string;
/**
 * Check if text contains architect approval
 */
export declare function detectArchitectApproval(text: string): boolean;
/**
 * Check if text contains architect rejection indicators
 */
export declare function detectArchitectRejection(text: string): {
    rejected: boolean;
    feedback: string;
};
//# sourceMappingURL=verifier.d.ts.map